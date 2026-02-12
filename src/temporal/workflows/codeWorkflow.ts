import { patched, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/index.js";
import type { CodeArgs, CodeWorkflowResult } from "../shared.js";
import { extractCodexAnswer } from "../output.js";
import {
  formatFailures,
  selectNextStrategy,
  uniquePreserveOrder,
  type MatrixFailure,
} from "./matrixRuntime.js";
import { shouldPostTeammateUpdate } from "../../memory/userPreferences.js";
import {
  CODE_POLICY,
  REVIEW_POLICY,
  type CodeErrorKind,
  type CodeStrategyFamily,
  type CodeStrategyId,
  type ReviewErrorKind,
  type ReviewStrategyFamily,
  type ReviewStrategyId,
} from "./matrixPolicyConfig.js";

type MetaActivities = Omit<typeof activities, "execCli" | "createWorktree">;
type LongActivities = Pick<typeof activities, "execCli" | "createWorktree">;

const meta = proxyActivities<MetaActivities>({
  startToCloseTimeout: "5 minutes",
  retry: {
    maximumAttempts: 5,
    initialInterval: "2 seconds",
    maximumInterval: "1 minute",
  },
});

const long = proxyActivities<LongActivities>({
  startToCloseTimeout: "72 hours",
  heartbeatTimeout: "60 seconds",
  retry: {
    maximumAttempts: 1,
  },
});

type CodeAttemptFailure = MatrixFailure<CodeStrategyId, CodeStrategyFamily, CodeErrorKind>;

type CodeMatrixLearning = {
  selectedStrategy: CodeStrategyId;
  selectedToolId: string;
  triggerErrorKinds: string[];
  strategyPath: string[];
  attempts: number;
};

type CodeStrategyResult = {
  executed: true;
};

type ReviewAttemptFailure = MatrixFailure<ReviewStrategyId, ReviewStrategyFamily, ReviewErrorKind>;

type ReviewMatrixLearning = {
  selectedStrategy: ReviewStrategyId;
  selectedToolId: string;
  triggerErrorKinds: string[];
  strategyPath: string[];
  attempts: number;
  revisionAttempts: number;
};

const MAX_CODE_ATTEMPTS_TOTAL = CODE_POLICY.maxAttemptsTotal;
const MAX_CODE_ATTEMPTS_PER_FAMILY = CODE_POLICY.maxAttemptsPerFamily;
const CODE_STRATEGIES = CODE_POLICY.strategies;
const CODE_MATRIX = CODE_POLICY.matrix;
const FORCE_FAMILY_SWITCH_ERROR_KINDS = CODE_POLICY.forceFamilySwitchErrorKinds;

const MAX_REVIEW_ATTEMPTS_TOTAL = REVIEW_POLICY.maxAttemptsTotal;
const MAX_REVIEW_ATTEMPTS_PER_FAMILY = REVIEW_POLICY.maxAttemptsPerFamily;
const MAX_REVIEW_REVISIONS_PER_STRATEGY = REVIEW_POLICY.maxRevisionsPerStrategy;
const REVIEW_STRATEGIES = REVIEW_POLICY.strategies;
const REVIEW_MATRIX = REVIEW_POLICY.matrix;
const FORCE_REVIEW_FAMILY_SWITCH_ERROR_KINDS = REVIEW_POLICY.forceFamilySwitchErrorKinds;
const DEFAULT_CODING_PLAYBOOK_ID = "skill.coding.lifecycle";

function resolveCodingPlaybookId(playbookId: string | undefined): string {
  const normalized = (playbookId ?? "").trim();
  return normalized.length > 0 ? normalized : DEFAULT_CODING_PLAYBOOK_ID;
}

function hasP0orP1(reviewText: string): boolean {
  return /\[p0\]|\[p1\]/i.test(reviewText);
}

function extractErrorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err && typeof (err as any).message === "string") {
    return (err as any).message;
  }
  return String(err);
}

function extractTaggedToolId(message: string): { toolId: string | null; cleanMessage: string } {
  const match = message.match(/^\[tool_id:([^\]]+)\]\s*/i);
  if (!match) return { toolId: null, cleanMessage: message };
  return {
    toolId: match[1] ? match[1].trim() : null,
    cleanMessage: message.slice(match[0].length),
  };
}

function classifyCodeError(message: string): CodeErrorKind {
  const lower = message.toLowerCase();

  if (lower.includes("[invalid_output]") || lower.includes("invalid output") || lower.includes("failed to parse")) {
    return "invalid_output";
  }
  if (lower.includes("[no_changes]") || lower.includes("no changes")) {
    return "no_changes";
  }
  if (lower.includes("enoent") || (lower.includes("spawn") && lower.includes("not found"))) {
    return "cli_not_found";
  }
  if (
    lower.includes("token limit") ||
    lower.includes("token limits") ||
    lower.includes("context length") ||
    lower.includes("maximum context")
  ) {
    return "token_limit";
  }
  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("permission denied") ||
    lower.includes("forbidden")
  ) {
    return "auth_or_permission";
  }
  if (
    lower.includes("model not found") ||
    lower.includes("no such model") ||
    lower.includes("model unavailable") ||
    lower.includes("unavailable model")
  ) {
    return "model_unavailable";
  }
  if (lower.includes("rate limit") || lower.includes("429") || lower.includes("overloaded")) {
    return "rate_limited";
  }
  if (lower.includes("timed out") || lower.includes("etimedout") || lower.includes("timeout")) {
    return "timeout";
  }
  if (lower.includes("bad request")) {
    return "provider_bad_request";
  }
  if (lower.includes("command failed")) {
    return "nonzero_exit";
  }
  return "unknown";
}

