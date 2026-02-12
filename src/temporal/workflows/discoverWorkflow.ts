import { patched, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/index.js";
import type { DiscoverArgs } from "../shared.js";
import { extractCodexAnswer } from "../output.js";
import { formatFailures, selectNextStrategy, uniquePreserveOrder, type MatrixFailure } from "./matrixRuntime.js";
import { shouldPostTeammateUpdate } from "../../memory/userPreferences.js";
import {
  DISCOVERY_POLICY,
  type DiscoveryErrorKind,
  type DiscoveryStrategyFamily,
  type DiscoveryStrategyId,
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

type DiscoveryAttemptFailure = MatrixFailure<DiscoveryStrategyId, DiscoveryStrategyFamily, DiscoveryErrorKind>;

type DiscoveryMatrixLearning = {
  selectedStrategy: DiscoveryStrategyId;
  selectedToolId: string;
  triggerErrorKinds: string[];
  strategyPath: string[];
  attempts: number;
};

const MAX_DISCOVERY_ATTEMPTS_TOTAL = DISCOVERY_POLICY.maxAttemptsTotal;
const MAX_DISCOVERY_ATTEMPTS_PER_FAMILY = DISCOVERY_POLICY.maxAttemptsPerFamily;
const DISCOVERY_STRATEGIES = DISCOVERY_POLICY.strategies;
const DISCOVERY_MATRIX = DISCOVERY_POLICY.matrix;
const FORCE_FAMILY_SWITCH_ERROR_KINDS = DISCOVERY_POLICY.forceFamilySwitchErrorKinds;
const DEFAULT_CODING_PLAYBOOK_ID = "skill.coding.lifecycle";

function resolveCodingPlaybookId(playbookId: string | undefined): string {
  const normalized = (playbookId ?? "").trim();
  return normalized.length > 0 ? normalized : DEFAULT_CODING_PLAYBOOK_ID;
}

function extractErrorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err && typeof (err as any).message === "string") {
    return (err as any).message;
  }
  return String(err);
}

