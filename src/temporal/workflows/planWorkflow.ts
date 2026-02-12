import { patched, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/index.js";
import type { PlanArgs } from "../shared.js";
import { extractCodexAnswer } from "../output.js";
import { formatFailures, selectNextStrategy, uniquePreserveOrder, type MatrixFailure } from "./matrixRuntime.js";
import { shouldPostTeammateUpdate } from "../../memory/userPreferences.js";
import {
  PLAN_POLICY,
  type PlanErrorKind,
  type PlanStrategyFamily,
  type PlanStrategyId,
} from "./matrixPolicyConfig.js";

type MetaActivities = Omit<typeof activities, "execCli">;
type ExecActivities = Pick<typeof activities, "execCli">;

const meta = proxyActivities<MetaActivities>({
  startToCloseTimeout: "5 minutes",
  retry: {
    maximumAttempts: 5,
    initialInterval: "2 seconds",
    maximumInterval: "1 minute",
  },
});

const exec = proxyActivities<ExecActivities>({
  startToCloseTimeout: "24 hours",
  heartbeatTimeout: "60 seconds",
  retry: {
    maximumAttempts: 1,
  },
});

type PlanAttemptFailure = MatrixFailure<PlanStrategyId, PlanStrategyFamily, PlanErrorKind>;

type PlanMatrixLearning = {
  selectedStrategy: PlanStrategyId;
  selectedToolId: string;
  triggerErrorKinds: string[];
  strategyPath: string[];
  attempts: number;
  recursionDepth: number;
  branchCount: number;
  qualityScore: number;
};

type RecursiveSubproblem = {
  id: string;
  title: string;
  scope: string;
  deliverables: string[];
};

type RecursiveDecomposition = {
  objective: string;
  subproblems: RecursiveSubproblem[];
};

type StrategyResult = {
  markdown: string;
  recursionDepth: number;
  branchCount: number;
};

const MAX_PLAN_ATTEMPTS_TOTAL = PLAN_POLICY.maxAttemptsTotal;
const MAX_PLAN_ATTEMPTS_PER_FAMILY = PLAN_POLICY.maxAttemptsPerFamily;
const MAX_RECURSION_DEPTH = PLAN_POLICY.maxRecursionDepth;
const MAX_RECURSIVE_BRANCHES = PLAN_POLICY.maxRecursiveBranches;
const PLAN_QUALITY_PASS_THRESHOLD = PLAN_POLICY.qualityPassThreshold;
const DEFAULT_CODING_PLAYBOOK_ID = "skill.coding.lifecycle";

function resolveCodingPlaybookId(playbookId: string | undefined): string {
  const normalized = (playbookId ?? "").trim();
  return normalized.length > 0 ? normalized : DEFAULT_CODING_PLAYBOOK_ID;
}

const PLAN_STRATEGIES = PLAN_POLICY.strategies;
const PLAN_MATRIX = PLAN_POLICY.matrix;
const FORCE_FAMILY_SWITCH_ERROR_KINDS = PLAN_POLICY.forceFamilySwitchErrorKinds;

const REQUIRED_PLAN_SECTION_HEADERS: readonly string[] = [
  "# Task:",
  "## Goal",
  "## Context",
  "## Requirements",
  "## Non-requirements / Out of Scope",
  "## Production & Quality Constraints",
  "## Integration Points",
  "## Tests",
  "## Edge Cases & Risks",
  "## Open Questions / Ambiguities",
];

function extractErrorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err && typeof (err as any).message === "string") {
    return (err as any).message;
  }
  return String(err);
}