function classifyReviewError(message: string): ReviewErrorKind {
  const lower = message.toLowerCase();

  if (
    lower.includes("[review_unresolved]") ||
    lower.includes("review unresolved") ||
    lower.includes("still has [p0]/[p1]")
  ) {
    return "p0_p1_unresolved";
  }

  const codeKind = classifyCodeError(message);
  switch (codeKind) {
    case "cli_not_found":
    case "auth_or_permission":
    case "model_unavailable":
    case "token_limit":
    case "rate_limited":
    case "timeout":
    case "provider_bad_request":
    case "nonzero_exit":
    case "invalid_output":
    case "unknown":
      return codeKind;
    case "no_changes":
      return "invalid_output";
  }
}

function formatCodeFailures(attempts: readonly CodeAttemptFailure[]): string {
  return formatFailures(attempts);
}

function selectNextCodeStrategy(opts: {
  attempts: readonly CodeAttemptFailure[];
  currentStrategy: CodeStrategyId;
  lastErrorKind: CodeErrorKind;
}): { nextStrategyId: CodeStrategyId | null; reason: string } {
  const currentFamily = CODE_STRATEGIES[opts.currentStrategy].family;
  return selectNextStrategy({
    attempts: opts.attempts,
    currentStrategy: opts.currentStrategy,
    currentFamily,
    matrixCandidates: CODE_MATRIX[opts.lastErrorKind],
    strategyFamilyFor: (strategyId) => CODE_STRATEGIES[strategyId].family,
    maxAttemptsPerFamily: MAX_CODE_ATTEMPTS_PER_FAMILY,
    forceFamilySwitchErrorKinds: FORCE_FAMILY_SWITCH_ERROR_KINDS,
    lastErrorKind: opts.lastErrorKind,
    fallbackOrder: CODE_POLICY.fallbackOrder,
    fallbackOrderOnFamilySwitch: CODE_POLICY.fallbackOrderOnFamilySwitch,
    allowSingleRetryOnNonzeroExit: CODE_POLICY.nonzeroExitRetry.enabled,
    nonzeroExitErrorKind: CODE_POLICY.nonzeroExitRetry.errorKind,
  });
}

function formatReviewFailures(attempts: readonly ReviewAttemptFailure[]): string {
  return formatFailures(attempts);
}

function selectNextReviewStrategy(opts: {
  attempts: readonly ReviewAttemptFailure[];
  currentStrategy: ReviewStrategyId;
  lastErrorKind: ReviewErrorKind;
}): { nextStrategyId: ReviewStrategyId | null; reason: string } {
  const currentFamily = REVIEW_STRATEGIES[opts.currentStrategy].family;
  return selectNextStrategy({
    attempts: opts.attempts,
    currentStrategy: opts.currentStrategy,
    currentFamily,
    matrixCandidates: REVIEW_MATRIX[opts.lastErrorKind],
    strategyFamilyFor: (strategyId) => REVIEW_STRATEGIES[strategyId].family,
    maxAttemptsPerFamily: MAX_REVIEW_ATTEMPTS_PER_FAMILY,
    forceFamilySwitchErrorKinds: FORCE_REVIEW_FAMILY_SWITCH_ERROR_KINDS,
    lastErrorKind: opts.lastErrorKind,
    fallbackOrder: REVIEW_POLICY.fallbackOrder,
    fallbackOrderOnFamilySwitch: REVIEW_POLICY.fallbackOrderOnFamilySwitch,
    allowSingleRetryOnNonzeroExit: REVIEW_POLICY.nonzeroExitRetry.enabled,
    nonzeroExitErrorKind: REVIEW_POLICY.nonzeroExitRetry.errorKind,
  });
}

async function ensureWorktreeChanged(opts: { worktreePath: string; strategyId: CodeStrategyId }): Promise<void> {
  const status = await long.execCli({
    name: `git-status-${opts.strategyId}`,
    cwd: opts.worktreePath,
    cmd: "bash",
    args: ["-lc", "git status --porcelain"],
  });
  const trimmed = status.tail.trim();
  if (!trimmed) {
    throw new Error(`[no_changes] Strategy ${opts.strategyId} finished without repository changes.`);
  }
}

async function buildCoderPrompt(opts: {
  plan: string;
  strategyId: CodeStrategyId;
  priorFailures: readonly CodeAttemptFailure[];
}): Promise<string> {
  const basePrompt = await meta.renderPromptTemplate({
    templatePath: "docs/coder.md",
    variables: {
      plan: opts.plan,
      workspaceRules: "",
    },
  });

  if (opts.strategyId !== "codex-exec-patch") return basePrompt;

  const failureSummary = opts.priorFailures
    .map((failure, idx) => `${idx + 1}. ${failure.strategyId} -> ${failure.errorKind}: ${failure.errorMessage}`)
    .join("\n");

  return [
    basePrompt,
    "",
    "## Matrix Recovery Context",
    "You are running the patch-hardened recovery strategy after earlier failures.",
    "Mandatory recovery rules:",
    "- Produce concrete file edits in the current worktree.",
    "- Keep scope strict to the supplied plan.",
    "- Resolve prior failure causes before concluding.",
    "- Do not exit without a real git diff.",
    "",
    failureSummary ? `Prior failures:\n${failureSummary}` : "Prior failures: none",
  ].join("\n");
}

