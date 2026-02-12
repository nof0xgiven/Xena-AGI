import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
  startChild,
  workflowInfo,
} from "@temporalio/workflow";
import type { ChildWorkflowHandle } from "@temporalio/workflow";
import type * as activities from "../activities/index.js";
import type { GithubPrSignal, LinearCommentSignal, ManusEventSignal, TicketArgs, TicketWakeSignal } from "../shared.js";
import {
  QUERY_OPERATOR_STATUS,
  QUERY_TICKET_STATUS,
  SIGNAL_GITHUB_PR,
  SIGNAL_LINEAR_COMMENT,
  SIGNAL_MANUS_EVENT,
  SIGNAL_OPERATOR_CONTROL,
  SIGNAL_OPERATOR_INTENT,
  SIGNAL_TICKET_WAKE,
} from "../signals.js";
import { appendEngineTransition } from "../../operator/engineRuntime.js";
import type { EngineStage, EngineTransitionRecord, OperatorIntentType } from "../../operator/types.js";
import { discoverWorkflow } from "./discoverWorkflow.js";
import { ticketWorkflowV2Core } from "./ticketWorkflowV2Core.js";

const signalLinearComment = defineSignal<[LinearCommentSignal]>(SIGNAL_LINEAR_COMMENT);
const signalGithubPr = defineSignal<[GithubPrSignal]>(SIGNAL_GITHUB_PR);
const signalTicketWake = defineSignal<[TicketWakeSignal]>(SIGNAL_TICKET_WAKE);
const signalOperatorIntent = defineSignal<[
  {
    type: OperatorIntentType;
    topic?: string;
    objective?: string;
    sourceCommentId?: string;
    sourceBody?: string;
  },
]>(SIGNAL_OPERATOR_INTENT);
const signalOperatorControl = defineSignal<[
  {
    action: "pause" | "resume";
    reason?: string;
  },
]>(SIGNAL_OPERATOR_CONTROL);
const signalManusEvent = defineSignal<[ManusEventSignal]>(SIGNAL_MANUS_EVENT);

type MetaActivities = Pick<
  typeof activities,
  | "linearGetIssue"
  | "linearFindLatestDiscoveryOutput"
  | "linearPostComment"
  | "linearPostLongComment"
  | "mem0Add"
  | "mem0GetUserPreferences"
  | "mem0GetDecisionSignatures"
  | "registryBuildExecutionPlan"
  | "researchStart"
  | "researchFinalizeTask"
  | "telemetryAppendTrustEvent"
  | "telemetryComputeTrustSnapshot"
  | "researchRun"
>;

const meta = proxyActivities<MetaActivities>({
  startToCloseTimeout: "10 minutes",
  retry: {
    maximumAttempts: 5,
    initialInterval: "2 seconds",
    maximumInterval: "1 minute",
  },
});

const long = proxyActivities<Pick<typeof activities, "researchRun">>({
  startToCloseTimeout: "24 hours",
  heartbeatTimeout: "60 seconds",
  retry: {
    maximumAttempts: 1,
  },
});

const MAX_CONFIDENCE_LOOPBACK_ATTEMPTS = 2;
const MAX_DISCOVERY_EVIDENCE_CHARS = 2400;
const MAX_OPERATOR_COMMENT_EVIDENCE_CHARS = 900;

type OperatorStage =
  | "starting"
  | "planning"
  | "delegated"
  | "researching"
  | "paused"
  | "failed"
  | "completed";

type OperatorStatus = {
  issueId: string;
  mode: "normal" | "evaluate_only";
  stage: OperatorStage;
  engineStage: EngineStage;
  lastStageRationale?: string;
  engineTransitions: readonly EngineTransitionRecord[];
  intentType: OperatorIntentType | null;
  intentConfidence: number | null;
  delegatedCoreWorkflowId?: string;
  researchRuns: number;
  paused: boolean;
  pauseReason?: string;
  lastError?: string;
  trustScore?: number;
  trustConfidence?: number;
};

