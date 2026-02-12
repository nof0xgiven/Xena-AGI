import {
  condition,
  defineQuery,
  defineSignal,
  patched,
  proxyActivities,
  setHandler,
  sleep,
} from "@temporalio/workflow";
import { appendEngineTransition } from "../../operator/engineRuntime.js";
import type { EngineStage, EngineTransitionRecord } from "../../operator/types.js";
import type * as activities from "../activities/index.js";
import type { GithubPrSignal, LinearCommentSignal, TicketArgs, TicketWakeSignal } from "../shared.js";
import { discoverWorkflow } from "./discoverWorkflow.js";
import { planWorkflow } from "./planWorkflow.js";
import { codeWorkflow } from "./codeWorkflow.js";
import { QUERY_TICKET_STATUS, SIGNAL_GITHUB_PR, SIGNAL_LINEAR_COMMENT, SIGNAL_TICKET_WAKE } from "../signals.js";
import { MEMORY_NAMESPACES } from "../../memory/policy.js";
import {
  DEFAULT_USER_PREFERENCES,
  applyUserPreferencesPatch,
  cloneUserPreferences,
  parseUserPreferencesPatch,
  renderUserPreferencesForPrompt,
  serializeUserPreferencesForMemory,
  shouldPostTeammateUpdate,
} from "../../memory/userPreferences.js";

type MetaActivities = Omit<
  typeof activities,
  | "execCli"
  | "createWorktree"
  | "hyperbrowserSmoke"
  | "hyperbrowserRunQaTask"
  | "sandboxProvisionFromPr"
  | "sandboxTeardown"
>;
type QaActivities = Pick<typeof activities, "hyperbrowserRunQaTask">;
type SandboxActivities = Pick<typeof activities, "sandboxProvisionFromPr" | "sandboxTeardown">;

const meta = proxyActivities<MetaActivities>({
  startToCloseTimeout: "10 minutes",
  retry: {
    maximumAttempts: 5,
    initialInterval: "2 seconds",
    maximumInterval: "1 minute",
  },
});

const qa = proxyActivities<QaActivities>({
  startToCloseTimeout: "30 minutes",
  heartbeatTimeout: "30 seconds",
  retry: { maximumAttempts: 1 },
});

const sandbox = proxyActivities<SandboxActivities>({
  startToCloseTimeout: "60 minutes",
  heartbeatTimeout: "30 seconds",
  retry: {
    maximumAttempts: 2,
    initialInterval: "5 seconds",
    maximumInterval: "2 minutes",
  },
});

type Stage =
  | "started"
  | "evaluating"
  | "discovering"
  | "planning"
  | "coding"
  | "creating_pr"
  | "waiting_sandbox"
  | "waiting_smoke"
  | "tearing_down"
  | "handoff"
  | "blocked"
  | "failed"
  | "completed";

type TicketStatus = {
  issueId: string;
  mode: "normal" | "evaluate_only";
  stage: Stage;
  engineStage: EngineStage;
  lastStageRationale?: string;
  engineTransitions: readonly EngineTransitionRecord[];
  resumeStage?: Stage;
  reviewAttempts: number;
  smokeAttempts: number;
  prUrl?: string;
  prNumber?: number;
  repoFullName?: string;
  prHeadBranch?: string;
  prClosed?: boolean;
  sandboxId?: string;
  sandboxUrl?: string;
  sandboxTeardownDone?: boolean;
  frontendTask?: boolean;
  frontendReason?: string;
  worktreePath?: string;
  branchName?: string;
  blockedReason?: string;
  lastError?: string;
};

function mapTicketStageToEngineStage(stage: Stage): EngineStage {
  switch (stage) {
    case "started":
    case "evaluating":
      return "understand";
    case "discovering":
      return "prove";
    case "planning":
      return "plan";
    case "coding":
    case "creating_pr":
      return "execute";
    case "waiting_sandbox":
    case "waiting_smoke":
    case "tearing_down":
      return "validate";
    case "handoff":
    case "completed":
      return "learn";
    case "blocked":
    case "failed":
      return "adapt";
    default:
      return "adapt";
  }
}

function defaultTicketStageRationale(stage: Stage): string {
  switch (stage) {
    case "started":
      return "Ticket workflow initialized.";
    case "evaluating":
      return "Evaluation-only mode active; no execution steps.";
    case "discovering":
      return "Gathering context before planning.";
    case "planning":
      return "Building implementation plan from discovered context.";
    case "coding":
      return "Executing implementation and review loop.";
    case "creating_pr":
      return "Creating PR for completed implementation.";
    case "waiting_sandbox":
      return "Waiting for sandbox provisioning or confirmation.";
    case "waiting_smoke":
      return "Waiting for smoke/QA validation results.";
    case "tearing_down":
      return "Tearing down sandbox resources.";
    case "handoff":
      return "Handoff prepared for human owner.";
    case "blocked":
      return "Workflow blocked and waiting for operator input.";
    case "failed":
      return "Workflow failed and requires adaptation.";
    case "completed":
      return "Workflow completed.";
    default:
      return "Stage transition applied.";
  }
}

const KNOWN_COMMANDS = new Set([
  "help",
  "status",
  "stop",
  "continue",
  "restart",
  "evaluate",
  "sandbox",
  "smoke",
  "prefs",
  "preferences",
]);

function parseCommand(body: string): { cmd: string; args: string; explicit: boolean } | null {
  const t = body.trim();
  const lower = t.toLowerCase();
  let rest: string | null = null;
  let explicit = false;
  if (lower.startsWith("/xena")) {
    rest = t.slice("/xena".length).trim();
    explicit = true;
  } else if (lower.startsWith("@xena")) rest = t.slice("@xena".length).trim();
  else if (lower.startsWith("xena")) rest = t.slice("xena".length).trim();
  if (rest == null) return null;

  const m = rest.match(/^(\S+)(?:\s+(.*))?$/);
  const cmd = (m?.[1] ?? "help").toLowerCase();
  const args = (m?.[2] ?? "").trim();

  if (!explicit && !KNOWN_COMMANDS.has(cmd)) return null;
  return { cmd, args, explicit };
}