type CodeToolAdapterArgs = {
  issueId: string;
  worktreePath: string;
  prompt: string;
  strategyId: CodeStrategyId;
};

type CodeToolAdapter = (opts: CodeToolAdapterArgs) => Promise<void>;

const CODE_TOOL_ADAPTERS: Record<string, CodeToolAdapter> = {
  "tool.code.codex.exec": async (opts) => {
    await long.execCli({
      name: "codex-code",
      cwd: opts.worktreePath,
      cmd: "codex",
      args: ["-a", "never", "-s", "danger-full-access", "exec", "-"],
      stdin: opts.prompt,
    });
  },
  "tool.code.codex.exec.patch": async (opts) => {
    await long.execCli({
      name: "codex-code-recovery",
      cwd: opts.worktreePath,
      cmd: "codex",
      args: ["-a", "never", "-s", "danger-full-access", "exec", "-"],
      stdin: opts.prompt,
    });
  },
  "tool.code.teddy.exec": async (opts) => {
    const outPath = `runs/xena:${opts.issueId}/teddy-code.last.md`;
    await long.execCli({
      name: "teddy-code",
      cwd: opts.worktreePath,
      cmd: "teddy",
      args: ["--quiet", "-o", outPath, opts.prompt],
      lastMessagePath: outPath,
    });
  },
};

async function executeCodeStrategy(opts: {
  strategyId: CodeStrategyId;
  issueId: string;
  worktreePath: string;
  prompt: string;
}): Promise<CodeStrategyResult> {
  const strategy = CODE_STRATEGIES[opts.strategyId];
  const adapter = CODE_TOOL_ADAPTERS[strategy.toolId];
  if (!adapter) {
    throw new Error(`[provider_bad_request][tool_id:${strategy.toolId}] No code adapter registered for tool.`);
  }

  try {
    await adapter({
      issueId: opts.issueId,
      worktreePath: opts.worktreePath,
      prompt: opts.prompt,
      strategyId: opts.strategyId,
    });
  } catch (err) {
    throw new Error(`[tool_id:${strategy.toolId}] ${extractErrorMessage(err)}`);
  }

  await ensureWorktreeChanged({
    worktreePath: opts.worktreePath,
    strategyId: opts.strategyId,
  });

  return { executed: true };
}

function buildTeddyReviewPrompt(opts: { issueIdentifier: string; issueTitle: string }): string {
  return [
    `You are reviewing uncommitted repository changes for ${opts.issueIdentifier}: ${opts.issueTitle}.`,
    "Review only the current git working tree changes.",
    "Output concise markdown findings with severity tags [p0], [p1], [p2].",
    "Only use [p0] and [p1] for blocking issues that must be fixed before merge.",
    "If no blocking issues remain, include the line: Blocking issues: none.",
    "Focus on correctness, regressions, security, and missing tests.",
  ].join("\n");
}

type ReviewToolAdapterArgs = {
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  strategyId: ReviewStrategyId;
  worktreePath: string;
  attempt: number;
};

type ReviewToolAdapter = (opts: ReviewToolAdapterArgs) => Promise<string>;

const REVIEW_TOOL_ADAPTERS: Record<string, ReviewToolAdapter> = {
  "tool.review.codex.review": async (opts) => {
    const reviewLastPath = `runs/xena:${opts.issueId}/${opts.strategyId}-${opts.attempt}.last.md`;
    const review = await long.execCli({
      name: `codex-review-${opts.strategyId}-${opts.attempt}`,
      cwd: opts.worktreePath,
      cmd: "codex",
      args: ["-a", "never", "-s", "danger-full-access", "exec", "-o", reviewLastPath, "review", "--uncommitted"],
      lastMessagePath: reviewLastPath,
    });
    const reviewText = extractCodexAnswer(review.lastMessage ?? review.tail).trim();
    if (!reviewText) {
      throw new Error(`[invalid_output] Review strategy ${opts.strategyId} returned empty output.`);
    }
    return reviewText;
  },
  "tool.review.teddy.review": async (opts) => {
    const prompt = buildTeddyReviewPrompt({
      issueIdentifier: opts.issueIdentifier,
      issueTitle: opts.issueTitle,
    });
    const outPath = `runs/xena:${opts.issueId}/teddy-review-${opts.attempt}.last.md`;
    const review = await long.execCli({
      name: `teddy-review-${opts.attempt}`,
      cwd: opts.worktreePath,
      cmd: "teddy",
      args: ["--quiet", "-o", outPath, prompt],
      lastMessagePath: outPath,
    });
    const reviewText = extractCodexAnswer(review.lastMessage ?? review.tail).trim();
    if (!reviewText) {
      throw new Error(`[invalid_output] Review strategy ${opts.strategyId} returned empty output.`);
    }
    return reviewText;
  },
};

async function executeReviewStrategy(opts: {
  strategyId: ReviewStrategyId;
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  worktreePath: string;
  attempt: number;
}): Promise<string> {
  const strategy = REVIEW_STRATEGIES[opts.strategyId];
  const adapter = REVIEW_TOOL_ADAPTERS[strategy.reviewToolId];
  if (!adapter) {
    throw new Error(`[provider_bad_request][tool_id:${strategy.reviewToolId}] No review adapter registered for tool.`);
  }

  try {
    return await adapter({
      issueId: opts.issueId,
      issueIdentifier: opts.issueIdentifier,
      issueTitle: opts.issueTitle,
      strategyId: opts.strategyId,
      worktreePath: opts.worktreePath,
      attempt: opts.attempt,
    });
  } catch (err) {
    throw new Error(`[tool_id:${strategy.reviewToolId}] ${extractErrorMessage(err)}`);
  }
}