function classifyPlanError(message: string): PlanErrorKind {
  const lower = message.toLowerCase();

  if (lower.includes("[invalid_output]") || lower.includes("invalid output") || lower.includes("failed to parse")) {
    return "invalid_output";
  }
  if (lower.includes("[quality_low]")) {
    return "quality_low";
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

function formatPlanFailures(attempts: readonly PlanAttemptFailure[]): string {
  return formatFailures(attempts);
}

function selectNextPlanStrategy(opts: {
  attempts: readonly PlanAttemptFailure[];
  currentStrategy: PlanStrategyId;
  lastErrorKind: PlanErrorKind;
}): { nextStrategyId: PlanStrategyId | null; reason: string } {
  const currentFamily = PLAN_STRATEGIES[opts.currentStrategy].family;
  return selectNextStrategy({
    attempts: opts.attempts,
    currentStrategy: opts.currentStrategy,
    currentFamily,
    matrixCandidates: PLAN_MATRIX[opts.lastErrorKind],
    strategyFamilyFor: (strategyId) => PLAN_STRATEGIES[strategyId].family,
    maxAttemptsPerFamily: MAX_PLAN_ATTEMPTS_PER_FAMILY,
    forceFamilySwitchErrorKinds: FORCE_FAMILY_SWITCH_ERROR_KINDS,
    lastErrorKind: opts.lastErrorKind,
    fallbackOrder: PLAN_POLICY.fallbackOrder,
    fallbackOrderOnFamilySwitch: PLAN_POLICY.fallbackOrderOnFamilySwitch,
    allowSingleRetryOnNonzeroExit: PLAN_POLICY.nonzeroExitRetry.enabled,
    nonzeroExitErrorKind: PLAN_POLICY.nonzeroExitRetry.errorKind,
  });
}

function countBullets(sectionBody: string): number {
  const matches = sectionBody.match(/^\s*[-*]\s+/gm);
  return matches ? matches.length : 0;
}

function extractSection(markdown: string, sectionHeader: string): string {
  const escaped = sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(^##\\s+${escaped}\\s*$)([\\s\\S]*?)(?=^##\\s+|\\Z)`, "im");
  const match = markdown.match(regex);
  return match?.[2] ?? "";
}

function countBacktickedFilePathRefs(markdown: string): number {
  const refs = markdown.match(/`[^`\n]*\/[^`\n]*`/g) ?? [];
  return uniquePreserveOrder(refs).length;
}

function hasPlaceholderTokens(markdown: string): boolean {
  const critical = [
    extractSection(markdown, "Goal"),
    extractSection(markdown, "Requirements"),
    extractSection(markdown, "Tests"),
    extractSection(markdown, "Edge Cases & Risks"),
  ].join("\n");
  return /\b(?:TBD|TODO|example)\b/i.test(critical);
}

function scorePlanQuality(markdown: string): number {
  let score = 0;
  for (const header of REQUIRED_PLAN_SECTION_HEADERS) {
    if (markdown.includes(header)) score += 5;
  }

  if (countBullets(extractSection(markdown, "Requirements")) >= 4) score += 10;
  if (countBullets(extractSection(markdown, "Tests")) >= 3) score += 10;
  if (countBullets(extractSection(markdown, "Edge Cases & Risks")) >= 2) score += 10;
  if (countBacktickedFilePathRefs(markdown) >= 2) score += 10;
  if (!hasPlaceholderTokens(markdown)) score += 10;

  return score;
}

function buildTaskDescription(opts: {
  issueIdentifier: string;
  issueTitle: string;
  issueDescription: string | null;
  memory: string;
  decisionSignatures: string;
}): string {
  return [
    `Linear issue ${opts.issueIdentifier}`,
    `Title: ${opts.issueTitle}`,
    `Description:\n${opts.issueDescription ?? ""}`,
    `Memory (mem0):\n${opts.memory}`,
    `Decision signatures (mem0):\n${opts.decisionSignatures || "(none captured yet)"}`,
  ].join("\n\n");
}

function extractJsonPayload(text: string): unknown {
  const raw = text.trim();

  const tryParse = (candidate: string): unknown | null => {
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  };

  const direct = tryParse(raw);
  if (direct !== null) return direct;

  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const parsed = tryParse(fence[1].trim());
    if (parsed !== null) return parsed;
  }

  const firstCurly = raw.indexOf("{");
  const lastCurly = raw.lastIndexOf("}");
  if (firstCurly >= 0 && lastCurly > firstCurly) {
    const parsed = tryParse(raw.slice(firstCurly, lastCurly + 1));
    if (parsed !== null) return parsed;
  }

  throw new Error("[invalid_output] Failed to parse recursive decomposition JSON.");
}

function normalizeSubproblems(value: unknown): RecursiveSubproblem[] {
  if (!Array.isArray(value)) {
    throw new Error("[invalid_output] Recursive decomposition missing subproblems array.");
  }

  const normalized: RecursiveSubproblem[] = [];
  for (let i = 0; i < value.length && normalized.length < MAX_RECURSIVE_BRANCHES; i += 1) {
    const item = value[i];
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;

    const title = typeof row.title === "string" && row.title.trim() ? row.title.trim() : `Subproblem ${i + 1}`;
    const scope = typeof row.scope === "string" && row.scope.trim() ? row.scope.trim() : title;
    const deliverablesRaw = Array.isArray(row.deliverables) ? row.deliverables : [];
    const deliverables = deliverablesRaw
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
    const idRaw = typeof row.id === "string" && row.id.trim() ? row.id.trim() : `subproblem-${i + 1}`;

    normalized.push({
      id: idRaw,
      title,
      scope,
      deliverables: deliverables.length > 0 ? deliverables : [scope],
    });
  }

  if (normalized.length === 0) {
    throw new Error("[invalid_output] Recursive decomposition produced zero usable subproblems.");
  }

  return normalized;
}

function parseRecursiveDecomposition(text: string): RecursiveDecomposition {
  const payload = extractJsonPayload(text);
  if (!payload || typeof payload !== "object") {
    throw new Error("[invalid_output] Recursive decomposition must be a JSON object.");
  }
  const row = payload as Record<string, unknown>;
  const objective = typeof row.objective === "string" && row.objective.trim() ? row.objective.trim() : "Plan objective";
  const subproblems = normalizeSubproblems(row.subproblems);
  return { objective, subproblems };
}

async function runCodexPlan(opts: {
  name: string;
  cwd: string;
  prompt: string;
  outPath: string;
}): Promise<string> {
  const out = await exec.execCli({
    name: opts.name,
    cwd: opts.cwd,
    cmd: "codex",
    args: ["-a", "never", "-s", "danger-full-access", "exec", "-o", opts.outPath, "-"],
    stdin: opts.prompt,
    lastMessagePath: opts.outPath,
  });
  return extractCodexAnswer(out.lastMessage ?? out.tail).trim();
}

async function executeDirectPlan(opts: {
  issueId: string;
  repoPath: string;
  taskDescription: string;
}): Promise<StrategyResult> {
  const prompt = await meta.renderPromptTemplate({
    templatePath: "/Users/ava/xena 2p0/docs/planner.md",
    variables: {
      taskDescription: opts.taskDescription,
    },
  });
  const markdown = await runCodexPlan({
    name: "codex-planner",
    cwd: opts.repoPath,
    prompt,
    outPath: `/Users/ava/xena 2p0/runs/xena:${opts.issueId}/codex-planner.last.md`,
  });
  return {
    markdown,
    recursionDepth: 0,
    branchCount: 0,
  };
}

async function executeTeddyDirectPlan(opts: {
  issueId: string;
  repoPath: string;
  taskDescription: string;
}): Promise<StrategyResult> {
  const prompt = await meta.renderPromptTemplate({
    templatePath: "/Users/ava/xena 2p0/docs/planner.md",
    variables: {
      taskDescription: opts.taskDescription,
    },
  });
  const outPath = `/Users/ava/xena 2p0/runs/xena:${opts.issueId}/teddy-planner.last.md`;
  const out = await exec.execCli({
    name: "teddy-planner",
    cwd: opts.repoPath,
    cmd: "teddy",
    args: ["--quiet", "-o", outPath, prompt],
    lastMessagePath: outPath,
  });
  const markdown = (out.lastMessage ?? out.tail).trim();
  if (!markdown) {
    throw new Error("[invalid_output] teddy direct planner returned empty output.");
  }
  return {
    markdown,
    recursionDepth: 0,
    branchCount: 0,
  };
}

async function executeRecursivePlan(opts: {
  issueId: string;
  repoPath: string;
  taskDescription: string;
}): Promise<StrategyResult> {
  if (!patched("plan-recursive-strategy-v1")) {
    throw new Error("[invalid_output] Recursive planning patch gate is disabled for this workflow history.");
  }

  const decomposePrompt = await meta.renderPromptTemplate({
    templatePath: "/Users/ava/xena 2p0/docs/planner.recursive.decompose.md",
    variables: {
      taskDescription: opts.taskDescription,
      maxBranches: String(MAX_RECURSIVE_BRANCHES),
      maxDepth: String(MAX_RECURSION_DEPTH),
    },
  });

  const decompositionRaw = await runCodexPlan({
    name: "codex-planner-recursive-decompose",
    cwd: opts.repoPath,
    prompt: decomposePrompt,
    outPath: `/Users/ava/xena 2p0/runs/xena:${opts.issueId}/codex-planner.recursive.decompose.last.md`,
  });
  const decomposition = parseRecursiveDecomposition(decompositionRaw);

  const successfulSubplans: Array<{ subproblem: RecursiveSubproblem; plan: string }> = [];
  const failedSubplans: Array<{ subproblemId: string; reason: string }> = [];

  for (let i = 0; i < decomposition.subproblems.length && i < MAX_RECURSIVE_BRANCHES; i += 1) {
    const subproblem = decomposition.subproblems[i];
    const subplanPrompt = await meta.renderPromptTemplate({
      templatePath: "/Users/ava/xena 2p0/docs/planner.recursive.subplan.md",
      variables: {
        taskDescription: opts.taskDescription,
        objective: decomposition.objective,
        subproblem: JSON.stringify(subproblem, null, 2),
        subproblemIndex: String(i + 1),
        subproblemTotal: String(decomposition.subproblems.length),
      },
    });

    try {
      const subplan = await runCodexPlan({
        name: `codex-planner-recursive-subplan-${i + 1}`,
        cwd: opts.repoPath,
        prompt: subplanPrompt,
        outPath: `/Users/ava/xena 2p0/runs/xena:${opts.issueId}/codex-planner.recursive.subplan.${i + 1}.last.md`,
      });
      if (!subplan || subplan.length < 60) {
        throw new Error("Subplan output was too short.");
      }
      successfulSubplans.push({ subproblem, plan: subplan });
    } catch (err) {
      failedSubplans.push({
        subproblemId: subproblem.id,
        reason: extractErrorMessage(err),
      });
    }
  }

  if (successfulSubplans.length < 2) {
    throw new Error(
      `[invalid_output] Recursive planning produced insufficient viable subplans. success=${successfulSubplans.length} failure=${failedSubplans.length}`,
    );
  }

  const synthPrompt = await meta.renderPromptTemplate({
    templatePath: "/Users/ava/xena 2p0/docs/planner.recursive.synthesize.md",
    variables: {
      taskDescription: opts.taskDescription,
      objective: decomposition.objective,
      decomposition: JSON.stringify(decomposition, null, 2),
      successfulSubplans: successfulSubplans
        .map(
          (entry, idx) =>
            `### Subplan ${idx + 1}: ${entry.subproblem.title}\n\n${entry.plan}`,
        )
        .join("\n\n"),
      failedSubplans: JSON.stringify(failedSubplans, null, 2),
      maxDepth: String(MAX_RECURSION_DEPTH),
    },
  });

  const markdown = await runCodexPlan({
    name: "codex-planner-recursive-synthesize",
    cwd: opts.repoPath,
    prompt: synthPrompt,
    outPath: `/Users/ava/xena 2p0/runs/xena:${opts.issueId}/codex-planner.recursive.synthesize.last.md`,
  });

  if (!markdown) {
    throw new Error("[invalid_output] Recursive synthesis returned empty output.");
  }

  return {
    markdown,
    recursionDepth: 2,
    branchCount: decomposition.subproblems.length,
  };
}

type PlanToolAdapterArgs = {
  strategyId: PlanStrategyId;
  issueId: string;
  repoPath: string;
  taskDescription: string;
};

type PlanToolAdapter = (opts: PlanToolAdapterArgs) => Promise<StrategyResult>;

const PLAN_TOOL_ADAPTERS: Record<string, PlanToolAdapter> = {
  "tool.plan.codex.direct": async (opts) =>
    executeDirectPlan({
      issueId: opts.issueId,
      repoPath: opts.repoPath,
      taskDescription: opts.taskDescription,
    }),
  "tool.plan.codex.recursive": async (opts) =>
    executeRecursivePlan({
      issueId: opts.issueId,
      repoPath: opts.repoPath,
      taskDescription: opts.taskDescription,
    }),
  "tool.plan.teddy.direct": async (opts) =>
    executeTeddyDirectPlan({
      issueId: opts.issueId,
      repoPath: opts.repoPath,
      taskDescription: opts.taskDescription,
    }),
};

async function executeStrategy(opts: {
  strategyId: PlanStrategyId;
  issueId: string;
  repoPath: string;
  taskDescription: string;
}): Promise<StrategyResult> {
  const strategy = PLAN_STRATEGIES[opts.strategyId];
  const adapter = PLAN_TOOL_ADAPTERS[strategy.toolId];
  if (!adapter) {
    throw new Error(`[provider_bad_request][tool_id:${strategy.toolId}] No planning adapter registered for tool.`);
  }

  try {
    return await adapter(opts);
  } catch (err) {
    throw new Error(`[tool_id:${strategy.toolId}] ${extractErrorMessage(err)}`);
  }
}

export async function planWorkflow(args: PlanArgs): Promise<void> {
  try {
    const issue = await meta.linearGetIssue({ issueId: args.issueId });
    const memoryContext = await meta.mem0SearchHybridContext({
      projectKey: args.project.projectKey,
      issueIdentifier: issue.identifier,
      query: `${issue.identifier}: ${issue.title}`,
      stage: "planning",
      intent: "plan_start",
      appId: "xena",
      agentId: "workflow.plan",
      runId: args.issueId,
    });
    const decisionSignatures = await meta.mem0GetDecisionSignatures({
      projectKey: args.project.projectKey,
      issueIdentifier: issue.identifier,
      query: `${issue.identifier}: ${issue.title}`,
      stage: "planning",
      intent: "plan_start",
    });
    const userPreferences = await meta.mem0GetUserPreferences({
      projectKey: args.project.projectKey,
    });
    const selectedPlaybookId = resolveCodingPlaybookId(args.playbookId);

    const postTeammate = async (opts: { intent: string; draft: string; facts?: string }) => {
      if (!shouldPostTeammateUpdate(userPreferences, opts.intent)) return;

      const freshMemory = await meta.mem0SearchHybridContext({
        projectKey: args.project.projectKey,
        issueIdentifier: issue.identifier,
        query: `${issue.identifier}: ${issue.title}\nIntent: ${opts.intent}`,
        stage: "planning",
        intent: opts.intent,
        appId: "xena",
        agentId: "workflow.plan",
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
        memory: freshMemory.text,
        recentComments: recentSummary,
        taskContext: `stage=planning`,
        intent: opts.intent,
        draft: opts.draft,
        facts: opts.facts,
        preferences: userPreferences,
      });
      await meta.linearPostComment({ issueId: args.issueId, body });
    };

    await postTeammate({
      intent: "plan_start",
      draft: "Putting together a plan.",
    });

    const taskDescription = buildTaskDescription({
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      issueDescription: issue.description,
      memory: memoryContext.text,
      decisionSignatures: decisionSignatures.text,
    });

    if (!patched("plan-strategy-matrix-v1")) {
      const out = await executeDirectPlan({
        issueId: args.issueId,
        repoPath: args.project.repoPath,
        taskDescription,
      });
      await meta.linearPostLongComment({
        issueId: args.issueId,
        header: `Plan`,
        body: `<!--xena:plan-->\n\n${out.markdown}`,
      });
      await meta.mem0Add({
        projectKey: args.project.projectKey,
        issueIdentifier: issue.identifier,
        content: `[plan]\nplaybook_id: ${selectedPlaybookId}\n${out.markdown}`,
        type: "workflow_artifact",
        intent: "plan_posted",
        stage: "planning",
        outcome: "success",
        source: "workflow.plan",
        runId: args.issueId,
        agentId: "workflow.plan",
        appId: "xena",
        playbookId: selectedPlaybookId,
        tags: ["plan", "artifact"],
      });
      await meta.mem0DistillMemorySnapshot({
        projectKey: args.project.projectKey,
        issueIdentifier: issue.identifier,
        query: `${issue.identifier}: ${issue.title}`,
        stage: "planning",
        intent: "plan_posted",
        runId: args.issueId,
      });
      await postTeammate({
        intent: "plan_posted",
        draft: "Plan posted.",
      });
      return;
    }

    const failures: PlanAttemptFailure[] = [];
    const strategyPath: PlanStrategyId[] = [];
    let currentStrategy: PlanStrategyId = "codex-direct";
    let result: StrategyResult | null = null;
    let qualityScore = 0;
    let matrixLearning: PlanMatrixLearning | null = null;

    while (result === null) {
      strategyPath.push(currentStrategy);
      const strategy = PLAN_STRATEGIES[currentStrategy];

      try {
        const attempt = await executeStrategy({
          strategyId: currentStrategy,
          issueId: args.issueId,
          repoPath: args.project.repoPath,
          taskDescription,
        });

        qualityScore = scorePlanQuality(attempt.markdown);
        if (qualityScore < PLAN_QUALITY_PASS_THRESHOLD) {
          const qualityMessage = `[quality_low] quality_score=${qualityScore} threshold=${PLAN_QUALITY_PASS_THRESHOLD}`;
          failures.push({
            strategyId: currentStrategy,
            family: strategy.family,
            toolId: strategy.toolId,
            errorKind: "quality_low",
            errorMessage: qualityMessage,
          });

          await postTeammate({
            intent: "plan_strategy_error",
            draft: `Plan strategy ${strategy.name} failed quality gate.`,
            facts: [
              `strategy: ${currentStrategy}`,
              `tool_id: ${strategy.toolId}`,
              `family: ${strategy.family}`,
              `error_kind: quality_low`,
              `quality_score: ${qualityScore}`,
              `quality_threshold: ${PLAN_QUALITY_PASS_THRESHOLD}`,
            ].join("\n"),
          });

          if (failures.length >= MAX_PLAN_ATTEMPTS_TOTAL) {
            throw new Error(`Planning failed after ${failures.length} attempts.\n\n${formatPlanFailures(failures)}`);
          }

          const next = selectNextPlanStrategy({
            attempts: failures,
            currentStrategy,
            lastErrorKind: "quality_low",
          });
          if (!next.nextStrategyId) {
            throw new Error(`Planning failed: no strategy remaining.\n\n${formatPlanFailures(failures)}`);
          }

          await postTeammate({
            intent: "plan_strategy_switch",
            draft: `Switching planning strategy to ${PLAN_STRATEGIES[next.nextStrategyId].name}.`,
            facts: [
              next.reason,
              `from: ${currentStrategy}`,
              `to: ${next.nextStrategyId}`,
              `error_kind: quality_low`,
              `strategy_path: ${[...strategyPath, next.nextStrategyId].join(" -> ")}`,
              `attempt: ${failures.length + 1}/${MAX_PLAN_ATTEMPTS_TOTAL}`,
            ].join("\n"),
          });

          currentStrategy = next.nextStrategyId;
          continue;
        }

        result = attempt;
        if (failures.length > 0) {
          matrixLearning = {
            selectedStrategy: currentStrategy,
            selectedToolId: strategy.toolId,
            triggerErrorKinds: uniquePreserveOrder(failures.map((f) => f.errorKind)),
            strategyPath: strategyPath.map((step) => step),
            attempts: strategyPath.length,
            recursionDepth: attempt.recursionDepth,
            branchCount: attempt.branchCount,
            qualityScore,
          };
        }
      } catch (err) {
        const errorMessage = extractErrorMessage(err);
        const errorKind = classifyPlanError(errorMessage);

        failures.push({
          strategyId: currentStrategy,
          family: strategy.family,
          toolId: strategy.toolId,
          errorKind,
          errorMessage,
        });

        await postTeammate({
          intent: "plan_strategy_error",
          draft: `Planning strategy ${strategy.name} failed.`,
          facts: [
            `strategy: ${currentStrategy}`,
            `tool_id: ${strategy.toolId}`,
            `family: ${strategy.family}`,
            `error_kind: ${errorKind}`,
            `error: ${errorMessage}`,
          ].join("\n"),
        });

        if (failures.length >= MAX_PLAN_ATTEMPTS_TOTAL) {
          throw new Error(`Planning failed after ${failures.length} attempts.\n\n${formatPlanFailures(failures)}`);
        }

        const next = selectNextPlanStrategy({
          attempts: failures,
          currentStrategy,
          lastErrorKind: errorKind,
        });
        if (!next.nextStrategyId) {
          throw new Error(`Planning failed: no strategy remaining.\n\n${formatPlanFailures(failures)}`);
        }

        await postTeammate({
          intent: "plan_strategy_switch",
          draft: `Switching planning strategy to ${PLAN_STRATEGIES[next.nextStrategyId].name}.`,
          facts: [
            next.reason,
            `from: ${currentStrategy}`,
            `to: ${next.nextStrategyId}`,
            `error_kind: ${errorKind}`,
            `strategy_path: ${[...strategyPath, next.nextStrategyId].join(" -> ")}`,
            `attempt: ${failures.length + 1}/${MAX_PLAN_ATTEMPTS_TOTAL}`,
          ].join("\n"),
        });

        currentStrategy = next.nextStrategyId;
      }
    }

    await meta.linearPostLongComment({
      issueId: args.issueId,
      header: `Plan`,
      body: `<!--xena:plan-->\n\n${result.markdown}`,
    });

    await meta.mem0Add({
      projectKey: args.project.projectKey,
      issueIdentifier: issue.identifier,
      content: `[plan]\nplaybook_id: ${selectedPlaybookId}\n${result.markdown}`,
      type: "workflow_artifact",
      intent: "plan_posted",
      stage: "planning",
      outcome: "success",
      source: "workflow.plan",
      runId: args.issueId,
      agentId: "workflow.plan",
      appId: "xena",
      playbookId: selectedPlaybookId,
      tags: ["plan", "artifact", matrixLearning ? "matrix" : "direct"],
    });

    if (matrixLearning && patched("plan-strategy-matrix-learning-v1")) {
      try {
        const learned = await meta.registryUpsertLearnedPlanningPattern({
          issueIdentifier: issue.identifier,
          selectedStrategy: matrixLearning.selectedStrategy,
          selectedToolId: matrixLearning.selectedToolId,
          triggerErrorKinds: matrixLearning.triggerErrorKinds,
          strategyPath: matrixLearning.strategyPath,
          attempts: matrixLearning.attempts,
          recursionDepth: matrixLearning.recursionDepth,
          branchCount: matrixLearning.branchCount,
          qualityScore: matrixLearning.qualityScore,
        });

        await meta.mem0Add({
          projectKey: args.project.projectKey,
          issueIdentifier: issue.identifier,
          namespace: "quality.signals",
          content: [
            "[strategy_matrix]",
            "domain: planning",
            `selected_strategy: ${matrixLearning.selectedStrategy}`,
            `selected_tool_id: ${matrixLearning.selectedToolId}`,
            `selected_skill_id: ${selectedPlaybookId}`,
            `trigger_error_kinds: ${matrixLearning.triggerErrorKinds.join(", ")}`,
            `strategy_path: ${matrixLearning.strategyPath.join(" -> ")}`,
            `attempts: ${matrixLearning.attempts}`,
            `recursion_depth: ${matrixLearning.recursionDepth}`,
            `branch_count: ${matrixLearning.branchCount}`,
            `quality_score: ${matrixLearning.qualityScore}`,
            `registry_file: ${learned.path}`,
          ].join("\n"),
          type: "quality_signal",
          intent: "plan_matrix_learning",
          stage: "planning",
          outcome: "success",
          source: "workflow.plan",
          runId: args.issueId,
          agentId: "workflow.plan",
          appId: "xena",
          qualityScore: matrixLearning.qualityScore,
          playbookId: selectedPlaybookId,
          tags: ["plan", "matrix", "quality"],
        });

        await meta.mem0Add({
          projectKey: args.project.projectKey,
          issueIdentifier: issue.identifier,
          namespace: "code.decisions",
          content: [
            "[adaptive_decision]",
            "domain: planning",
            "selector: matrix",
            `selected_skill_id: ${selectedPlaybookId}`,
            `selected_strategy: ${matrixLearning.selectedStrategy}`,
            `strategy_path: ${matrixLearning.strategyPath.join(" -> ")}`,
            `trigger_error_kinds: ${matrixLearning.triggerErrorKinds.join(", ")}`,
            `attempts: ${matrixLearning.attempts}`,
            `recursion_depth: ${matrixLearning.recursionDepth}`,
            `branch_count: ${matrixLearning.branchCount}`,
            `quality_score: ${matrixLearning.qualityScore}`,
          ].join("\n"),
          type: "decision",
          intent: "plan_matrix_decision",
          stage: "planning",
          outcome: "success",
          source: "workflow.plan",
          runId: args.issueId,
          agentId: "workflow.plan",
          appId: "xena",
          qualityScore: matrixLearning.qualityScore,
          playbookId: selectedPlaybookId,
          tags: ["plan", "matrix", "decision"],
        });
      } catch (err) {
        await postTeammate({
          intent: "plan_matrix_learning_failed",
          draft: "Plan succeeded, but matrix learning persistence failed.",
          facts: extractErrorMessage(err),
        });
      }
    }

    await meta.mem0DistillMemorySnapshot({
      projectKey: args.project.projectKey,
      issueIdentifier: issue.identifier,
      query: `${issue.identifier}: ${issue.title}`,
      stage: "planning",
      intent: matrixLearning ? "plan_posted_matrix" : "plan_posted",
      runId: args.issueId,
    });

    await postTeammate({
      intent: "plan_posted",
      draft:
        matrixLearning !== null
          ? `Plan posted with adaptive strategy matrix (${matrixLearning.selectedStrategy}).`
          : "Plan posted.",
    });
  } catch (err: any) {
    const msg = typeof err?.message === "string" ? err.message : String(err);
    await meta.linearPostLongComment({
      issueId: args.issueId,
      header: `Plan blocked`,
      body: msg,
    });
    throw err;
  }
}