function mapOperatorStageToEngineStage(stage: OperatorStage): EngineStage {
  switch (stage) {
    case "starting":
      return "understand";
    case "planning":
      return "plan";
    case "researching":
      return "prove";
    case "delegated":
      return "execute";
    case "completed":
      return "learn";
    case "paused":
    case "failed":
      return "adapt";
    default:
      return "adapt";
  }
}

function defaultOperatorStageRationale(stage: OperatorStage): string {
  switch (stage) {
    case "starting":
      return "Operator workflow initialized.";
    case "planning":
      return "Building execution plan from registry composition.";
    case "researching":
      return "Running evidence-gathering research intent.";
    case "delegated":
      return "Delegated implementation to coding lifecycle core workflow.";
    case "paused":
      return "Execution paused and waiting for resume signal.";
    case "failed":
      return "Execution failed and requires adaptation.";
    case "completed":
      return "Execution completed and outcome is ready for learning.";
    default:
      return "Stage transition applied.";
  }
}

function parseXenaCommand(body: string | null | undefined): { cmd: string; args: string } | null {
  const t = (body ?? "").trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  let rest: string | null = null;
  if (lower.startsWith("/xena")) rest = t.slice("/xena".length).trim();
  else if (lower.startsWith("@xena")) rest = t.slice("@xena".length).trim();
  else if (lower.startsWith("xena")) rest = t.slice("xena".length).trim();
  if (rest == null) return null;
  const m = rest.match(/^(\S+)(?:\s+(.*))?$/);
  return {
    cmd: (m?.[1] ?? "help").toLowerCase(),
    args: (m?.[2] ?? "").trim(),
  };
}

function parseResearchIntentFromComment(
  sig: LinearCommentSignal,
): { type: "research"; topic: string; objective?: string; sourceCommentId?: string; sourceBody?: string } | null {
  const parsed = parseXenaCommand(sig.body);
  if (!parsed) return null;
  if (parsed.cmd !== "research" && parsed.cmd !== "brief") return null;

  const args = parsed.args.trim();
  let topic = args;
  let objective: string | undefined;

  const split = args.split("::").map((p) => p.trim());
  if (split.length >= 2) {
    topic = split[0] ?? "";
    objective = split.slice(1).join(" :: ");
  }

  topic = topic || "Ticket research brief";

  return {
    type: "research",
    topic,
    objective,
    sourceCommentId: sig.commentId,
    sourceBody: sig.body,
  };
}

function renderResearchBriefMarkdown(opts: {
  title: string;
  summary: string;
  findings: string[];
  risks: string[];
  recommendations: string[];
  openQuestions: string[];
  sources: string[];
  invalidSourceCount: number;
  parseMode: "json" | "text";
  warnings: string[];
}): string {
  const lines: string[] = [];
  lines.push(`# ${opts.title}`);
  lines.push("");
  lines.push(`Parse mode: ${opts.parseMode}`);
  if (opts.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of opts.warnings) lines.push(`- ${w}`);
  }
  lines.push("");
  lines.push("## Summary");
  lines.push(opts.summary || "No summary provided.");

  const section = (title: string, items: string[]) => {
    lines.push("");
    lines.push(`## ${title}`);
    if (items.length === 0) {
      lines.push("- None");
      return;
    }
    for (const item of items) lines.push(`- ${item}`);
  };

  section("Findings", opts.findings);
  section("Risks", opts.risks);
  section("Recommendations", opts.recommendations);
  section("Open Questions", opts.openQuestions);

  lines.push("");
  lines.push("## Sources");
  if (opts.sources.length === 0) lines.push("- None provided");
  for (const source of opts.sources) lines.push(`- ${source}`);
  if (opts.invalidSourceCount > 0) {
    lines.push(`- Invalid sources filtered: ${opts.invalidSourceCount}`);
  }

  return lines.join("\n").trim();
}