function parsePreferencesCommandArgs(
  args: string,
): { action: "show" | "reset" | "set"; rawJson?: string; error?: string } {
  const trimmed = args.trim();
  if (!trimmed || trimmed === "show") {
    return { action: "show" };
  }
  if (trimmed === "reset") {
    return { action: "reset" };
  }
  if (trimmed.startsWith("set ")) {
    const rawJson = trimmed.slice(4).trim();
    if (!rawJson) {
      return {
        action: "set",
        error: "Missing JSON payload after `set`.",
      };
    }
    return { action: "set", rawJson };
  }
  return {
    action: "show",
    error:
      "Usage: `xena prefs show` | `xena prefs reset` | `xena prefs set {\"tone\":\"direct\",\"updateCadence\":\"balanced\"}`",
  };
}

function extractFirstPrUrl(text: string): string | null {
  const m = text.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
  return m ? m[0] : null;
}

function extractFirstVercelUrl(text: string): string | null {
  const urls = text.match(/https?:\/\/[^\s)]+/g) ?? [];
  for (const u of urls) {
    if (/vercel\.(app|run)\b/i.test(u) || /vercel\.run\b/i.test(u)) return u;
  }
  return null;
}

function looksLikeSmokePass(text: string): boolean {
  return /\b(smoke|qa)\b/i.test(text) && /\b(pass|passed|success)\b/i.test(text);
}

function looksLikeSmokeFail(text: string): boolean {
  return /\b(smoke|qa)\b/i.test(text) && /\b(fail|failed|error)\b/i.test(text);
}

function prNumberFromUrl(prUrl: string | undefined): number | null {
  if (!prUrl) return null;
  const m = prUrl.match(/\/pull\/(\d+)/);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function repoFromPrUrl(prUrl: string | undefined): string | null {
  if (!prUrl) return null;
  const m = prUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/);
  return m ? m[1] : null;
}

function singleQuestionText(text: string | null | undefined): string | null {
  const t = (text ?? "").trim().replace(/\s+/g, " ");
  if (!t) return null;
  const q = t.split("?")[0]?.trim();
  if (!q) return null;
  return `${q}?`;
}

function summarizeRecentCommentsForPrompt(
  comments: Array<{ body?: string; createdAt?: string }>,
  max = 10,
): string {
  const trimmed = comments.slice(-max);
  return trimmed
    .map((c, idx) => {
      const body = (c.body ?? "")
        .replace(/<!--xena:[\s\S]*?-->/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300);
      const at = typeof c.createdAt === "string" ? c.createdAt : "";
      return `${idx + 1}. [${at}] ${body}`;
    })
    .join("\n");
}

function buildSandboxMarker(meta: {
  sandboxId: string;
  sandboxUrl: string;
  prNumber: number;
  repositoryFullName: string;
}): string {
  return `<!--xena:sandbox:${JSON.stringify(meta)}-->`;
}