type RevisionToolAdapterArgs = {
  issueId: string;
  strategyId: ReviewStrategyId;
  worktreePath: string;
  strategyPrompt: string;
  revisionAttempt: number;
  strategyRevisionAttempt: number;
};

type RevisionToolAdapter = (opts: RevisionToolAdapterArgs) => Promise<void>;

const REVISION_TOOL_ADAPTERS: Record<string, RevisionToolAdapter> = {
  "tool.review.codex.revision": async (opts) => {
    await long.execCli({
      name: `codex-revision-${opts.strategyId}-${opts.revisionAttempt}-${opts.strategyRevisionAttempt}`,
      cwd: opts.worktreePath,
      cmd: "codex",
      args: ["-a", "never", "-s", "danger-full-access", "exec", "-"],
      stdin: opts.strategyPrompt,
    });
  },
  "tool.review.codex.revision.focused": async (opts) => {
    await long.execCli({
      name: `codex-revision-focused-${opts.strategyId}-${opts.revisionAttempt}-${opts.strategyRevisionAttempt}`,
      cwd: opts.worktreePath,
      cmd: "codex",
      args: ["-a", "never", "-s", "danger-full-access", "exec", "-"],
      stdin: opts.strategyPrompt,
    });
  },
  "tool.review.teddy.revision": async (opts) => {
    const outPath = `runs/xena:${opts.issueId}/teddy-revision-${opts.revisionAttempt}.last.md`;
    await long.execCli({
      name: `teddy-revision-${opts.revisionAttempt}`,
      cwd: opts.worktreePath,
      cmd: "teddy",
      args: ["--quiet", "-o", outPath, opts.strategyPrompt],
      lastMessagePath: outPath,
    });
  },
};

async function executeRevisionStrategy(opts: {
  strategyId: ReviewStrategyId;
  issueId: string;
  worktreePath: string;
  revisionPrompt: string;
  revisionAttempt: number;
  strategyRevisionAttempt: number;
}): Promise<void> {
  const focusedTail =
    opts.strategyId === "codex-review-loop-focused"
      ? [
          "",
          "Focused recovery mode:",
          "- Address only [p0]/[p1] findings from the review.",
          "- Make minimal edits needed to clear blockers.",
          "- Keep implementation scope unchanged.",
        ].join("\n")
      : "";
  const strategyPrompt = `${opts.revisionPrompt}${focusedTail}`;
  const strategy = REVIEW_STRATEGIES[opts.strategyId];
  const adapter = REVISION_TOOL_ADAPTERS[strategy.revisionToolId];
  if (!adapter) {
    throw new Error(
      `[provider_bad_request][tool_id:${strategy.revisionToolId}] No revision adapter registered for tool.`,
    );
  }

  try {
    await adapter({
      issueId: opts.issueId,
      strategyId: opts.strategyId,
      worktreePath: opts.worktreePath,
      strategyPrompt,
      revisionAttempt: opts.revisionAttempt,
      strategyRevisionAttempt: opts.strategyRevisionAttempt,
    });
  } catch (err) {
    throw new Error(`[tool_id:${strategy.revisionToolId}] ${extractErrorMessage(err)}`);
  }
}