function compactEvidenceText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export async function operatorWorkflow(args: TicketArgs): Promise<void> {
  const operatorWorkflowId = workflowInfo().workflowId;
  const coreWorkflowId = `${operatorWorkflowId}:core`;

  const status: OperatorStatus = {
    issueId: args.issueId,
    mode: args.startMode ?? "normal",
    stage: "starting",
    engineStage: mapOperatorStageToEngineStage("starting"),
    lastStageRationale: undefined,
    engineTransitions: [],
    intentType: null,
    intentConfidence: null,
    delegatedCoreWorkflowId: undefined,
    researchRuns: 0,
    paused: false,
    pauseReason: undefined,
    lastError: undefined,
    trustScore: undefined,
    trustConfidence: undefined,
  };

  const pendingLinearSignals: LinearCommentSignal[] = [];
  const pendingGithubSignals: GithubPrSignal[] = [];
  const pendingWakeSignals: TicketWakeSignal[] = [];
  const pendingOperatorResearchIntents: Array<{
    type: "research";
    topic: string;
    objective?: string;
    sourceCommentId?: string;
    sourceBody?: string;
  }> = [];

  const pendingManusEvents: ManusEventSignal[] = [];

  let coreHandle: ChildWorkflowHandle<typeof ticketWorkflowV2Core> | null = null;
  let coreCompleted = false;
  let coreFailed = false;
  let coreFailureMessage = "";
  const engineTransitions: EngineTransitionRecord[] = [];

  const setStage = (
    stage: OperatorStage,
    rationale: string,
    metadata?: Record<string, string | number | boolean | null>,
  ) => {
    status.stage = stage;
    const transition = appendEngineTransition(engineTransitions, {
      to: mapOperatorStageToEngineStage(stage),
      rationale: rationale.trim().length > 0 ? rationale : defaultOperatorStageRationale(stage),
      metadata: {
        workflowStage: stage,
        ...(metadata ?? {}),
      },
    });
    if (engineTransitions.length > 50) {
      engineTransitions.shift();
    }
    status.engineStage = transition.to;
    status.lastStageRationale = transition.rationale;
    status.engineTransitions = [...engineTransitions];
  };

  setStage("starting", "Operator workflow bootstrapped and waiting for issue context.");

  const refreshTrustSnapshot = async () => {
    const snapshot = await meta.telemetryComputeTrustSnapshot({
      workflowId: operatorWorkflowId,
    });
    status.trustScore = snapshot.score;
    status.trustConfidence = snapshot.confidence;
  };

  const postTrustEvent = async (event: Parameters<typeof meta.telemetryAppendTrustEvent>[0]["event"]) => {
    const metadata = {
      ...(event.metadata ?? {}),
      operatorStage: status.stage,
      engineStage: status.engineStage,
      stageRationale: status.lastStageRationale ?? null,
    };
    await meta.telemetryAppendTrustEvent({
      workflowId: operatorWorkflowId,
      event: {
        ...event,
        metadata,
      },
    });
    await refreshTrustSnapshot();
  };

  const forwardLinearSignal = async (sig: LinearCommentSignal) => {
    if (coreHandle) {
      await coreHandle.signal(signalLinearComment, sig);
      return;
    }
    pendingLinearSignals.push(sig);
  };

  const forwardGithubSignal = async (sig: GithubPrSignal) => {
    if (coreHandle) {
      await coreHandle.signal(signalGithubPr, sig);
      return;
    }
    pendingGithubSignals.push(sig);
  };

  const forwardWakeSignal = async (sig: TicketWakeSignal) => {
    if (coreHandle) {
      await coreHandle.signal(signalTicketWake, sig);
      return;
    }
    pendingWakeSignals.push(sig);
  };

  const flushPendingSignals = async () => {
    if (!coreHandle) return;

    while (pendingLinearSignals.length > 0) {
      const next = pendingLinearSignals.shift();
      if (!next) break;
      await coreHandle.signal(signalLinearComment, next);
    }

    while (pendingGithubSignals.length > 0) {
      const next = pendingGithubSignals.shift();
      if (!next) break;
      await coreHandle.signal(signalGithubPr, next);
    }

    while (pendingWakeSignals.length > 0) {
      const next = pendingWakeSignals.shift();
      if (!next) break;
      await coreHandle.signal(signalTicketWake, next);
    }
  };

  setHandler(defineQuery<OperatorStatus>(QUERY_OPERATOR_STATUS), () => ({ ...status }));
  setHandler(defineQuery<OperatorStatus>(QUERY_TICKET_STATUS), () => ({ ...status }));

  setHandler(signalLinearComment, async (sig) => {
    const researchIntent = parseResearchIntentFromComment(sig);
    if (researchIntent) {
      pendingOperatorResearchIntents.push(researchIntent);
      return;
    }
    await forwardLinearSignal(sig);
  });

  setHandler(signalGithubPr, async (sig) => {
    await forwardGithubSignal(sig);
  });

  setHandler(signalTicketWake, async (sig) => {
    await forwardWakeSignal(sig);
  });

  setHandler(signalOperatorIntent, (sig) => {
    if (sig.type !== "research") return;
    pendingOperatorResearchIntents.push({
      type: "research",
      topic: sig.topic?.trim() || "Ticket research brief",
      objective: sig.objective?.trim() || undefined,
      sourceCommentId: sig.sourceCommentId,
      sourceBody: sig.sourceBody,
    });
  });

  setHandler(signalOperatorControl, (sig) => {
    if (sig.action === "pause") {
      status.paused = true;
      status.pauseReason = sig.reason?.trim() || "Paused by operator control signal.";
      setStage("paused", status.pauseReason);
      return;
    }
    status.paused = false;
    status.pauseReason = undefined;
    setStage(
      coreCompleted ? "completed" : "delegated",
      coreCompleted ? "Operator resumed into completed state." : "Operator resumed delegated execution state.",
    );
  });

  setHandler(signalManusEvent, (sig) => {
    pendingManusEvents.push(sig);
  });

  const issue = await meta.linearGetIssue({ issueId: args.issueId });
  const userPreferences = await meta.mem0GetUserPreferences({
    projectKey: args.project.projectKey,
  });
  const decisionSignatures = await meta.mem0GetDecisionSignatures({
    projectKey: args.project.projectKey,
    issueIdentifier: issue.identifier,
    query: `${issue.identifier}: ${issue.title}`,
    stage: "planning",
    intent: "operator_execution_plan",
  });

  /**
   * Shared research brief execution: run research, post results, persist memory, emit trust events.
   * Called from both the top-level research intent path and the inline comment-triggered research loop.
   */
  const executeResearchBrief = async (opts: {
    topic: string;
    objective: string;
    agentId: string;
  }) => {
    await meta.linearPostComment({
      issueId: args.issueId,
      body: `Running research for "${opts.topic}".`,
    });

    const run = await long.researchRun({
      issueId: args.issueId,
      issueIdentifier: issue.identifier,
      topic: opts.topic,
      objective: opts.objective,
      cwd: args.project.repoPath,
      audience: "Founder",
      sourceHints: [issue.identifier, issue.title],
      maxSources: 8,
    });

    const briefMd = renderResearchBriefMarkdown({
      title: run.brief.title ?? `Research brief: ${opts.topic}`,
      summary: run.brief.summary,
      findings: run.brief.findings,
      risks: run.brief.risks,
      recommendations: run.brief.recommendations,
      openQuestions: run.brief.openQuestions,
      sources: run.brief.sources.map((s) => s.url),
      invalidSourceCount: run.brief.invalidSources.length,
      parseMode: run.parseMode,
      warnings: run.warnings,
    });

    await meta.linearPostLongComment({
      issueId: args.issueId,
      header: "Research brief",
      body: briefMd,
    });

    await meta.mem0Add({
      projectKey: args.project.projectKey,
      issueIdentifier: issue.identifier,
      namespace: "research.findings",
      content:
        `[research]\n` +
        `Topic: ${opts.topic}\n` +
        `Summary: ${run.brief.summary}\n` +
        `Sources: ${run.brief.sources.map((s) => s.url).join(", ")}`,
      type: "research_finding",
      intent: "research_brief_completed",
      stage: "researching",
      outcome: "success",
      source: "workflow.operator",
      runId: args.issueId,
      agentId: opts.agentId,
      appId: "xena",
      infer: true,
      tags: ["research", "brief"],
    });

    if (run.brief.sources.length > 0) {
      await postTrustEvent({
        type: "research.source_verified",
        actor: "agent",
        value: Math.min(10, run.brief.sources.length),
        metadata: { parseMode: run.parseMode },
      });
    }

    if (run.brief.invalidSources.length > 0) {
      await postTrustEvent({
        type: "research.source_invalid",
        actor: "agent",
        value: Math.min(10, run.brief.invalidSources.length),
      });
    }

    await postTrustEvent({
      type: "execution.completed",
      actor: "agent",
      note: `Research brief completed for "${opts.topic}".`,
    });
  };

  try {
    setStage("planning", "Building registry-backed execution plan.");

    // requiredCapabilities are intentionally omitted: the kernel derives intent-appropriate
    // defaults from the detected intent type (coding → code.*, research → research.*).
    // This enables research intents to resolve to research agents without coding capability gates.
    const buildExecutionPlan = async (commentText: string) =>
      meta.registryBuildExecutionPlan({
        issueTitle: issue.title,
        issueDescription: issue.description ?? "",
        commentText,
        maxRiskLevel: userPreferences.maxRiskLevel,
        preferredAgentIds: userPreferences.preferredAgentIds,
        blockedAgentIds: userPreferences.blockedAgentIds,
        preferredToolIds: userPreferences.preferredToolIds,
        blockedToolIds: userPreferences.blockedToolIds,
        preferredResourceIds: userPreferences.preferredResourceIds,
        blockedResourceIds: userPreferences.blockedResourceIds,
      });

    let planningCommentText = [
      decisionSignatures.text.length > 0 ? `Decision signatures:\n${decisionSignatures.text}` : "",
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");
    let executionPlan = await buildExecutionPlan(planningCommentText);
    status.intentType = executionPlan.intent.type;
    status.intentConfidence = executionPlan.intent.confidence;

    let confidenceLoopbackAttempt = 0;
    while (
      !executionPlan.confidenceDecision.pass &&
      confidenceLoopbackAttempt < MAX_CONFIDENCE_LOOPBACK_ATTEMPTS
    ) {
      confidenceLoopbackAttempt += 1;
      const confidenceSummary = `confidence=${executionPlan.confidenceDecision.confidence.toFixed(3)} threshold=${executionPlan.confidenceDecision.threshold.toFixed(3)}`;

      await postTrustEvent({
        type: "planning.rejected",
        actor: "system",
        note: `Confidence gate loopback triggered (${confidenceSummary}).`,
        metadata: {
          loopbackAttempt: confidenceLoopbackAttempt,
          loopbackMaxAttempts: MAX_CONFIDENCE_LOOPBACK_ATTEMPTS,
          loopbackReason: "confidence_below_threshold",
        },
      });

      setStage(
        "researching",
        `Confidence below threshold; running discovery loopback attempt ${confidenceLoopbackAttempt}/${MAX_CONFIDENCE_LOOPBACK_ATTEMPTS}.`,
        {
          confidence: Number(executionPlan.confidenceDecision.confidence.toFixed(3)),
          threshold: Number(executionPlan.confidenceDecision.threshold.toFixed(3)),
          loopbackAttempt: confidenceLoopbackAttempt,
        },
      );

      await discoverWorkflow({ issueId: args.issueId, project: args.project });

      const discoveryOutput = await meta.linearFindLatestDiscoveryOutput({ issueId: args.issueId });
      const discoveryEvidence = compactEvidenceText(discoveryOutput).slice(0, MAX_DISCOVERY_EVIDENCE_CHARS);
      const operatorCommentEvidence = compactEvidenceText(
        pendingLinearSignals.map((signal) => signal.body ?? "").join("\n"),
      ).slice(0, MAX_OPERATOR_COMMENT_EVIDENCE_CHARS);

      planningCommentText = [
        decisionSignatures.text.length > 0 ? `Decision signatures:\n${decisionSignatures.text}` : "",
        `Confidence loopback attempt ${confidenceLoopbackAttempt}/${MAX_CONFIDENCE_LOOPBACK_ATTEMPTS}.`,
        discoveryEvidence.length > 0 ? `Discovery evidence:\n${discoveryEvidence}` : "",
        operatorCommentEvidence.length > 0 ? `Recent operator comments:\n${operatorCommentEvidence}` : "",
      ]
        .filter((part) => part.length > 0)
        .join("\n\n");

      setStage(
        "planning",
        `Rebuilding execution plan after confidence loopback attempt ${confidenceLoopbackAttempt}.`,
      );

      executionPlan = await buildExecutionPlan(planningCommentText);
      status.intentType = executionPlan.intent.type;
      status.intentConfidence = executionPlan.intent.confidence;
    }

    if (!executionPlan.confidenceDecision.pass) {
      const confidenceSummary = `confidence=${executionPlan.confidenceDecision.confidence.toFixed(3)} threshold=${executionPlan.confidenceDecision.threshold.toFixed(3)}`;
      await postTrustEvent({
        type: "planning.rejected",
        actor: "system",
        note: `Confidence gate blocked execution after ${confidenceLoopbackAttempt} loopback attempt(s): ${confidenceSummary}.`,
        metadata: {
          loopbackAttempt: confidenceLoopbackAttempt,
          loopbackMaxAttempts: MAX_CONFIDENCE_LOOPBACK_ATTEMPTS,
          loopbackReason: "confidence_below_threshold",
        },
      });
      throw new Error(
        `Confidence gate blocked execution after ${confidenceLoopbackAttempt} loopback attempt(s); ${confidenceSummary}.`,
      );
    }

    if (!executionPlan.validation.valid) {
      await postTrustEvent({
        type: "planning.rejected",
        actor: "system",
        note: executionPlan.validation.errors.join("; "),
      });
      throw new Error(`Operator planning validation failed: ${executionPlan.validation.errors.join("; ")}`);
    }

    await postTrustEvent({
      type: "planning.accepted",
      actor: "system",
      note: executionPlan.resolution.rationale,
      metadata: {
        selectedAgent: executionPlan.resolution.selectedAgent.id,
        intentType: executionPlan.intent.type,
      },
    });

    const resolvedIntentType = executionPlan.intent.type;
    const selectedCodingPlaybookId = executionPlan.resolution.selectedSkills[0]?.id ?? "skill.coding.lifecycle";
    const selectedResearchPlaybookId = executionPlan.resolution.selectedSkills[0]?.id ?? "skill.research.brief";

    if (resolvedIntentType === "research") {
      // ── Research execution path ──────────────────────────────────────────
      setStage("researching", `Executing research intent via resolved composition (agent=${executionPlan.resolution.selectedAgent.id}, playbook=${selectedResearchPlaybookId}).`, {
        selectedAgent: executionPlan.resolution.selectedAgent.id,
        intentType: "research",
        selectedPlaybookId: selectedResearchPlaybookId,
      });
      status.researchRuns += 1;

      if (selectedResearchPlaybookId === "skill.research.async_followup") {
        // ── Async research: start Manus task with webhook, wait for signal ──
        const topic = issue.title;
        const objective = issue.description || `Create a decision-ready brief for ${issue.identifier}: ${issue.title}`;

        await meta.linearPostComment({
          issueId: args.issueId,
          body: `Starting async research for "${topic}" (playbook: ${selectedResearchPlaybookId}).`,
        });

        const started = await meta.researchStart({
          issueId: args.issueId,
          issueIdentifier: issue.identifier,
          topic,
          objective,
          cwd: args.project.repoPath,
          audience: "Founder",
          sourceHints: [issue.identifier, issue.title],
          maxSources: 8,
          workflowId: operatorWorkflowId,
          projectKey: args.project.projectKey,
          webhookWorkflowType: "operator",
        });

        await meta.mem0Add({
          projectKey: args.project.projectKey,
          issueIdentifier: issue.identifier,
          namespace: "workflow.state",
          content: [
            "[operator_research_async_v1]",
            `status: started`,
            `task_id: ${started.taskId}`,
            `task_url: ${started.taskUrl}`,
            `topic: ${topic}`,
            `playbook: ${selectedResearchPlaybookId}`,
            `captured_at: ${new Date().toISOString()}`,
          ].join("\n"),
          type: "event",
          intent: "operator_research_started",
          stage: "researching",
          outcome: "updated",
          source: "workflow.operator",
          runId: args.issueId,
          appId: "xena",
          agentId: executionPlan.resolution.selectedAgent.id,
          infer: false,
          tags: ["research", "async"],
        });

        await meta.linearPostComment({
          issueId: args.issueId,
          body: `Research task started via Manus.\nTask ID: ${started.taskId}\nTask URL: ${started.taskUrl}\nWaiting for completion webhook.`,
        });

        // Wait for the Manus completion signal
        await condition(() => pendingManusEvents.length > 0);
        const manusEvent = pendingManusEvents.shift()!;

        const run = await meta.researchFinalizeTask({
          issueId: args.issueId,
          issueIdentifier: issue.identifier,
          topic,
          taskId: started.taskId,
          sourceHints: [issue.identifier, issue.title],
          maxSources: 8,
        });

        const briefMd = renderResearchBriefMarkdown({
          title: run.brief.title ?? `Research brief: ${topic}`,
          summary: run.brief.summary,
          findings: run.brief.findings,
          risks: run.brief.risks,
          recommendations: run.brief.recommendations,
          openQuestions: run.brief.openQuestions,
          sources: run.brief.sources.map((s) => s.url),
          invalidSourceCount: run.brief.invalidSources.length,
          parseMode: run.parseMode,
          warnings: run.warnings,
        });

        await meta.linearPostLongComment({
          issueId: args.issueId,
          header: "Research brief (async)",
          body: briefMd,
        });

        await meta.mem0Add({
          projectKey: args.project.projectKey,
          issueIdentifier: issue.identifier,
          namespace: "research.findings",
          content:
            `[research]\n` +
            `Topic: ${topic}\n` +
            `Playbook: ${selectedResearchPlaybookId}\n` +
            `Summary: ${run.brief.summary}\n` +
            `Sources: ${run.brief.sources.map((s) => s.url).join(", ")}`,
          type: "research_finding",
          intent: "research_brief_completed",
          stage: "researching",
          outcome: "success",
          source: "workflow.operator",
          runId: args.issueId,
          agentId: executionPlan.resolution.selectedAgent.id,
          appId: "xena",
          infer: true,
          tags: ["research", "async", "brief"],
        });

        if (run.brief.sources.length > 0) {
          await postTrustEvent({
            type: "research.source_verified",
            actor: "agent",
            value: Math.min(10, run.brief.sources.length),
            metadata: { parseMode: run.parseMode, playbook: selectedResearchPlaybookId },
          });
        }

        await postTrustEvent({
          type: "execution.completed",
          actor: "agent",
          note: `Async research brief completed for "${topic}" (playbook: ${selectedResearchPlaybookId}, manus event: ${manusEvent.eventType}).`,
        });
      } else {
        // ── Synchronous research brief (default) ───────────────────────────
        await executeResearchBrief({
          topic: issue.title,
          objective: issue.description || `Create a decision-ready brief for ${issue.identifier}: ${issue.title}`,
          agentId: executionPlan.resolution.selectedAgent.id,
        });
      }

      setStage("completed", "Research execution completed via resolved composition.");
    } else {
      // ── Coding execution path ────────────────────────────────────────────
      coreHandle = await startChild(ticketWorkflowV2Core, {
        workflowId: coreWorkflowId,
        args: [{ ...args, playbookId: selectedCodingPlaybookId }],
      });
      status.delegatedCoreWorkflowId = coreHandle.workflowId;
      setStage("delegated", `Delegated coding lifecycle to core workflow (agent=${executionPlan.resolution.selectedAgent.id}).`, {
        delegatedCoreWorkflowId: coreHandle.workflowId,
        selectedAgent: executionPlan.resolution.selectedAgent.id,
        selectedPlaybookId: selectedCodingPlaybookId,
      });

      await flushPendingSignals();

      const coreCompletion = coreHandle
        .result()
        .then(() => {
          coreCompleted = true;
        })
        .catch((err: unknown) => {
          coreCompleted = true;
          coreFailed = true;
          coreFailureMessage = err instanceof Error ? err.message : String(err);
        });

      while (true) {
        if (status.paused) {
          await condition(() => !status.paused || (coreCompleted && pendingOperatorResearchIntents.length === 0));
          continue;
        }

        if (!status.paused && pendingOperatorResearchIntents.length > 0) {
          const researchIntent = pendingOperatorResearchIntents.shift();
          if (researchIntent) {
            setStage("researching", `Running research brief for topic "${researchIntent.topic}".`);
            status.researchRuns += 1;

            await executeResearchBrief({
              topic: researchIntent.topic,
              objective:
                researchIntent.objective ||
                issue.description ||
                `Create a decision-ready brief for ${issue.identifier}: ${issue.title}`,
              agentId: "workflow.operator",
            });

            setStage(
              status.paused ? "paused" : "delegated",
              status.paused
                ? "Research run completed while operator is paused."
                : "Research run completed; returning to delegated execution.",
            );
            continue;
          }
        }

      if (coreCompleted && pendingOperatorResearchIntents.length === 0) {
        break;
      }

      await condition(
        () =>
          coreCompleted ||
          pendingOperatorResearchIntents.length > 0 ||
          pendingLinearSignals.length > 0 ||
          pendingGithubSignals.length > 0 ||
          pendingWakeSignals.length > 0,
      );

      await flushPendingSignals();
    }

    await coreCompletion;

    if (coreFailed) {
      setStage("failed", `Delegated core workflow failed: ${coreFailureMessage}`);
      status.lastError = coreFailureMessage;
      await postTrustEvent({
        type: "execution.failed",
        actor: "system",
        note: coreFailureMessage,
      });
      throw new Error(coreFailureMessage);
    }

      setStage("completed", "Delegated coding workflow completed successfully.");
      await postTrustEvent({
        type: "execution.completed",
        actor: "system",
        note: "Delegated coding workflow completed.",
      });
    } // end coding execution path
  } catch (err: unknown) {
    setStage("failed", "Operator workflow encountered a fatal error.");
    status.lastError = err instanceof Error ? err.message : String(err);

    await meta.linearPostLongComment({
      issueId: args.issueId,
      header: "Operator blocked",
      body: status.lastError,
    });

    await postTrustEvent({
      type: "execution.failed",
      actor: "system",
      note: status.lastError,
    });

    throw err;
  }

  // Keep completed workflows queryable for a short period so status can be fetched after completion.
  await sleep("10 seconds");
}