function extractSandboxMarker(text: string): {
  sandboxId: string;
  sandboxUrl: string;
  prNumber: number;
  repositoryFullName: string;
} | null {
  const m = text.match(/<!--xena:sandbox:({[\s\S]*?})-->/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.sandboxId !== "string" ||
      typeof parsed.sandboxUrl !== "string" ||
      typeof parsed.prNumber !== "number" ||
      typeof parsed.repositoryFullName !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isFrontendPath(path: string): boolean {
  const p = path.toLowerCase();
  if (
    p.endsWith(".tsx") ||
    p.endsWith(".jsx") ||
    p.endsWith(".css") ||
    p.endsWith(".scss") ||
    p.endsWith(".sass") ||
    p.endsWith(".less") ||
    p.endsWith(".html") ||
    p.endsWith(".vue") ||
    p.endsWith(".svelte")
  ) {
    return true;
  }
  return (
    p.includes("/apps/tenant/") ||
    p.includes("/apps/web/") ||
    p.includes("/frontend/") ||
    p.includes("/ui/") ||
    p.includes("/components/") ||
    p.includes("/styles/")
  );
}

function isBackendPath(path: string): boolean {
  const p = path.toLowerCase();
  return (
    p.includes("/api/") ||
    p.includes("/server/") ||
    p.includes("/backend/") ||
    p.includes("/migrations/") ||
    p.includes("/database/") ||
    p.endsWith(".sql")
  );
}

function assessFrontendTask(opts: {
  labels: string[];
  issueTitle: string;
  issueDescription: string | null;
  changedFiles: string[];
}): { frontend: boolean; reason: string } {
  let score = 0;

  const text = `${opts.issueTitle}\n${opts.issueDescription ?? ""}`.toLowerCase();
  const frontendWords = [
    "frontend",
    "front-end",
    "ui",
    "ux",
    "component",
    "styling",
    "css",
    "responsive",
    "page",
    "screen",
  ];
  const backendWords = ["backend", "api", "migration", "db", "database", "worker", "cron"];

  const labels = opts.labels.map((l) => l.toLowerCase());
  if (labels.some((l) => /\b(frontend|ui|ux|web|design)\b/.test(l))) score += 3;
  if (labels.some((l) => /\b(backend|db|api)\b/.test(l))) score -= 1;

  if (frontendWords.some((w) => text.includes(w))) score += 2;
  if (backendWords.some((w) => text.includes(w))) score -= 1;

  let frontendFiles = 0;
  let backendFiles = 0;
  for (const file of opts.changedFiles) {
    if (isFrontendPath(file)) frontendFiles += 1;
    if (isBackendPath(file)) backendFiles += 1;
  }
  if (frontendFiles > 0) score += 3;
  if (backendFiles > frontendFiles) score -= 2;

  const frontend = score >= 3;
  const reason = `score=${score}; frontendFiles=${frontendFiles}; backendFiles=${backendFiles}; labels=${opts.labels.join(",") || "(none)"}`;
  return { frontend, reason };
}

export async function ticketWorkflowV2Core(args: TicketArgs): Promise<void> {
  const startMode = args.startMode ?? "normal";
  const evaluateOnly = startMode === "evaluate_only";
  const engineTransitions: EngineTransitionRecord[] = [];
  const status: TicketStatus = {
    issueId: args.issueId,
    mode: startMode,
    stage: "started",
    engineStage: mapTicketStageToEngineStage("started"),
    lastStageRationale: undefined,
    engineTransitions: [],
    reviewAttempts: 0,
    smokeAttempts: 0,
    prClosed: false,
    sandboxTeardownDone: false,
  };

  const setStage = (
    stage: Stage,
    rationale: string,
    metadata?: Record<string, string | number | boolean | null>,
  ) => {
    status.stage = stage;
    const transition = appendEngineTransition(engineTransitions, {
      to: mapTicketStageToEngineStage(stage),
      rationale: rationale.trim().length > 0 ? rationale : defaultTicketStageRationale(stage),
      metadata: {
        workflowStage: stage,
        ...(metadata ?? {}),
      },
    });
    if (engineTransitions.length > 80) {
      engineTransitions.shift();
    }
    status.engineStage = transition.to;
    status.lastStageRationale = transition.rationale;
    status.engineTransitions = [...engineTransitions];
  };
  setStage("started", "Ticket workflow bootstrapped.");

  const wakeSignal = defineSignal<[TicketWakeSignal]>(SIGNAL_TICKET_WAKE);
  const commentSignal = defineSignal<[LinearCommentSignal]>(SIGNAL_LINEAR_COMMENT);
  const githubPrSignal = defineSignal<[GithubPrSignal]>(SIGNAL_GITHUB_PR);
  const statusQuery = defineQuery<TicketStatus>(QUERY_TICKET_STATUS);

  let wakeSeq = 0;
  const comments: LinearCommentSignal[] = [];
  const githubEvents: GithubPrSignal[] = [];
  const seenGithubDeliveries = new Set<string>();
  const seenComments = new Set<string>();

  let handoffPosted = false;
  let frontendAssessedForPr: number | undefined;
  let sandboxAttemptedForPr: number | undefined;
  let autoQaRunForPr: number | undefined;

  setHandler(wakeSignal, () => {
    wakeSeq += 1;
  });
  setHandler(commentSignal, (p) => {
    comments.push(p);
  });
  setHandler(githubPrSignal, (p) => {
    githubEvents.push(p);
  });
  setHandler(statusQuery, () => ({ ...status }));

  const issue = await meta.linearGetIssue({ issueId: args.issueId });
  let userPreferences = await meta.mem0GetUserPreferences({
    projectKey: args.project.projectKey,
  });

  if (!evaluateOnly) {
    try {
      await meta.linearEnsureInProgress({ issueId: args.issueId });
    } catch {
      // Non-fatal.
    }
  }

  const buildTaskContext = () =>
    JSON.stringify(
      {
        issueId: args.issueId,
        issueIdentifier: issue.identifier,
        stage: status.stage,
        mode: status.mode,
        resumeStage: status.resumeStage ?? null,
        reviewAttempts: status.reviewAttempts,
        smokeAttempts: status.smokeAttempts,
        prUrl: status.prUrl ?? null,
        prNumber: status.prNumber ?? null,
        repoFullName: status.repoFullName ?? null,
        prHeadBranch: status.prHeadBranch ?? null,
        prClosed: status.prClosed ?? null,
        sandboxUrl: status.sandboxUrl ?? null,
        sandboxId: status.sandboxId ?? null,
        frontendTask: status.frontendTask ?? null,
        frontendReason: status.frontendReason ?? null,
        blockedReason: status.blockedReason ?? null,
      },
      null,
      2,
    );

  const formatStatusFacts = () =>
    JSON.stringify(
      {
        mode: status.mode,
        stage: status.stage,
        frontendTask: status.frontendTask ?? "unknown",
        prUrl: status.prUrl ?? null,
        sandboxUrl: status.sandboxUrl ?? null,
        smokeAttempts: status.smokeAttempts,
        reviewAttempts: status.reviewAttempts,
        blockedReason: status.blockedReason ?? null,
      },
      null,
      2,
    );

  const postOnce = async (opts: {
    intent: string;
    draft?: string;
    triggerComment?: string;
    facts?: string;
    hiddenMarkers?: string[];
  }) => {
    if (!shouldPostTeammateUpdate(userPreferences, opts.intent)) {
      return;
    }

    const recent = await meta.linearListRecentComments({ issueId: args.issueId, first: 25 });
    const recentComments = summarizeRecentCommentsForPrompt(recent);
    const memory = await meta.mem0Search({
      projectKey: args.project.projectKey,
      issueIdentifier: issue.identifier,
      query: `${issue.identifier}: ${issue.title}\nIntent: ${opts.intent}\nTrigger: ${opts.triggerComment ?? ""}`,
      appId: "xena",
      agentId: "workflow.ticket.v2",
      runId: args.issueId,
    });
    const composed = await meta.openaiComposeTeammateReply({
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      issueDescription: issue.description,
      memory,
      recentComments,
      taskContext: buildTaskContext(),
      intent: opts.intent,
      draft: opts.draft,
      triggerComment: opts.triggerComment,
      facts: opts.facts,
      preferences: userPreferences,
    });
    const body = opts.hiddenMarkers?.length ? `${composed}\n${opts.hiddenMarkers.join("\n")}` : composed;
    await meta.linearPostComment({ issueId: args.issueId, body });
  };

  const answerQuestionWithPolicy = async (trimmedComment: string): Promise<void> => {
    const recent = await meta.linearListRecentComments({ issueId: args.issueId, first: 25 });
    const recentComments = summarizeRecentCommentsForPrompt(recent);
    const memory = await meta.mem0Search({
      projectKey: args.project.projectKey,
      issueIdentifier: issue.identifier,
      query: `${issue.identifier}: ${issue.title}\nQuestion: ${trimmedComment}`,
      appId: "xena",
      agentId: "workflow.ticket.v2",
      runId: args.issueId,
    });

    const uncertainty = await meta.openaiClassifyCommentUncertainty({
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      issueDescription: issue.description,
      memory,
      recentComments,
      stage: status.stage,
      commentBody: trimmedComment,
      preferences: userPreferences,
    });

    if (uncertainty.needsClarification) {
      const oneQuestion =
        singleQuestionText(uncertainty.clarificationQuestion) ??
        "What’s the one missing detail I need to answer that accurately?";
      await postOnce({
        intent: "clarification_request",
        draft: oneQuestion,
        triggerComment: trimmedComment,
        facts: formatStatusFacts(),
      });
      await meta.mem0Add({
        projectKey: args.project.projectKey,
        issueIdentifier: issue.identifier,
        content: `[clarification]\nComment: ${trimmedComment}\nQuestion: ${oneQuestion}`,
        type: "qa_exchange",
        intent: "clarification_request",
        stage: status.stage,
        outcome: "blocked",
        source: "workflow.ticket.v2",
        runId: args.issueId,
        agentId: "workflow.ticket.v2",
        appId: "xena",
        tags: ["qa", "clarification"],
      });
      return;
    }

    const answer = await meta.openaiAnswerComment({
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      issueDescription: issue.description,
      memory,
      recentComments,
      stage: status.stage,
      commentBody: trimmedComment,
      preferences: userPreferences,
    });
    await postOnce({
      intent: "question_answer",
      draft: answer,
      triggerComment: trimmedComment,
      facts: formatStatusFacts(),
    });
    await meta.mem0Add({
      projectKey: args.project.projectKey,
      issueIdentifier: issue.identifier,
      content: `[qa]\nQ: ${trimmedComment}\n\nA: ${answer}`,
      type: "qa_exchange",
      intent: "question_answer",
      stage: status.stage,
      outcome: "success",
      source: "workflow.ticket.v2",
      runId: args.issueId,
      agentId: "workflow.ticket.v2",
      appId: "xena",
      tags: ["qa", "answer"],
    });
  };

  const drainGithubEvents = async (): Promise<void> => {
    while (githubEvents.length > 0) {
      const ev = githubEvents.shift()!;
      if (ev.deliveryId && seenGithubDeliveries.has(ev.deliveryId)) continue;
      if (ev.deliveryId) seenGithubDeliveries.add(ev.deliveryId);

      status.prUrl = ev.prUrl || status.prUrl;
      status.prNumber = Number.isFinite(ev.prNumber) ? ev.prNumber : status.prNumber;
      status.repoFullName = ev.repositoryFullName || status.repoFullName;
      status.prHeadBranch = ev.branchName || status.prHeadBranch;

      const action = ev.action.toLowerCase();
      if (action === "closed") {
        status.prClosed = true;
        wakeSeq += 1;
        continue;
      }
      if (action === "opened" || action === "reopened" || action === "synchronize" || action === "ready_for_review") {
        status.prClosed = false;
        wakeSeq += 1;
      }
    }
  };

  const drainComments = async (): Promise<void> => {
    while (comments.length > 0) {
      const c = comments.shift()!;
      if (!c.body) continue;
      if (c.commentId && seenComments.has(c.commentId)) continue;
      if (c.commentId) seenComments.add(c.commentId);

      const trimmed = c.body.trim();
      const cmd = parseCommand(trimmed);
      if (cmd) {
        if (cmd.cmd === "help") {
          await postOnce({
            intent: "command_help",
            draft: `Ask “xena status” for a checkpoint.`,
            triggerComment: trimmed,
            facts: formatStatusFacts(),
          });
          continue;
        }

        if (cmd.cmd === "status") {
          await postOnce({
            intent: "command_status",
            draft: `Status requested.`,
            triggerComment: trimmed,
            facts: formatStatusFacts(),
          });
          continue;
        }

        if (cmd.cmd === "prefs" || cmd.cmd === "preferences") {
          const parsed = parsePreferencesCommandArgs(cmd.args);
          if (parsed.error) {
            await postOnce({
              intent: "command_preferences_invalid",
              draft: parsed.error,
              triggerComment: trimmed,
              facts: `Current profile:\n${renderUserPreferencesForPrompt(userPreferences)}`,
            });
            continue;
          }

          if (parsed.action === "show") {
            await postOnce({
              intent: "command_preferences_show",
              draft: "Current preference profile.",
              triggerComment: trimmed,
              facts: JSON.stringify(userPreferences, null, 2),
            });
            continue;
          }

          if (parsed.action === "reset") {
            userPreferences = cloneUserPreferences(DEFAULT_USER_PREFERENCES);
            await meta.mem0Add({
              projectKey: args.project.projectKey,
              issueIdentifier: issue.identifier,
              namespace: MEMORY_NAMESPACES.USER_PREFERENCES,
              content: serializeUserPreferencesForMemory(userPreferences),
              type: "preference_profile",
              intent: "preferences_reset",
              stage: status.stage,
              outcome: "updated",
              source: "workflow.ticket.v2",
              runId: args.issueId,
              agentId: "workflow.ticket.v2",
              appId: "xena",
              infer: true,
              tags: ["preferences", "reset"],
            });
            await postOnce({
              intent: "command_preferences_reset",
              draft: "Preferences reset to defaults.",
              triggerComment: trimmed,
              facts: JSON.stringify(userPreferences, null, 2),
            });
            continue;
          }

          try {
            const patchInput = JSON.parse(parsed.rawJson ?? "{}");
            const patch = parseUserPreferencesPatch(patchInput);
            userPreferences = applyUserPreferencesPatch(userPreferences, patch);
            await meta.mem0Add({
              projectKey: args.project.projectKey,
              issueIdentifier: issue.identifier,
              namespace: MEMORY_NAMESPACES.USER_PREFERENCES,
              content: serializeUserPreferencesForMemory(userPreferences),
              type: "preference_profile",
              intent: "preferences_set",
              stage: status.stage,
              outcome: "updated",
              source: "workflow.ticket.v2",
              runId: args.issueId,
              agentId: "workflow.ticket.v2",
              appId: "xena",
              infer: true,
              tags: ["preferences", "set"],
            });
            await postOnce({
              intent: "command_preferences_set",
              draft: "Preferences updated.",
              triggerComment: trimmed,
              facts: JSON.stringify(userPreferences, null, 2),
            });
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            await postOnce({
              intent: "command_preferences_invalid",
              draft: `Could not parse preference payload: ${message}`,
              triggerComment: trimmed,
              facts:
                "Usage: xena prefs set {\"tone\":\"direct\",\"updateCadence\":\"balanced\",\"maxRiskLevel\":\"high\"}",
            });
          }
          continue;
        }

        if (cmd.cmd === "stop") {
          const resumeStage: Stage = status.stage === "blocked" ? status.resumeStage ?? "started" : status.stage;
          setStage("blocked", "Paused by operator command.", {
            resumeStage,
          });
          status.blockedReason = "Paused by operator.";
          status.resumeStage = resumeStage;
          await postOnce({
            intent: "command_stop",
            draft: `Paused. Reply “xena continue” to resume.`,
            triggerComment: trimmed,
            facts: formatStatusFacts(),
          });
          continue;
        }

        if (cmd.cmd === "continue") {
          if (status.stage === "blocked") {
            const resumeStage = status.resumeStage ?? "started";
            setStage(resumeStage, `Resumed by operator command into "${resumeStage}".`);
            status.blockedReason = undefined;
            status.resumeStage = undefined;
            await postOnce({
              intent: "command_continue",
              draft: `Continuing.`,
              triggerComment: trimmed,
              facts: formatStatusFacts(),
            });
            wakeSeq += 1;
          }
          continue;
        }

        if (cmd.cmd === "evaluate") {
          if (!evaluateOnly) {
            await postOnce({
              intent: "command_evaluate_rejected_execution_mode",
              draft: `This run is already in execution mode. If you want analysis-only, unassign and ask "xena evaluate".`,
              triggerComment: trimmed,
              facts: formatStatusFacts(),
            });
            continue;
          }
          status.mode = "evaluate_only";
          setStage("evaluating", "Evaluate command enabled evaluation-only mode.");
          status.blockedReason = undefined;
          status.resumeStage = undefined;
          await postOnce({
            intent: "command_evaluate_enabled",
            draft: `Evaluation mode is on. I’ll answer and assess, but I won’t run coding or PR steps.`,
            triggerComment: trimmed,
            facts: formatStatusFacts(),
          });
          continue;
        }

        if (evaluateOnly && (cmd.cmd === "restart" || cmd.cmd === "sandbox" || cmd.cmd === "smoke")) {
          await postOnce({
            intent: "command_rejected_evaluate_only",
            draft: `I’m in evaluation mode. Assign this ticket to me to run execution steps.`,
            triggerComment: trimmed,
            facts: formatStatusFacts(),
          });
          continue;
        }

        if (cmd.cmd === "restart") {
          setStage(
            evaluateOnly ? "evaluating" : "coding",
            evaluateOnly
              ? "Restart command reset workflow into evaluating stage."
              : "Restart command reset workflow into coding stage.",
          );
          status.blockedReason = undefined;
          status.resumeStage = undefined;
          status.reviewAttempts = 0;
          status.smokeAttempts = 0;
          status.prUrl = undefined;
          status.prNumber = undefined;
          status.repoFullName = undefined;
          status.prHeadBranch = undefined;
          status.prClosed = false;
          status.sandboxId = undefined;
          status.sandboxUrl = undefined;
          status.sandboxTeardownDone = false;
          status.frontendTask = undefined;
          status.frontendReason = undefined;
          frontendAssessedForPr = undefined;
          sandboxAttemptedForPr = undefined;
          autoQaRunForPr = undefined;
          handoffPosted = false;
          await postOnce({
            intent: "command_restart",
            draft: `Restarting from scratch.`,
            triggerComment: trimmed,
            facts: formatStatusFacts(),
          });
          wakeSeq += 1;
          continue;
        }

        if (cmd.cmd === "sandbox") {
          const url = cmd.args.split(/\s+/)[0] ?? "";
          if (!/^https?:\/\//i.test(url)) {
            await postOnce({
              intent: "command_sandbox_invalid_url",
              draft: `That sandbox URL doesn’t look valid. Paste a full https:// URL.`,
              triggerComment: trimmed,
              facts: formatStatusFacts(),
            });
            continue;
          }
          status.sandboxUrl = url;
          await postOnce({
            intent: "command_sandbox_set",
            draft: `Sandbox: ${url}`,
            triggerComment: trimmed,
            facts: formatStatusFacts(),
          });
          if (status.stage === "blocked" && status.resumeStage === "waiting_sandbox") {
            setStage("waiting_sandbox", "Sandbox URL provided; resuming blocked sandbox stage.");
            status.blockedReason = undefined;
            status.resumeStage = undefined;
            wakeSeq += 1;
          }
          continue;
        }

        if (cmd.cmd === "smoke") {
          const arg = cmd.args.toLowerCase();
          if (arg.startsWith("pass")) {
            setStage("handoff", "Smoke command marked validation as passed.");
            wakeSeq += 1;
            continue;
          }
          if (arg.startsWith("fail")) {
            status.smokeAttempts += 1;
            wakeSeq += 1;
            continue;
          }
        }

        await postOnce({
          intent: "command_unknown",
          draft: `I didn’t understand that. Ask “xena status” for the current state.`,
          triggerComment: trimmed,
          facts: formatStatusFacts(),
        });
        continue;
      }

      // teammate-style status pings
      if (/^(?:@?xena)\b/i.test(trimmed) && /\b(status|progress|update)\b/i.test(trimmed)) {
        await postOnce({
          intent: "status_ping",
          draft: `Status/progress update requested.`,
          triggerComment: trimmed,
          facts: formatStatusFacts(),
        });
        continue;
      }

      // explicit smoke statements without command prefix
      if (!evaluateOnly && looksLikeSmokePass(trimmed)) {
        setStage("handoff", "Teammate smoke statement indicates pass.");
        wakeSeq += 1;
        continue;
      }
      if (!evaluateOnly && looksLikeSmokeFail(trimmed)) {
        status.smokeAttempts += 1;
        wakeSeq += 1;
        continue;
      }

      const addressedToXena = /^(?:\/xena|@xena|xena)\b/i.test(trimmed);
      const looksLikeQuestion =
        /\?\s*$/.test(trimmed) ||
        (addressedToXena &&
          /\b(what|why|how|when|where|who|can|could|would|should|please|progress|update)\b/i.test(trimmed));

      if (looksLikeQuestion) {
        await answerQuestionWithPolicy(trimmed);
      }
    }
  };

  const blockAndWait = async (opts: { reason: string; resumeStage: Stage }) => {
    setStage("blocked", opts.reason, {
      resumeStage: opts.resumeStage,
    });
    status.blockedReason = opts.reason;
    status.resumeStage = opts.resumeStage;
    await postOnce({
      intent: "blocked_notice",
      draft: `Blocked: ${opts.reason}`,
      facts: formatStatusFacts(),
    });
    while (status.stage === "blocked") {
      const start = wakeSeq;
      await condition(() => wakeSeq > start || comments.length > 0 || githubEvents.length > 0);
      await drainGithubEvents();
      await drainComments();
    }
  };

  const handleTeardownIfNeeded = async (): Promise<void> => {
    if (!status.prClosed) return;
    if (!status.sandboxId) {
      setStage("completed", "PR closed with no sandbox to teardown.");
      return;
    }
    if (status.sandboxTeardownDone) return;

    setStage("tearing_down", "PR closed; tearing down sandbox resources.");
    const td = await sandbox.sandboxTeardown({ sandboxId: status.sandboxId });
    status.sandboxTeardownDone = td.ok;
    if (td.ok) {
      await postOnce({
        intent: "sandbox_teardown_success",
        draft: `Sandbox closed for PR #${status.prNumber ?? "?"}.`,
        facts: formatStatusFacts(),
      });
    } else {
      await postOnce({
        intent: "sandbox_teardown_failed",
        draft: `Sandbox teardown failed: ${td.reason ?? "unknown error"}`,
        facts: formatStatusFacts(),
      });
    }
    setStage("completed", "Sandbox teardown flow completed.");
  };

  const maybeAssessFrontend = async (): Promise<void> => {
    if (!status.prUrl) return;
    const currentPr = status.prNumber ?? prNumberFromUrl(status.prUrl) ?? undefined;
    if (!currentPr) return;
    if (frontendAssessedForPr === currentPr) return;

    const repo = status.repoFullName ?? repoFromPrUrl(status.prUrl) ?? undefined;
    if (!repo) return;

    let changedFiles: string[] = [];
    try {
      changedFiles = await meta.ghListPrFiles({
        worktreePath: args.project.repoPath,
        repoSlug: repo,
        prNumber: currentPr,
      });
    } catch {
      // best-effort; still classify from issue text/labels.
      changedFiles = [];
    }

    const assessed = assessFrontendTask({
      labels: issue.labels,
      issueTitle: issue.title,
      issueDescription: issue.description,
      changedFiles,
    });
    status.frontendTask = assessed.frontend;
    status.frontendReason = assessed.reason;
    frontendAssessedForPr = currentPr;
  };

  const maybeProvisionSandbox = async (): Promise<void> => {
    if (!patched("v2-github-sandbox-hyperbrowser")) return;
    if (!status.prUrl) return;
    if (status.frontendTask !== true) return;

    const prNumber = status.prNumber ?? prNumberFromUrl(status.prUrl) ?? undefined;
    const repo = status.repoFullName ?? repoFromPrUrl(status.prUrl) ?? undefined;
    if (!prNumber || !repo) return;
    if (!status.prHeadBranch) return;
    if (status.sandboxUrl || status.sandboxId) return;
    if (sandboxAttemptedForPr === prNumber) return;

    sandboxAttemptedForPr = prNumber;
    setStage("waiting_sandbox", "Provisioning sandbox for frontend PR validation.", {
      prNumber,
      repository: repo,
    });

    const provision = await sandbox.sandboxProvisionFromPr({
      repoFullName: repo,
      branchName: status.prHeadBranch,
      prNumber,
    });

    if (!provision.ok) {
      if (!provision.skipped) {
        await postOnce({
          intent: "sandbox_provision_failed",
          draft: `Sandbox provisioning failed: ${provision.reason}`,
          facts: formatStatusFacts(),
        });
      }
      setStage("waiting_smoke", "Sandbox provisioning failed or skipped; continue smoke checks.");
      return;
    }

    status.sandboxId = provision.sandboxId;
    status.sandboxUrl = provision.sandboxUrl;
    status.sandboxTeardownDone = false;
    await postOnce({
      intent: "sandbox_ready",
      draft: `Sandbox ready: ${provision.sandboxUrl}`,
      facts: JSON.stringify(
        {
          sandboxUrl: provision.sandboxUrl,
          sandboxId: provision.sandboxId,
          bootMode: provision.bootMode,
          prNumber,
          repositoryFullName: repo,
        },
        null,
        2,
      ),
      hiddenMarkers: [
        buildSandboxMarker({
          sandboxId: provision.sandboxId,
          sandboxUrl: provision.sandboxUrl,
          prNumber,
          repositoryFullName: repo,
        }),
      ],
    });
    await meta.mem0Add({
      projectKey: args.project.projectKey,
      issueIdentifier: issue.identifier,
      content: `[sandbox]\nPR: ${status.prUrl}\nURL: ${provision.sandboxUrl}\nBoot mode: ${provision.bootMode}`,
      type: "workflow_artifact",
      intent: "sandbox_ready",
      stage: "waiting_sandbox",
      outcome: "success",
      source: "workflow.ticket.v2",
      runId: args.issueId,
      agentId: "workflow.ticket.v2",
      appId: "xena",
      tags: ["sandbox", "frontend"],
    });
  };

  const maybeRunAutomatedQa = async (): Promise<void> => {
    if (!patched("v2-github-sandbox-hyperbrowser")) return;
    if (!status.prUrl || !status.sandboxUrl) return;

    const prNumber = status.prNumber ?? prNumberFromUrl(status.prUrl) ?? undefined;
    if (!prNumber) return;
    if (autoQaRunForPr === prNumber) return;
    autoQaRunForPr = prNumber;

    const qaRes = await qa.hyperbrowserRunQaTask({
      url: status.sandboxUrl,
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      issueDescription: issue.description,
    });

    if (qaRes.skipped) return;

    if (qaRes.ok) {
      await postOnce({
        intent: "qa_passed",
        draft: `QA passed on sandbox.`,
        facts: JSON.stringify(
          {
            summary: qaRes.summary ?? null,
            liveUrl: qaRes.liveUrl ?? null,
            smokeAttempts: status.smokeAttempts,
          },
          null,
          2,
        ),
      });
      setStage("handoff", "Automated QA passed on sandbox.");
      return;
    }

    status.smokeAttempts += 1;
    await postOnce({
      intent: "qa_failed",
      draft: `QA failed (attempt ${status.smokeAttempts}/2).`,
      facts: JSON.stringify(
        {
          error: qaRes.error ?? null,
          summary: qaRes.summary ?? null,
          smokeAttempts: status.smokeAttempts,
          smokeLimit: 2,
        },
        null,
        2,
      ),
    });
    if (status.smokeAttempts >= 2) {
      await blockAndWait({
        reason: `Smoke failed ${status.smokeAttempts} times (2 allowed). Human review required.`,
        resumeStage: "waiting_smoke",
      });
      return;
    }

    // First smoke failure loops back to coding.
    status.prUrl = undefined;
    status.prNumber = undefined;
    status.prHeadBranch = undefined;
    status.prClosed = false;
    status.sandboxUrl = undefined;
    status.sandboxId = undefined;
    status.sandboxTeardownDone = false;
    status.frontendTask = undefined;
    status.frontendReason = undefined;
    frontendAssessedForPr = undefined;
    sandboxAttemptedForPr = undefined;
    autoQaRunForPr = undefined;
    setStage("coding", "Smoke failure threshold not reached; looping back to coding.");
  };

  try {
    // Restore known PR / sandbox context from existing ticket comments.
    const recent = await meta.linearListRecentComments({ issueId: args.issueId, first: 50 });
    for (const c of recent) {
      const prUrl = extractFirstPrUrl(c.body);
      if (prUrl) {
        status.prUrl = prUrl;
        status.prNumber = prNumberFromUrl(prUrl) ?? undefined;
        status.repoFullName = repoFromPrUrl(prUrl) ?? undefined;
      }
      const restoredSandbox = extractSandboxMarker(c.body);
      if (restoredSandbox) {
        status.sandboxId = restoredSandbox.sandboxId;
        status.sandboxUrl = restoredSandbox.sandboxUrl;
        status.prNumber = restoredSandbox.prNumber;
        status.repoFullName = restoredSandbox.repositoryFullName;
      }
    }

    if (status.prUrl) {
      setStage("waiting_smoke", "Resuming from existing PR and waiting for smoke validation.");
      await postOnce({
        intent: "resume_from_existing_pr",
        draft: `Resuming from existing PR: ${status.prUrl}`,
        facts: formatStatusFacts(),
      });
    } else {
      if (evaluateOnly) {
        setStage("evaluating", "Run started in evaluate-only mode.");
        await postOnce({
          intent: "evaluate_mode_intro",
          draft: `I’ll evaluate this ticket and answer questions. I won’t run code or PR steps until assigned.`,
          facts: formatStatusFacts(),
        });
      } else {
        await postOnce({
          intent: "ticket_take_ownership",
          draft: `I’m on this. I’ll post updates at stage transitions.`,
          facts: formatStatusFacts(),
        });
      }
    }

    if (evaluateOnly) {
      while (true) {
        const start = wakeSeq;
        await condition(() => wakeSeq > start || comments.length > 0 || githubEvents.length > 0);
        await drainGithubEvents();
        await drainComments();
      }
    }

    let existingPlan = await meta.linearFindLatestPlan({ issueId: args.issueId });
    let existingDiscovery = await meta.linearFindLatestDiscoveryOutput({ issueId: args.issueId });

    while (!existingPlan && !status.prUrl) {
      if (!existingDiscovery) {
        setStage("discovering", "No discovery output found; running discovery stage.");
        try {
          await discoverWorkflow({ issueId: args.issueId, project: args.project, playbookId: args.playbookId });
        } catch (err: any) {
          const msg = typeof err?.message === "string" ? err.message : String(err);
          await blockAndWait({ reason: `Discover failed: ${msg}`, resumeStage: "discovering" });
          continue;
        }
        existingDiscovery = await meta.linearFindLatestDiscoveryOutput({ issueId: args.issueId });
      }

      setStage("planning", "Discovery complete; generating execution plan.");
      try {
        await planWorkflow({ issueId: args.issueId, project: args.project, playbookId: args.playbookId });
      } catch (err: any) {
        const msg = typeof err?.message === "string" ? err.message : String(err);
        await blockAndWait({ reason: `Plan failed: ${msg}`, resumeStage: "planning" });
        continue;
      }

      existingPlan = await meta.linearFindLatestPlan({ issueId: args.issueId });
    }

    while (true) {
      await drainGithubEvents();
      await drainComments();
      await handleTeardownIfNeeded();

      if (status.stage === "blocked") {
        const start = wakeSeq;
        await condition(() => wakeSeq > start || comments.length > 0 || githubEvents.length > 0);
        continue;
      }

      if (status.stage === "completed") {
        if (status.sandboxId && !status.prClosed && !status.sandboxTeardownDone) {
          // Keep this workflow alive so PR close can trigger teardown.
          const start = wakeSeq;
          await Promise.race([
            condition(() => wakeSeq > start || comments.length > 0 || githubEvents.length > 0),
            sleep("24 hours"),
          ]);
          // Safety valve: if nobody closes the PR, stop the sandbox after a day.
          if (!status.prClosed) {
            status.prClosed = true;
          }
          continue;
        }
        break;
      }

      await maybeAssessFrontend();
      await maybeProvisionSandbox();
      await maybeRunAutomatedQa();

      if (status.stage === "handoff") {
        if (!handoffPosted) {
          await postOnce({
            intent: "handoff",
            draft: `Handoff.`,
            facts: JSON.stringify(
              {
                prUrl: status.prUrl ?? null,
                sandboxUrl: status.sandboxUrl ?? null,
                owner: "Mark",
                ownerProfile: "https://linear.app/kahunas/profiles/mark",
              },
              null,
              2,
            ),
          });

          handoffPosted = true;
        }
        setStage("completed", "Handoff posted; workflow completed.");
        continue;
      }

      // If we have a PR URL, prefer CI checks and avoid re-running coding.
      if (status.stage === "waiting_smoke" && status.prUrl) {
        const repoSlug =
          status.repoFullName ??
          repoFromPrUrl(status.prUrl) ??
          (await meta.gitGetOriginRepoSlug({ repoPath: args.project.repoPath }));
        const prNumber = status.prNumber ?? prNumberFromUrl(status.prUrl);
        if (prNumber) {
          status.prNumber = prNumber;
          try {
            const checks = await meta.ghGetPrChecks({
              worktreePath: args.project.repoPath,
              repoSlug,
              prNumber,
            });
            const smoke = checks.find((c) => /\bsmoke\b/i.test(c.name));
            if (smoke?.status === "COMPLETED") {
              const conc = smoke.conclusion.toUpperCase();
              if (conc === "SUCCESS") {
                setStage("handoff", "CI smoke checks succeeded.");
                continue;
              }
              if (conc === "FAILURE") {
                status.smokeAttempts += 1;
                await postOnce({
                  intent: "ci_smoke_failed",
                  draft: `CI smoke failed. Attempt ${status.smokeAttempts}/2.`,
                  facts: formatStatusFacts(),
                });
                if (status.smokeAttempts >= 2) {
                  await blockAndWait({
                    reason: `Smoke failed ${status.smokeAttempts} times (2 allowed). Human review required.`,
                    resumeStage: "waiting_smoke",
                  });
                } else {
                  status.prUrl = undefined;
                  status.prNumber = undefined;
                  status.prHeadBranch = undefined;
                  status.prClosed = false;
                  status.sandboxId = undefined;
                  status.sandboxUrl = undefined;
                  status.sandboxTeardownDone = false;
                  status.frontendTask = undefined;
                  status.frontendReason = undefined;
                  frontendAssessedForPr = undefined;
                  sandboxAttemptedForPr = undefined;
                  autoQaRunForPr = undefined;
                  setStage("coding", "CI smoke failed once; returning to coding for fixes.");
                }
              }
            }
          } catch {
            // best-effort
          }
        }
      }

      // If we resumed on a PR that didn't carry a sandbox marker, still allow manual URL detection.
      if (status.stage === "waiting_smoke" && !status.sandboxUrl) {
        const recent2 = await meta.linearListRecentComments({ issueId: args.issueId, first: 50 });
        for (const c of recent2) {
          const u = extractFirstVercelUrl(c.body);
          if (u) {
            status.sandboxUrl = u;
            break;
          }
        }
      }

      // If we already resumed from PR, wait and continue polling.
      if (status.stage === "waiting_smoke" && status.prUrl) {
        await sleep("30 seconds");
        continue;
      }

      // CODE + REVIEW
      setStage("coding", "Entering coding stage.");
      let codeRes;
      try {
        codeRes = await codeWorkflow({ issueId: args.issueId, project: args.project, playbookId: args.playbookId });
      } catch (err: any) {
        const msg = typeof err?.message === "string" ? err.message : String(err);
        await blockAndWait({ reason: `Code failed: ${msg}`, resumeStage: "coding" });
        continue;
      }
      status.reviewAttempts = codeRes.reviewAttempts ?? status.reviewAttempts;
      if (!codeRes.ok) {
        await blockAndWait({ reason: codeRes.reason, resumeStage: "coding" });
        continue;
      }

      status.worktreePath = codeRes.worktreePath;
      status.branchName = codeRes.branchName;

      // PR
      setStage("creating_pr", "Code stage completed; creating PR.");
      try {
        const repoSlug = await meta.gitGetOriginRepoSlug({ repoPath: args.project.repoPath });
        const baseBranch = await meta.gitGetDefaultBaseBranch({ repoPath: args.project.repoPath });

        await meta.gitCommitIfNeeded({
          worktreePath: codeRes.worktreePath,
          issueIdentifier: codeRes.issueIdentifier,
          issueTitle: issue.title,
        });
        await meta.gitPushBranch({ worktreePath: codeRes.worktreePath, branchName: codeRes.branchName });

        const prSummary = await meta.gitGetLastCommitSummary({ worktreePath: codeRes.worktreePath, maxFiles: 10 });

        const prUrl = await meta.ghCreatePr({
          worktreePath: codeRes.worktreePath,
          repoSlug,
          baseBranch,
          headBranch: codeRes.branchName,
          title: `${codeRes.issueIdentifier}: ${issue.title}`,
          body: `Automated changes by Xena.\n\nSummary:\n${prSummary}\n\nTicket: ${codeRes.issueIdentifier}`,
        });

        status.prUrl = prUrl;
        status.prNumber = prNumberFromUrl(prUrl) ?? undefined;
        status.repoFullName = repoFromPrUrl(prUrl) ?? repoSlug;
        status.prHeadBranch = codeRes.branchName;
        status.prClosed = false;
        status.sandboxId = undefined;
        status.sandboxUrl = undefined;
        status.sandboxTeardownDone = false;
        status.frontendTask = undefined;
        status.frontendReason = undefined;
        frontendAssessedForPr = undefined;
        sandboxAttemptedForPr = undefined;
        autoQaRunForPr = undefined;
        handoffPosted = false;

        await postOnce({
          intent: "pr_created",
          draft: `PR: ${prUrl}`,
          facts: JSON.stringify(
            {
              prUrl,
              branchName: codeRes.branchName,
              repo: status.repoFullName ?? repoSlug,
            },
            null,
            2,
          ),
        });
      } catch (err: any) {
        const msg = typeof err?.message === "string" ? err.message : String(err);
        await blockAndWait({ reason: `PR creation failed: ${msg}`, resumeStage: "creating_pr" });
        continue;
      }

      setStage("waiting_smoke", "PR created; awaiting smoke validation.");
    }
  } catch (err: any) {
    const msg = typeof err?.message === "string" ? err.message : String(err);
    setStage("failed", `Workflow failed: ${msg}`);
    status.lastError = msg;
    await meta.linearPostLongComment({ issueId: args.issueId, header: `Blocked`, body: msg });
    throw err;
  }
}