export async function codeWorkflow(args: CodeArgs): Promise<CodeWorkflowResult> {
  try {
    const issue = await meta.linearGetIssue({ issueId: args.issueId });
    const ownerTag = await meta.getOwnerTag();
    const memory = await meta.mem0Search({
      projectKey: args.project.projectKey,
      issueIdentifier: issue.identifier,
      query: `${issue.identifier}: ${issue.title}`,
      appId: "xena",
      agentId: "workflow.code",
      runId: args.issueId,
    });
    const userPreferences = await meta.mem0GetUserPreferences({
      projectKey: args.project.projectKey,
    });
    const selectedPlaybookId = resolveCodingPlaybookId(args.playbookId);

    const postTeammate = async (opts: { intent: string; draft: string; facts?: string }) => {
      if (!shouldPostTeammateUpdate(userPreferences, opts.intent)) return;

      const freshMemory = await meta.mem0Search({
        projectKey: args.project.projectKey,
        issueIdentifier: issue.identifier,
        query: `${issue.identifier}: ${issue.title}\nIntent: ${opts.intent}`,
        appId: "xena",
        agentId: "workflow.code",
        runId: args.issueId,
      });
      const recent = await meta.linearListRecentComments({ issueId: args.issueId, first: 20 });
      const recentSummary = recent
        .slice(-8)
        .map((c, idx) => `${idx + 1}. ${c.body.replace(/\s+/g, " ").slice(0, 240)}`)
        .join("\n");
      const body = await meta.openaiComposeTeammateReply({
        issueIdentifier: issue.identifier,
        issueTitle: issue.title,
        issueDescription: issue.description,
        memory: freshMemory,
        recentComments: recentSummary,
        taskContext: `stage=coding`,
        intent: opts.intent,
        draft: opts.draft,
        facts: opts.facts,
        preferences: userPreferences,
      });
      await meta.linearPostComment({ issueId: args.issueId, body });
    };

    await postTeammate({
      intent: "code_start",
      draft: "Starting implementation.",
    });

    const plan = await meta.linearFindLatestPlan({ issueId: args.issueId });
    if (!plan) {
      await postTeammate({
        intent: "code_missing_plan",
        draft: "No plan found in ticket comments. Run plan first.",
      });
      return {
        ok: false,
        issueIdentifier: issue.identifier,
        reason: "No plan found in ticket comments.",
      };
    }

    const wt = await long.createWorktree({
      repoPath: args.project.repoPath,
      worktreesRoot: args.project.worktreesRoot,
      issueIdentifier: issue.identifier,
    });

    await postTeammate({
      intent: "worktree_ready",
      draft: `Worktree ready.`,
      facts: JSON.stringify(
        {
          worktreePath: wt.worktreePath,
          branchName: wt.branchName,
        },
        null,
        2,
      ),
    });

    await long.execCli({
      name: "clone-env",
      cwd: wt.worktreePath,
      cmd: "bash",
      args: [args.project.cloneEnvScriptPath],
    });

    let matrixLearning: CodeMatrixLearning | null = null;

    if (!patched("code-strategy-matrix-v1")) {
      const coderPrompt = await buildCoderPrompt({
        plan,
        strategyId: "codex-exec",
        priorFailures: [],
      });

      await executeCodeStrategy({
        strategyId: "codex-exec",
        issueId: args.issueId,
        worktreePath: wt.worktreePath,
        prompt: coderPrompt,
      });
    } else {
      const failures: CodeAttemptFailure[] = [];
      const strategyPath: CodeStrategyId[] = [];
      let currentStrategy: CodeStrategyId = "codex-exec";
      let executed = false;

      while (!executed) {
        strategyPath.push(currentStrategy);
        const strategy = CODE_STRATEGIES[currentStrategy];

        try {
          const coderPrompt = await buildCoderPrompt({
            plan,
            strategyId: currentStrategy,
            priorFailures: failures,
          });

          await executeCodeStrategy({
            strategyId: currentStrategy,
            issueId: args.issueId,
            worktreePath: wt.worktreePath,
            prompt: coderPrompt,
          });

          executed = true;
          if (failures.length > 0) {
            matrixLearning = {
              selectedStrategy: currentStrategy,
              selectedToolId: strategy.toolId,
              triggerErrorKinds: uniquePreserveOrder(failures.map((f) => f.errorKind)),
              strategyPath: strategyPath.map((step) => step),
              attempts: strategyPath.length,
            };
          }
        } catch (err) {
          const errorMessage = extractErrorMessage(err);
          const errorKind = classifyCodeError(errorMessage);

          failures.push({
            strategyId: currentStrategy,
            family: strategy.family,
            toolId: strategy.toolId,
            errorKind,
            errorMessage,
          });

          await postTeammate({
            intent: "code_strategy_error",
            draft: `Code strategy ${strategy.name} failed.`,
            facts: [
              `strategy: ${currentStrategy}`,
              `tool_id: ${strategy.toolId}`,
              `family: ${strategy.family}`,
              `error_kind: ${errorKind}`,
              `error: ${errorMessage}`,
            ].join("\n"),
          });

          if (failures.length >= MAX_CODE_ATTEMPTS_TOTAL) {
            throw new Error(`Code implementation failed after ${failures.length} attempts.\n\n${formatCodeFailures(failures)}`);
          }

          const next = selectNextCodeStrategy({
            attempts: failures,
            currentStrategy,
            lastErrorKind: errorKind,
          });

          if (!next.nextStrategyId) {
            throw new Error(`Code implementation failed: no strategy remaining.\n\n${formatCodeFailures(failures)}`);
          }

          await postTeammate({
            intent: "code_strategy_switch",
            draft: `Switching code strategy to ${CODE_STRATEGIES[next.nextStrategyId].name}.`,
            facts: [
              next.reason,
              `from: ${currentStrategy}`,
              `to: ${next.nextStrategyId}`,
              `error_kind: ${errorKind}`,
              `strategy_path: ${[...strategyPath, next.nextStrategyId].join(" -> ")}`,
              `attempt: ${failures.length + 1}/${MAX_CODE_ATTEMPTS_TOTAL}`,
            ].join("\n"),
          });

          currentStrategy = next.nextStrategyId;
        }
      }
    }

    let reviewText = "";
    let reviewAttempts = 0;
    let reviewMatrixLearning: ReviewMatrixLearning | null = null;
    let reviewBlockedReason: string | null = null;

    if (!patched("review-strategy-matrix-v1")) {
      const reviewLastPath = `runs/xena:${args.issueId}/codex-review.last.md`;
      let review = await long.execCli({
        name: "codex-review",
        cwd: wt.worktreePath,
        cmd: "codex",
        args: ["-a", "never", "-s", "danger-full-access", "exec", "-o", reviewLastPath, "review", "--uncommitted"],
        lastMessagePath: reviewLastPath,
      });
      reviewText = extractCodexAnswer(review.lastMessage ?? review.tail);

      while (hasP0orP1(reviewText) && reviewAttempts < 3) {
        reviewAttempts += 1;
        const revisionPrompt = await meta.renderPromptTemplate({
          templatePath: "docs/revision.md",
          variables: {
            originalTask: `${issue.identifier} ${issue.title}`,
            pathToFile: "",
            review: reviewText,
          },
        });

        await long.execCli({
          name: `codex-revision-${reviewAttempts}`,
          cwd: wt.worktreePath,
          cmd: "codex",
          args: ["-a", "never", "-s", "danger-full-access", "exec", "-"],
          stdin: revisionPrompt,
        });

        review = await long.execCli({
          name: "codex-review",
          cwd: wt.worktreePath,
          cmd: "codex",
          args: ["-a", "never", "-s", "danger-full-access", "exec", "-o", reviewLastPath, "review", "--uncommitted"],
          lastMessagePath: reviewLastPath,
        });
        reviewText = extractCodexAnswer(review.lastMessage ?? review.tail);
      }
    } else {
      const failures: ReviewAttemptFailure[] = [];
      const strategyPath: ReviewStrategyId[] = [];
      let currentStrategy: ReviewStrategyId = "codex-review-loop";
      let reviewResolved = false;
      let nextReviewAttempt = 1;

      while (!reviewResolved && !reviewBlockedReason) {
        strategyPath.push(currentStrategy);
        const strategy = REVIEW_STRATEGIES[currentStrategy];

        try {
          let latestReviewText = await executeReviewStrategy({
            strategyId: currentStrategy,
            issueId: args.issueId,
            issueIdentifier: issue.identifier,
            issueTitle: issue.title,
            worktreePath: wt.worktreePath,
            attempt: nextReviewAttempt,
          });
          nextReviewAttempt += 1;

          let strategyRevisionAttempts = 0;
          while (hasP0orP1(latestReviewText)) {
            if (strategyRevisionAttempts >= MAX_REVIEW_REVISIONS_PER_STRATEGY) {
              throw new Error(
                `[review_unresolved] Strategy ${currentStrategy} still has [p0]/[p1] after ${strategyRevisionAttempts} revision attempt${strategyRevisionAttempts === 1 ? "" : "s"}.`,
              );
            }

            strategyRevisionAttempts += 1;
            reviewAttempts += 1;

            const revisionPrompt = await meta.renderPromptTemplate({
              templatePath: "docs/revision.md",
              variables: {
                originalTask: `${issue.identifier} ${issue.title}`,
                pathToFile: "",
                review: latestReviewText,
              },
            });

            await executeRevisionStrategy({
              strategyId: currentStrategy,
              issueId: args.issueId,
              worktreePath: wt.worktreePath,
              revisionPrompt,
              revisionAttempt: reviewAttempts,
              strategyRevisionAttempt: strategyRevisionAttempts,
            });

            latestReviewText = await executeReviewStrategy({
              strategyId: currentStrategy,
              issueId: args.issueId,
              issueIdentifier: issue.identifier,
              issueTitle: issue.title,
              worktreePath: wt.worktreePath,
              attempt: nextReviewAttempt,
            });
            nextReviewAttempt += 1;
          }

          reviewText = latestReviewText;
          reviewResolved = true;
          if (failures.length > 0) {
            reviewMatrixLearning = {
              selectedStrategy: currentStrategy,
              selectedToolId: strategy.reviewToolId,
              triggerErrorKinds: uniquePreserveOrder(failures.map((f) => f.errorKind)),
              strategyPath: strategyPath.map((step) => step),
              attempts: strategyPath.length,
              revisionAttempts: reviewAttempts,
            };
          }
        } catch (err) {
          const rawErrorMessage = extractErrorMessage(err);
          const tagged = extractTaggedToolId(rawErrorMessage);
          const errorMessage = tagged.cleanMessage;
          const errorKind = classifyReviewError(errorMessage);
          const failureToolId = tagged.toolId ?? strategy.reviewToolId;

          failures.push({
            strategyId: currentStrategy,
            family: strategy.family,
            toolId: failureToolId,
            errorKind,
            errorMessage,
          });

          await postTeammate({
            intent: "review_strategy_error",
            draft: `Review strategy ${strategy.name} failed.`,
            facts: [
              `strategy: ${currentStrategy}`,
              `tool_id: ${failureToolId}`,
              `family: ${strategy.family}`,
              `error_kind: ${errorKind}`,
              `error: ${errorMessage}`,
            ].join("\n"),
          });

          if (failures.length >= MAX_REVIEW_ATTEMPTS_TOTAL) {
            reviewBlockedReason = `Review strategy matrix exhausted after ${failures.length} failed attempt${failures.length === 1 ? "" : "s"}.\n\n${formatReviewFailures(failures)}`;
            break;
          }

          const next = selectNextReviewStrategy({
            attempts: failures,
            currentStrategy,
            lastErrorKind: errorKind,
          });

          if (!next.nextStrategyId) {
            reviewBlockedReason = `Review strategy matrix exhausted: no strategy remaining.\n\n${formatReviewFailures(failures)}`;
            break;
          }

          await postTeammate({
            intent: "review_strategy_switch",
            draft: `Switching review strategy to ${REVIEW_STRATEGIES[next.nextStrategyId].name}.`,
            facts: [
              next.reason,
              `from: ${currentStrategy}`,
              `to: ${next.nextStrategyId}`,
              `error_kind: ${errorKind}`,
              `strategy_path: ${[...strategyPath, next.nextStrategyId].join(" -> ")}`,
              `attempt: ${failures.length + 1}/${MAX_REVIEW_ATTEMPTS_TOTAL}`,
            ].join("\n"),
          });

          currentStrategy = next.nextStrategyId;
        }
      }

      if (!reviewText && reviewBlockedReason === null) {
        reviewBlockedReason = "Review strategy matrix finished without a review result.";
      }
    }

    await meta.linearPostLongComment({
      issueId: args.issueId,
      header: `Review`,
      body: reviewText.trim() ? reviewText : "_No review output captured._",
    });

    if (reviewBlockedReason || hasP0orP1(reviewText)) {
      const blockedSummary =
        reviewBlockedReason ??
        `The code review still contains [p0]/[p1] items after ${reviewAttempts} revision attempt${reviewAttempts === 1 ? "" : "s"}.`;

      await meta.linearPostLongComment({
        issueId: args.issueId,
        header: `Review blocked`,
        body:
          `${blockedSummary}\n\n` +
          `Next step: a human should review and decide how to proceed.\n\n` +
          `${ownerTag}`,
      });

      await meta.mem0Add({
        projectKey: args.project.projectKey,
        issueIdentifier: issue.identifier,
        content: `[review][blocked]\nplaybook_id: ${selectedPlaybookId}\n${blockedSummary}\n\n${reviewText.trim() ? reviewText : "(no review output captured)"}`,
        type: "quality_signal",
        intent: "review_blocked",
        stage: "coding",
        outcome: "blocked",
        source: "workflow.code",
        runId: args.issueId,
        agentId: "workflow.code",
        appId: "xena",
        playbookId: selectedPlaybookId,
        tags: ["review", "blocked", "quality"],
      });

      await postTeammate({
        intent: "review_blocked",
        draft: `Blocked on review.`,
        facts: JSON.stringify(
          {
            worktreePath: wt.worktreePath,
            branchName: wt.branchName,
            reviewLoops: reviewAttempts,
            reason: blockedSummary,
          },
          null,
          2,
        ),
      });

      return {
        ok: false,
        issueIdentifier: issue.identifier,
        reason: reviewBlockedReason ?? "Review still has [p0]/[p1] after revision loop.",
        review: reviewText,
        reviewAttempts,
        worktreePath: wt.worktreePath,
        branchName: wt.branchName,
      };
    }

    await meta.mem0Add({
      projectKey: args.project.projectKey,
      issueIdentifier: issue.identifier,
      content: `[code]\nplaybook_id: ${selectedPlaybookId}\nWorktree: ${wt.worktreePath}\nBranch: ${wt.branchName}\n\n[review]\n${reviewText}`,
      type: "workflow_artifact",
      intent: "implementation_done",
      stage: "coding",
      outcome: "success",
      source: "workflow.code",
      runId: args.issueId,
      agentId: "workflow.code",
      appId: "xena",
      playbookId: selectedPlaybookId,
      tags: ["code", "review", "artifact"],
    });

    if (matrixLearning) {
      await postTeammate({
        intent: "code_strategy_recovered",
        draft: `Implementation recovered with strategy matrix (${matrixLearning.selectedStrategy}).`,
        facts: [
          `selected_strategy: ${matrixLearning.selectedStrategy}`,
          `selected_tool_id: ${matrixLearning.selectedToolId}`,
          `selected_skill_id: ${selectedPlaybookId}`,
          `trigger_error_kinds: ${matrixLearning.triggerErrorKinds.join(", ")}`,
          `strategy_path: ${matrixLearning.strategyPath.join(" -> ")}`,
          `attempts: ${matrixLearning.attempts}`,
        ].join("\n"),
      });
    }

    if (matrixLearning && patched("code-strategy-matrix-learning-v1")) {
      try {
        const learned = await meta.registryUpsertLearnedCodingPattern({
          issueIdentifier: issue.identifier,
          selectedStrategy: matrixLearning.selectedStrategy,
          selectedToolId: matrixLearning.selectedToolId,
          triggerErrorKinds: matrixLearning.triggerErrorKinds,
          strategyPath: matrixLearning.strategyPath,
          attempts: matrixLearning.attempts,
        });

        await meta.mem0Add({
          projectKey: args.project.projectKey,
          issueIdentifier: issue.identifier,
          namespace: "quality.signals",
          content: [
            "[strategy_matrix]",
            "domain: coding",
            `selected_strategy: ${matrixLearning.selectedStrategy}`,
            `selected_tool_id: ${matrixLearning.selectedToolId}`,
            `selected_skill_id: ${selectedPlaybookId}`,
            `trigger_error_kinds: ${matrixLearning.triggerErrorKinds.join(", ")}`,
            `strategy_path: ${matrixLearning.strategyPath.join(" -> ")}`,
            `attempts: ${matrixLearning.attempts}`,
            `registry_file: ${learned.path}`,
          ].join("\n"),
          type: "quality_signal",
          intent: "code_matrix_learning",
          stage: "coding",
          outcome: "success",
          source: "workflow.code",
          runId: args.issueId,
          agentId: "workflow.code",
          appId: "xena",
          playbookId: selectedPlaybookId,
          tags: ["code", "matrix", "quality"],
        });

        await meta.mem0Add({
          projectKey: args.project.projectKey,
          issueIdentifier: issue.identifier,
          namespace: "code.decisions",
          content: [
            "[adaptive_decision]",
            "domain: coding",
            "selector: matrix",
            `selected_skill_id: ${selectedPlaybookId}`,
            `selected_strategy: ${matrixLearning.selectedStrategy}`,
            `strategy_path: ${matrixLearning.strategyPath.join(" -> ")}`,
            `trigger_error_kinds: ${matrixLearning.triggerErrorKinds.join(", ")}`,
            `attempts: ${matrixLearning.attempts}`,
          ].join("\n"),
          type: "decision",
          intent: "code_matrix_decision",
          stage: "coding",
          outcome: "success",
          source: "workflow.code",
          runId: args.issueId,
          agentId: "workflow.code",
          appId: "xena",
          playbookId: selectedPlaybookId,
          tags: ["code", "matrix", "decision"],
        });
      } catch (err) {
        await postTeammate({
          intent: "code_matrix_learning_failed",
          draft: "Code succeeded, but matrix learning persistence failed.",
          facts: extractErrorMessage(err),
        });
      }
    }

    if (reviewMatrixLearning) {
      await postTeammate({
        intent: "review_strategy_recovered",
        draft: `Review recovered with strategy matrix (${reviewMatrixLearning.selectedStrategy}).`,
        facts: [
          `selected_strategy: ${reviewMatrixLearning.selectedStrategy}`,
          `selected_tool_id: ${reviewMatrixLearning.selectedToolId}`,
          `trigger_error_kinds: ${reviewMatrixLearning.triggerErrorKinds.join(", ")}`,
          `strategy_path: ${reviewMatrixLearning.strategyPath.join(" -> ")}`,
          `attempts: ${reviewMatrixLearning.attempts}`,
          `revision_attempts: ${reviewMatrixLearning.revisionAttempts}`,
        ].join("\n"),
      });
    }

    if (reviewMatrixLearning && patched("review-strategy-matrix-learning-v1")) {
      try {
        const learned = await meta.registryUpsertLearnedReviewPattern({
          issueIdentifier: issue.identifier,
          selectedStrategy: reviewMatrixLearning.selectedStrategy,
          selectedToolId: reviewMatrixLearning.selectedToolId,
          triggerErrorKinds: reviewMatrixLearning.triggerErrorKinds,
          strategyPath: reviewMatrixLearning.strategyPath,
          attempts: reviewMatrixLearning.attempts,
          revisionAttempts: reviewMatrixLearning.revisionAttempts,
        });

        await meta.mem0Add({
          projectKey: args.project.projectKey,
          issueIdentifier: issue.identifier,
          namespace: "quality.signals",
          content: [
            "[strategy_matrix]",
            "domain: review",
            `selected_strategy: ${reviewMatrixLearning.selectedStrategy}`,
            `selected_tool_id: ${reviewMatrixLearning.selectedToolId}`,
            `selected_skill_id: ${selectedPlaybookId}`,
            `trigger_error_kinds: ${reviewMatrixLearning.triggerErrorKinds.join(", ")}`,
            `strategy_path: ${reviewMatrixLearning.strategyPath.join(" -> ")}`,
            `attempts: ${reviewMatrixLearning.attempts}`,
            `revision_attempts: ${reviewMatrixLearning.revisionAttempts}`,
            `registry_file: ${learned.path}`,
          ].join("\n"),
          type: "quality_signal",
          intent: "review_matrix_learning",
          stage: "coding",
          outcome: "success",
          source: "workflow.code",
          runId: args.issueId,
          agentId: "workflow.code",
          appId: "xena",
          playbookId: selectedPlaybookId,
          tags: ["review", "matrix", "quality"],
        });

        await meta.mem0Add({
          projectKey: args.project.projectKey,
          issueIdentifier: issue.identifier,
          namespace: "code.decisions",
          content: [
            "[adaptive_decision]",
            "domain: review",
            "selector: matrix",
            `selected_skill_id: ${selectedPlaybookId}`,
            `selected_strategy: ${reviewMatrixLearning.selectedStrategy}`,
            `strategy_path: ${reviewMatrixLearning.strategyPath.join(" -> ")}`,
            `trigger_error_kinds: ${reviewMatrixLearning.triggerErrorKinds.join(", ")}`,
            `attempts: ${reviewMatrixLearning.attempts}`,
            `revision_attempts: ${reviewMatrixLearning.revisionAttempts}`,
          ].join("\n"),
          type: "decision",
          intent: "review_matrix_decision",
          stage: "coding",
          outcome: "success",
          source: "workflow.code",
          runId: args.issueId,
          agentId: "workflow.code",
          appId: "xena",
          playbookId: selectedPlaybookId,
          tags: ["review", "matrix", "decision"],
        });
      } catch (err) {
        await postTeammate({
          intent: "review_matrix_learning_failed",
          draft: "Review succeeded, but matrix learning persistence failed.",
          facts: extractErrorMessage(err),
        });
      }
    }

    await postTeammate({
      intent: "implementation_done",
      draft: `Implementation done.`,
      facts: JSON.stringify(
        {
          worktreePath: wt.worktreePath,
          branchName: wt.branchName,
          reviewLoops: reviewAttempts,
        },
        null,
        2,
      ),
    });

    return {
      ok: true,
      issueIdentifier: issue.identifier,
      worktreePath: wt.worktreePath,
      branchName: wt.branchName,
      review: reviewText,
      reviewAttempts,
    };
  } catch (err: any) {
    const msg = typeof err?.message === "string" ? err.message : String(err);
    await meta.linearPostLongComment({
      issueId: args.issueId,
      header: `Implementation blocked`,
      body: msg,
    });
    throw err;
  }
}