function classifyDiscoveryError(message: string): DiscoveryErrorKind {
  const lower = message.toLowerCase();

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

function formatDiscoveryFailures(attempts: readonly DiscoveryAttemptFailure[]): string {
  return formatFailures(attempts);
}

function selectNextDiscoveryStrategy(opts: {
  attempts: readonly DiscoveryAttemptFailure[];
  currentStrategy: DiscoveryStrategyId;
  lastErrorKind: DiscoveryErrorKind;
}): { nextStrategyId: DiscoveryStrategyId | null; reason: string } {
  const currentFamily = DISCOVERY_STRATEGIES[opts.currentStrategy].family;
  return selectNextStrategy({
    attempts: opts.attempts,
    currentStrategy: opts.currentStrategy,
    currentFamily,
    matrixCandidates: DISCOVERY_MATRIX[opts.lastErrorKind],
    strategyFamilyFor: (strategyId) => DISCOVERY_STRATEGIES[strategyId].family,
    maxAttemptsPerFamily: MAX_DISCOVERY_ATTEMPTS_PER_FAMILY,
    forceFamilySwitchErrorKinds: FORCE_FAMILY_SWITCH_ERROR_KINDS,
    lastErrorKind: opts.lastErrorKind,
    fallbackOrder: DISCOVERY_POLICY.fallbackOrder,
    fallbackOrderOnFamilySwitch: DISCOVERY_POLICY.fallbackOrderOnFamilySwitch,
    allowSingleRetryOnNonzeroExit: DISCOVERY_POLICY.nonzeroExitRetry.enabled,
    nonzeroExitErrorKind: DISCOVERY_POLICY.nonzeroExitRetry.errorKind,
  });
}

function buildCodexDiscoveryPrompt(opts: {
  issueIdentifier: string;
  issueTitle: string;
  issueDescription: string | null;
  memory: string;
}): string {
  return [
    "You are running discovery fallback for Xena after strategy failures.",
    "Task: produce a deterministic discovery report for the ticket below.",
    "Requirements:",
    "- Focus only on repository-grounded facts.",
    "- Identify key files and code paths needed for implementation.",
    "- Call out blockers, assumptions, and next execution steps.",
    "- Do not propose mocks/stubs.",
    "",
    "Output format:",
    "## Discovery Summary",
    "## Relevant Files",
    "## Implementation Considerations",
    "## Risks / Unknowns",
    "## Recommended Next Steps",
    "",
    `Issue: ${opts.issueIdentifier}`,
    `Title: ${opts.issueTitle}`,
    `Description:\n${opts.issueDescription ?? ""}`,
    `Memory (mem0):\n${opts.memory}`,
  ].join("\n");
}

async function executeDiscoveryStrategy(opts: {
  strategyId: DiscoveryStrategyId;
  args: DiscoverArgs;
  prompt: string;
  codexPrompt: string;
}): Promise<{ tail: string; lastMessage?: string }> {
  const strategy = DISCOVERY_STRATEGIES[opts.strategyId];
  const adapter = DISCOVERY_TOOL_ADAPTERS[strategy.toolId];
  if (!adapter) {
    throw new Error(`[provider_bad_request][tool_id:${strategy.toolId}] No discovery adapter registered for tool.`);
  }

  try {
    return await adapter(opts);
  } catch (err) {
    throw new Error(`[tool_id:${strategy.toolId}] ${extractErrorMessage(err)}`);
  }
}

type DiscoveryToolAdapterArgs = {
  strategyId: DiscoveryStrategyId;
  args: DiscoverArgs;
  prompt: string;
  codexPrompt: string;
};

type DiscoveryToolAdapter = (opts: DiscoveryToolAdapterArgs) => Promise<{ tail: string; lastMessage?: string }>;

const DISCOVERY_TOOL_ADAPTERS: Record<string, DiscoveryToolAdapter> = {
  "tool.discovery.teddy.default": async (opts) => {
    const outPath = `runs/xena:${opts.args.issueId}/teddy-discovery.md`;
    return exec.execCli({
      name: "teddy",
      cwd: opts.args.project.repoPath,
      cmd: "teddy",
      args: ["--quiet", "-o", outPath, opts.prompt],
      lastMessagePath: outPath,
    });
  },
  "tool.discovery.teddy.gpt_oss": async (opts) => {
    const outPath = `runs/xena:${opts.args.issueId}/teddy-discovery.md`;
    return exec.execCli({
      name: "teddy-fallback",
      cwd: opts.args.project.repoPath,
      cmd: "teddy",
      args: ["-m", "gpt-oss-120b", "--quiet", "-o", outPath, opts.prompt],
      lastMessagePath: outPath,
    });
  },
  "tool.discovery.codex.exec": async (opts) => {
    const outPath = `runs/xena:${opts.args.issueId}/codex-discovery.last.md`;
    return exec.execCli({
      name: "codex-discovery-fallback",
      cwd: opts.args.project.repoPath,
      cmd: "codex",
      args: ["-a", "never", "-s", "danger-full-access", "exec", "-o", outPath, "-"],
      stdin: opts.codexPrompt,
      lastMessagePath: outPath,
    });
  },
};

export async function discoverWorkflow(args: DiscoverArgs): Promise<void> {
  const issue = await meta.linearGetIssue({ issueId: args.issueId });
  const memory = await meta.mem0Search({
    projectKey: args.project.projectKey,
    issueIdentifier: issue.identifier,
    query: `${issue.identifier}: ${issue.title}`,
    appId: "xena",
    agentId: "workflow.discover",
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
      agentId: "workflow.discover",
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
      taskContext: `stage=discovering`,
      intent: opts.intent,
      draft: opts.draft,
      facts: opts.facts,
      preferences: userPreferences,
    });
    await meta.linearPostComment({ issueId: args.issueId, body });
  };

  await postTeammate({
    intent: "discover_start",
    draft: "Starting discovery.",
  });

  const prompt = [
    `Issue: ${issue.identifier}`,
    `Title: ${issue.title}`,
    `Description:\n${issue.description ?? ""}`,
    `Memory (mem0):\n${memory}`,
  ].join("\n\n");

  let out: { tail: string; lastMessage?: string } | null = null;
  let discoveryStrategy: "teddy" | "teddy-fallback" | "codex-fallback" | DiscoveryStrategyId = "teddy";
  let matrixLearning: DiscoveryMatrixLearning | null = null;

  if (!patched("discover-strategy-matrix-v1")) {
    // Legacy path kept for replay safety on in-flight histories.
    const outPath = `runs/xena:${args.issueId}/teddy-discovery.md`;
    try {
      out = await exec.execCli({
        name: "teddy",
        cwd: args.project.repoPath,
        cmd: "teddy",
        // teddy's default UI output is very noisy (spinners/progress). Use --quiet and write
        // the final result to a deterministic per-ticket file, then read/post that content.
        args: ["--quiet", "-o", outPath, prompt],
        lastMessagePath: outPath,
      });
    } catch (err1: any) {
      // Best-in-class Temporal deploy safety: use a patch marker so older workflow histories replay deterministically.
      if (!patched("discover-teddy-fallback-gpt-oss-120b")) throw err1;

      await postTeammate({
        intent: "discover_retry",
        draft: "Discovery hit an error. Trying again.",
        facts: typeof err1?.message === "string" ? err1.message : String(err1),
      });

      try {
        out = await exec.execCli({
          name: "teddy-fallback",
          cwd: args.project.repoPath,
          cmd: "teddy",
          args: ["-m", "gpt-oss-120b", "--quiet", "-o", outPath, prompt],
          lastMessagePath: outPath,
        });
        discoveryStrategy = "teddy-fallback";
      } catch (err2: any) {
        const msg1 = typeof err1?.message === "string" ? err1.message : String(err1);
        const msg2 = typeof err2?.message === "string" ? err2.message : String(err2);
        if (!patched("discover-codex-fallback-v1")) {
          throw new Error(`Discovery failed.\n\nDefault attempt:\n${msg1}\n\nFallback attempt (gpt-oss-120b):\n${msg2}`);
        }

        await postTeammate({
          intent: "discover_codex_fallback",
          draft: "Discovery failed on teddy twice. Switching to codex fallback.",
          facts: `Default teddy error:\n${msg1}\n\nFallback teddy error:\n${msg2}`,
        });

        const codexDiscoveryPrompt = buildCodexDiscoveryPrompt({
          issueIdentifier: issue.identifier,
          issueTitle: issue.title,
          issueDescription: issue.description,
          memory,
        });

        const codexOutPath = `runs/xena:${args.issueId}/codex-discovery.last.md`;
        try {
          out = await exec.execCli({
            name: "codex-discovery-fallback",
            cwd: args.project.repoPath,
            cmd: "codex",
            args: [
              "-a",
              "never",
              "-s",
              "danger-full-access",
              "exec",
              "-o",
              codexOutPath,
              "-",
            ],
            stdin: codexDiscoveryPrompt,
            lastMessagePath: codexOutPath,
          });
          discoveryStrategy = "codex-fallback";
        } catch (err3: any) {
          const msg3 = typeof err3?.message === "string" ? err3.message : String(err3);
          throw new Error(
            `Discovery failed.\n\nDefault attempt:\n${msg1}\n\nFallback attempt (gpt-oss-120b):\n${msg2}\n\nCodex fallback attempt:\n${msg3}`,
          );
        }
      }
    }
  } else {
    const codexPrompt = buildCodexDiscoveryPrompt({
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      issueDescription: issue.description,
      memory,
    });
    const failures: DiscoveryAttemptFailure[] = [];
    const strategyPath: DiscoveryStrategyId[] = [];
    let currentStrategy: DiscoveryStrategyId = "teddy-default";

    while (out === null) {
      strategyPath.push(currentStrategy);
      const strategy = DISCOVERY_STRATEGIES[currentStrategy];

      try {
        out = await executeDiscoveryStrategy({
          strategyId: currentStrategy,
          args,
          prompt,
          codexPrompt,
        });
        discoveryStrategy = currentStrategy;

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
        const errorKind = classifyDiscoveryError(errorMessage);

        failures.push({
          strategyId: currentStrategy,
          family: strategy.family,
          toolId: strategy.toolId,
          errorKind,
          errorMessage,
        });

        await postTeammate({
          intent: "discover_strategy_error",
          draft: `Discovery strategy ${strategy.name} failed.`,
          facts: [
            `strategy: ${currentStrategy}`,
            `tool_id: ${strategy.toolId}`,
            `family: ${strategy.family}`,
            `error_kind: ${errorKind}`,
            `error: ${errorMessage}`,
          ].join("\n"),
        });

        if (failures.length >= MAX_DISCOVERY_ATTEMPTS_TOTAL) {
          throw new Error(
            `Discovery failed after ${failures.length} attempts.\n\n${formatDiscoveryFailures(failures)}`,
          );
        }

        const next = selectNextDiscoveryStrategy({
          attempts: failures,
          currentStrategy,
          lastErrorKind: errorKind,
        });

        if (!next.nextStrategyId) {
          throw new Error(
            `Discovery failed: no strategy remaining.\n\n${formatDiscoveryFailures(failures)}`,
          );
        }

        const nextStrategy = DISCOVERY_STRATEGIES[next.nextStrategyId];
        await postTeammate({
          intent: "discover_strategy_switch",
          draft: `Switching discovery strategy to ${nextStrategy.name}.`,
          facts: [
            next.reason,
            `from: ${currentStrategy}`,
            `to: ${next.nextStrategyId}`,
            `strategy_path: ${[...strategyPath, next.nextStrategyId].join(" -> ")}`,
          ].join("\n"),
        });

        currentStrategy = next.nextStrategyId;
      }
    }
  }

  if (!out) {
    throw new Error("Discovery failed before producing output.");
  }

  const rawDiscovery = out.lastMessage ?? out.tail;
  const toPost =
    discoveryStrategy === "codex-fallback" || discoveryStrategy === "codex-exec"
      ? extractCodexAnswer(rawDiscovery)
      : rawDiscovery;
  await meta.linearPostLongComment({
    issueId: args.issueId,
    header: `Discovery`,
    body: `<!--xena:discover-->\n\n${toPost}`,
  });

  await meta.mem0Add({
    projectKey: args.project.projectKey,
    issueIdentifier: issue.identifier,
    content: `[discover]\n${toPost}`,
    type: "workflow_artifact",
    intent: "discover_done",
    stage: "discovering",
    outcome: "success",
    source: "workflow.discover",
    runId: args.issueId,
    agentId: "workflow.discover",
    appId: "xena",
    playbookId: selectedPlaybookId,
    tags: ["discover", discoveryStrategy],
  });

  if (discoveryStrategy === "codex-fallback" && patched("discover-codex-fallback-learning-v1")) {
    await meta.mem0Add({
      projectKey: args.project.projectKey,
      issueIdentifier: issue.identifier,
      namespace: "quality.signals",
      content: [
        "[learned_workflow]",
        "name: discovery.codex_fallback.v1",
        "trigger: teddy discovery default + model fallback both failed",
        "action: run codex headless discovery against repo context",
        "outcome: success",
        `ticket: ${issue.identifier}`,
      ].join("\n"),
      type: "quality_signal",
      intent: "discover_fallback_learned",
      stage: "discovering",
      outcome: "success",
      source: "workflow.discover",
      runId: args.issueId,
      agentId: "workflow.discover",
      appId: "xena",
      tags: ["discover", "fallback", "quality"],
    });

    await meta.mem0Add({
      projectKey: args.project.projectKey,
      issueIdentifier: issue.identifier,
      namespace: "code.decisions",
      content: [
        "[fallback_decision]",
        "domain: discovery",
        "primary: teddy --quiet",
        "fallback: teddy -m gpt-oss-120b",
        "adaptive_fallback: codex exec <discovery prompt>",
        "note: promote as reusable fallback workflow when repeated",
      ].join("\n"),
      type: "decision",
      intent: "discover_fallback_decision",
      stage: "discovering",
      outcome: "success",
      source: "workflow.discover",
      runId: args.issueId,
      agentId: "workflow.discover",
      appId: "xena",
      tags: ["discover", "fallback", "decision"],
    });
  }

  if (matrixLearning && patched("discover-strategy-matrix-learning-v1")) {
    try {
      const learned = await meta.registryUpsertLearnedDiscoveryPattern({
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
          "domain: discovery",
          `selected_strategy: ${matrixLearning.selectedStrategy}`,
          `selected_tool_id: ${matrixLearning.selectedToolId}`,
          `selected_skill_id: ${selectedPlaybookId}`,
          `trigger_error_kinds: ${matrixLearning.triggerErrorKinds.join(", ")}`,
          `strategy_path: ${matrixLearning.strategyPath.join(" -> ")}`,
          `attempts: ${matrixLearning.attempts}`,
          `registry_file: ${learned.path}`,
        ].join("\n"),
        type: "quality_signal",
        intent: "discover_matrix_learning",
        stage: "discovering",
        outcome: "success",
        source: "workflow.discover",
        runId: args.issueId,
        agentId: "workflow.discover",
        appId: "xena",
        playbookId: selectedPlaybookId,
        tags: ["discover", "matrix", "quality"],
      });

      await meta.mem0Add({
        projectKey: args.project.projectKey,
        issueIdentifier: issue.identifier,
        namespace: "code.decisions",
        content: [
          "[adaptive_decision]",
          "domain: discovery",
          "selector: matrix",
          `selected_skill_id: ${selectedPlaybookId}`,
          `selected_strategy: ${matrixLearning.selectedStrategy}`,
          `strategy_path: ${matrixLearning.strategyPath.join(" -> ")}`,
          `trigger_error_kinds: ${matrixLearning.triggerErrorKinds.join(", ")}`,
          `attempts: ${matrixLearning.attempts}`,
        ].join("\n"),
        type: "decision",
        intent: "discover_matrix_decision",
        stage: "discovering",
        outcome: "success",
        source: "workflow.discover",
        runId: args.issueId,
        agentId: "workflow.discover",
        appId: "xena",
        playbookId: selectedPlaybookId,
        tags: ["discover", "matrix", "decision"],
      });
    } catch (err) {
      await postTeammate({
        intent: "discover_matrix_learning_failed",
        draft: "Discovery succeeded, but learning persistence failed.",
        facts: extractErrorMessage(err),
      });
    }
  }

  await postTeammate({
    intent: "discover_done",
    draft:
      discoveryStrategy === "codex-fallback"
        ? "Discovery done via codex fallback; pattern captured for reuse."
        : matrixLearning
          ? `Discovery done with adaptive strategy matrix (${matrixLearning.selectedStrategy}).`
        : "Discovery done.",
  });
}
