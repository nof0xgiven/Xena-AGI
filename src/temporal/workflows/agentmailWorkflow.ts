import {
  condition,
  defineSignal,
  patched,
  proxyActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "../activities/index.js";
import type { AgentmailEventSignal, ManusEventSignal } from "../shared.js";
import { SIGNAL_AGENTMAIL_EVENT, SIGNAL_MANUS_EVENT } from "../signals.js";
import { isSafeSenderEmail, resolveSafeSenderList } from "../../identity/safeSenders.js";
import {
  COMMUNICATION_POLICY,
  type CommunicationErrorKind,
  type CommunicationStrategyFamily,
  type CommunicationStrategyId,
} from "./matrixPolicyConfig.js";
import { selectNextStrategy, type MatrixFailure } from "./matrixRuntime.js";

type AgentmailWorkflowArgs = {
  projectKey: string;
  repoPath?: string;
  intervalMinutes?: number;
  recipientEmail?: string;
  dryRun?: boolean;
  safeSenderEmails?: string[];
  ownerName?: string;
};

type MetaActivities = Pick<
  typeof activities,
  | "mem0DistillMemorySnapshot"
  | "agentmailSendMessageFromXena"
  | "mem0Add"
  | "mem0SearchHybridContext"
  | "mem0GetUserPreferences"
  | "openaiClassifyCommunicationIntent"
  | "openaiComposeCommunicationReply"
  | "agentmailHydrateInboundMessage"
  | "agentmailBuildTextAttachment"
  | "operatorGetTaskSnapshot"
  | "calendarHandleMeetingRequest"
  | "researchStart"
  | "researchFinalizeTask"
>;
type LongActivities = Pick<typeof activities, "researchRun">;

const meta = proxyActivities<MetaActivities>({
  startToCloseTimeout: "30 minutes",
  retry: {
    maximumAttempts: 3,
    initialInterval: "2 seconds",
    maximumInterval: "1 minute",
  },
});
const long = proxyActivities<LongActivities>({
  startToCloseTimeout: "24 hours",
  heartbeatTimeout: "60 seconds",
  retry: {
    maximumAttempts: 1,
  },
});

const signalAgentmailEvent = defineSignal<[AgentmailEventSignal]>(SIGNAL_AGENTMAIL_EVENT);
const signalManusEvent = defineSignal<[ManusEventSignal]>(SIGNAL_MANUS_EVENT);

const DEFAULT_INTERVAL_MINUTES = 720;
const MIN_INTERVAL_MINUTES = 60;
const MAX_INTERVAL_MINUTES = 10_080;

const COMMUNICATION_MAX_ATTEMPTS_TOTAL = COMMUNICATION_POLICY.maxAttemptsTotal;
const COMMUNICATION_MAX_ATTEMPTS_PER_FAMILY = COMMUNICATION_POLICY.maxAttemptsPerFamily;
const COMMUNICATION_STRATEGIES = COMMUNICATION_POLICY.strategies;
const COMMUNICATION_MATRIX = COMMUNICATION_POLICY.matrix;
const COMMUNICATION_FORCE_SWITCH_ERRORS = COMMUNICATION_POLICY.forceFamilySwitchErrorKinds;

type CommunicationFailure = MatrixFailure<
  CommunicationStrategyId,
  CommunicationStrategyFamily,
  CommunicationErrorKind
>;

type OutboundAttachment = {
  filename?: string;
  contentType?: string;
  contentDisposition?: "inline" | "attachment";
  contentId?: string;
  contentBase64?: string;
  text?: string;
  url?: string;
};

type CommunicationIntent = Awaited<ReturnType<MetaActivities["openaiClassifyCommunicationIntent"]>>["intent"];

type CommunicationExecutionResult =
  | {
      ok: true;
      intent: CommunicationIntent;
      confidence: number;
      replySubject: string;
      replyBody: string;
      attachments: OutboundAttachment[];
      strategyReason: string;
    }
  | {
      ok: false;
      intent: CommunicationIntent;
      confidence: number;
      errorKind: CommunicationErrorKind;
      errorMessage: string;
      strategyReason: string;
    };

type SuccessfulCommunicationExecution = Extract<CommunicationExecutionResult, { ok: true }>;

type UserPreferenceProfile = Awaited<ReturnType<MetaActivities["mem0GetUserPreferences"]>>;

type PendingResearchTask = {
  runId: string;
  taskId: string;
  taskUrl: string;
  replyMessageId?: string;
  fromEmail: string;
  effectiveSubject: string;
  inboundBody: string;
  memoryText: string;
  userPreferences: UserPreferenceProfile;
  topic: string;
  objective: string;
  confidence: number;
};

function normalizeIntervalMinutes(value: number | undefined): number {
  if (value === 0) return 0;
  if (!Number.isFinite(value) || value === undefined) return DEFAULT_INTERVAL_MINUTES;
  const normalized = Math.floor(value);
  if (normalized === 0) return 0;
  if (normalized < MIN_INTERVAL_MINUTES) return MIN_INTERVAL_MINUTES;
  if (normalized > MAX_INTERVAL_MINUTES) return MAX_INTERVAL_MINUTES;
  return normalized;
}

function buildSubject(projectKey: string, tickIso: string): string {
  return `[Xena] ${projectKey} check-in (${tickIso.slice(0, 10)})`;
}

function intervalMs(minutes: number): number {
  return minutes * 60 * 1000;
}

function compact(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function buildResearchSummary(research: Awaited<ReturnType<LongActivities["researchRun"]>>): string {
  const findings = research.brief.findings.slice(0, 4).map((item) => `- ${item}`);
  const risks = research.brief.risks.slice(0, 3).map((item) => `- ${item}`);
  const recommendations = research.brief.recommendations.slice(0, 3).map((item) => `- ${item}`);

  return [
    `Summary: ${research.brief.summary}`,
    findings.length > 0 ? `Findings:\n${findings.join("\n")}` : null,
    risks.length > 0 ? `Risks:\n${risks.join("\n")}` : null,
    recommendations.length > 0 ? `Recommendations:\n${recommendations.join("\n")}` : null,
    research.brief.sources.length > 0
      ? `Sources:\n${research.brief.sources.slice(0, 6).map((source) => `- ${source.url}`).join("\n")}`
      : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n\n");
}

function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err && typeof (err as any).message === "string") {
    return (err as any).message;
  }
  return String(err);
}

function classifyCommunicationError(err: unknown): CommunicationErrorKind {
  const msg = errorMessage(err).toLowerCase();
  if (msg.includes("rate limit") || msg.includes("too many requests")) return "rate_limited";
  if (msg.includes("timeout") || msg.includes("timed out")) return "timeout";
  if (msg.includes("unauthorized") || msg.includes("forbidden") || msg.includes("permission")) return "auth_or_permission";
  if (msg.includes("model") && msg.includes("unavailable")) return "model_unavailable";
  if (msg.includes("token") && msg.includes("limit")) return "token_limit";
  if (msg.includes("communication_intent_parse_failed") || msg.includes("json") || msg.includes("parse")) {
    return "invalid_output";
  }
  if (msg.includes("bad request") || msg.includes("status 400")) return "provider_bad_request";
  if (msg.includes("attachment")) return "attachment_unavailable";
  if (msg.includes("research")) return "research_failed";
  return "unknown";
}

function selectInitialCommunicationStrategy(attachmentCount: number): CommunicationStrategyId {
  return attachmentCount > 0 ? "email-attachment-aware" : "email-semantic";
}

const DEFAULT_COMMUNICATION_PLAYBOOK_ID = "skill.operator.status_snapshot";

function resolveCommunicationPlaybookId(
  intent: CommunicationIntent,
  useAsyncResearch: boolean,
): string {
  if (intent === "research_request") {
    return useAsyncResearch ? "skill.research.async_followup" : "skill.research.brief";
  }
  if (intent === "meeting_request") {
    return "skill.operator.calendar_management";
  }
  if (intent === "task_status_request" || intent === "status_update_request") {
    return "skill.operator.status_snapshot";
  }
  return DEFAULT_COMMUNICATION_PLAYBOOK_ID;
}

function buildAttachmentContext(
  hydrated: Awaited<ReturnType<MetaActivities["agentmailHydrateInboundMessage"]>>,
): string {
  const rows: string[] = [];
  if (hydrated.attachments.length === 0) return "attachments: none";
  rows.push(`attachments_count: ${hydrated.attachments.length}`);
  if (hydrated.attachmentSummary) rows.push(hydrated.attachmentSummary);
  for (const attachment of hydrated.attachments) {
    if (!attachment.inlineText) continue;
    rows.push("");
    rows.push(`attachment_text (${attachment.filename ?? attachment.attachmentId}):`);
    rows.push(attachment.inlineText);
  }
  return rows.join("\n").trim();
}

export async function agentmailWorkflow(args: AgentmailWorkflowArgs): Promise<void> {
  const workflowId = workflowInfo().workflowId;
  const intervalMinutes = normalizeIntervalMinutes(args.intervalMinutes);
  const issueIdentifier = `EMAIL-${args.projectKey.toUpperCase()}`;
  const dryRun = args.dryRun === true;
  const safeSenderEmails = resolveSafeSenderList(args.safeSenderEmails);
  const ownerNamePattern = args.ownerName
    ? new RegExp(`\\b${args.ownerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")
    : null;
  const pendingEvents: AgentmailEventSignal[] = [];
  const pendingManusEvents: ManusEventSignal[] = [];
  const pendingResearchTasks = new Map<string, PendingResearchTask>();
  const useCommunicationMatrix = patched("agentmail-communication-matrix-v1");
  const useManusWebhookResearch = patched("agentmail-manus-webhook-research-v1");

  setHandler(signalAgentmailEvent, (sig) => {
    pendingEvents.push(sig);
  });
  setHandler(signalManusEvent, (sig) => {
    pendingManusEvents.push(sig);
  });

  const runPeriodicDigestTick = async (): Promise<void> => {
    const tickIso = new Date(Date.now()).toISOString();
    const runId = `${workflowId}:${tickIso}`;
    const selectedPlaybookId = DEFAULT_COMMUNICATION_PLAYBOOK_ID;

    try {
      const distill = await meta.mem0DistillMemorySnapshot({
        projectKey: args.projectKey,
        issueIdentifier,
        query: `${args.projectKey} priorities and active memory signals`,
        stage: "communication",
        intent: "agentmail_periodic_summary",
        runId,
      });

      const body = [
        "Personal operator check-in.",
        "",
        distill.summary || "No memory summary available yet.",
        "",
        "Reply with priorities or constraints for the next cycle.",
        "",
        "- Xena",
      ].join("\n");

      const sent = await meta.agentmailSendMessageFromXena({
        projectKey: args.projectKey,
        subject: buildSubject(args.projectKey, tickIso),
        body,
        to: args.recipientEmail,
        dryRun,
      });

      await meta.mem0Add({
        projectKey: args.projectKey,
        issueIdentifier,
        namespace: "workflow.state",
        content: [
          "[agentmail_tick_v1]",
          `workflow_id: ${workflowId}`,
          `project: ${args.projectKey}`,
          `interval_minutes: ${intervalMinutes}`,
          `dry_run: ${dryRun}`,
          `sent: ${sent.sent}`,
          `reason: ${sent.reason ?? "ok"}`,
          `inbox_id: ${sent.inboxId ?? "n/a"}`,
          `message_id: ${sent.messageId ?? "n/a"}`,
          `tick_at: ${tickIso}`,
        ].join("\n"),
        type: "event",
        intent: sent.sent ? "agentmail_tick_sent" : "agentmail_tick_skipped",
        stage: "communication",
        outcome: sent.sent ? "success" : "blocked",
        source: "workflow.agentmail",
        runId,
        appId: "xena",
        agentId: "workflow.agentmail",
        playbookId: selectedPlaybookId,
        infer: false,
        enableGraph: false,
        tags: ["agentmail", "communication", sent.sent ? "sent" : "skipped"],
      });
    } catch (err) {
      const msg = errorMessage(err);
      await meta.mem0Add({
        projectKey: args.projectKey,
        issueIdentifier,
        namespace: "workflow.state",
        content: [
          "[agentmail_tick_v1]",
          `workflow_id: ${workflowId}`,
          `project: ${args.projectKey}`,
          `interval_minutes: ${intervalMinutes}`,
          `dry_run: ${dryRun}`,
          `error: ${msg}`,
          `tick_at: ${tickIso}`,
        ].join("\n"),
        type: "event",
        intent: "agentmail_tick_failed",
        stage: "communication",
        outcome: "failed",
        source: "workflow.agentmail",
        runId,
        appId: "xena",
        agentId: "workflow.agentmail",
        playbookId: selectedPlaybookId,
        infer: false,
        enableGraph: false,
        tags: ["agentmail", "communication", "failed"],
      });
    }
  };

  const processIncomingEventLegacy = async (event: AgentmailEventSignal): Promise<void> => {
    const tickIso = new Date(Date.now()).toISOString();
    const runId = `${workflowId}:event:${event.messageId ?? event.deliveryId ?? tickIso}`;
    const selectedPlaybookId = DEFAULT_COMMUNICATION_PLAYBOOK_ID;
    const eventType = compact(event.eventType);
    const fromEmail = compact(event.fromEmail);
    const subject = compact(event.subject);
    const text = compact(event.text);

    if (eventType !== "message.received") {
      await meta.mem0Add({
        projectKey: args.projectKey,
        issueIdentifier,
        namespace: "workflow.state",
        content: [
          "[agentmail_event_v1]",
          `event_type: ${eventType || "unknown"}`,
          `message_id: ${event.messageId ?? "n/a"}`,
          `inbox_id: ${event.inboxId ?? "n/a"}`,
          "action: ignored_non_message_event",
          `captured_at: ${tickIso}`,
        ].join("\n"),
        type: "event",
        intent: "agentmail_event_ignored",
        stage: "communication",
        outcome: "updated",
        source: "workflow.agentmail",
        runId,
        appId: "xena",
        agentId: "workflow.agentmail",
        playbookId: selectedPlaybookId,
        infer: false,
        enableGraph: false,
        tags: ["agentmail", "inbound", "ignored"],
      });
      return;
    }

    if (!fromEmail) {
      await meta.mem0Add({
        projectKey: args.projectKey,
        issueIdentifier,
        namespace: "workflow.state",
        content: [
          "[agentmail_event_v1]",
          `event_type: ${eventType}`,
          `message_id: ${event.messageId ?? "n/a"}`,
          "action: skipped_missing_sender",
          `captured_at: ${tickIso}`,
        ].join("\n"),
        type: "event",
        intent: "agentmail_event_skipped",
        stage: "communication",
        outcome: "blocked",
        source: "workflow.agentmail",
        runId,
        appId: "xena",
        agentId: "workflow.agentmail",
        infer: false,
        enableGraph: false,
        tags: ["agentmail", "inbound", "skipped"],
      });
      return;
    }

    if (!isSafeSenderEmail(fromEmail, safeSenderEmails)) {
      const claimedByName = ownerNamePattern ? ownerNamePattern.test(compact(event.fromName)) : false;
      await meta.mem0Add({
        projectKey: args.projectKey,
        issueIdentifier,
        namespace: "workflow.state",
        content: [
          "[agentmail_event_v1]",
          `event_type: ${eventType}`,
          `message_id: ${event.messageId ?? "n/a"}`,
          `from_email: ${fromEmail}`,
          `from_name: ${compact(event.fromName) || "n/a"}`,
          `claimed_identity_owner: ${claimedByName}`,
          "action: ignored_unsafe_sender",
          `allowed_senders: ${safeSenderEmails.join(", ")}`,
          `captured_at: ${tickIso}`,
        ].join("\n"),
        type: "event",
        intent: "agentmail_sender_ignored",
        stage: "communication",
        outcome: "blocked",
        source: "workflow.agentmail",
        runId,
        appId: "xena",
        agentId: "workflow.agentmail",
        infer: false,
        enableGraph: false,
        tags: ["agentmail", "inbound", "ignored", "unsafe_sender"],
      });
      return;
    }

    const userPreferences = await meta.mem0GetUserPreferences({
      projectKey: args.projectKey,
    });
    const memory = await meta.mem0SearchHybridContext({
      projectKey: args.projectKey,
      issueIdentifier,
      query: `${subject}\n${text}`.trim() || "inbound email request",
      stage: "communication",
      intent: "agentmail_inbound",
      appId: "xena",
      agentId: "workflow.agentmail",
      runId,
      maxPacks: 12,
      maxTokens: 1800,
    });
    const intent = await meta.openaiClassifyCommunicationIntent({
      channel: "email",
      from: fromEmail,
      subject,
      body: text || subject || "No body provided.",
      memory: memory.text,
      preferences: userPreferences,
    });

    if (intent.needsClarification || intent.confidence < 0.62) {
      const clarification = intent.clarificationQuestion ?? "Can you clarify the exact outcome you want me to deliver?";
      const reply = await meta.openaiComposeCommunicationReply({
        channel: "email",
        from: fromEmail,
        subject,
        body: text || subject || "",
        intent: intent.intent,
        memory: memory.text,
        clarificationQuestion: clarification,
        preferences: userPreferences,
      });
      const sent = await meta.agentmailSendMessageFromXena({
        projectKey: args.projectKey,
        subject: `Re: ${subject || "Clarification needed"}`,
        body: reply,
        to: [fromEmail],
        replyToMessageId: event.messageId,
        dryRun,
      });
      await meta.mem0Add({
        projectKey: args.projectKey,
        issueIdentifier,
        namespace: "workflow.state",
        content: [
          "[agentmail_event_v1]",
          `event_type: ${eventType}`,
          `message_id: ${event.messageId ?? "n/a"}`,
          `from: ${fromEmail}`,
          `intent: ${intent.intent}`,
          `confidence: ${intent.confidence.toFixed(3)}`,
          `clarification_question: ${clarification}`,
          `reply_sent: ${sent.sent}`,
          `reply_reason: ${sent.reason ?? "ok"}`,
          `captured_at: ${tickIso}`,
        ].join("\n"),
        type: "event",
        intent: "agentmail_clarification_sent",
        stage: "communication",
        outcome: sent.sent ? "updated" : "blocked",
        source: "workflow.agentmail",
        runId,
        appId: "xena",
        agentId: "workflow.agentmail",
        infer: false,
        enableGraph: false,
        tags: ["agentmail", "inbound", "clarification"],
      });
      return;
    }

    if (intent.intent === "research_request" && args.repoPath) {
      const research = await long.researchRun({
        issueId: runId,
        issueIdentifier,
        topic: (intent.topic ?? subject) || "Inbound research request",
        objective: (intent.objective ?? text ?? subject) || "Research request received by email.",
        cwd: args.repoPath,
        audience: fromEmail,
      });
      const researchSummary = buildResearchSummary(research);
      const reply = await meta.openaiComposeCommunicationReply({
        channel: "email",
        from: fromEmail,
        subject,
        body: text || subject || "",
        intent: intent.intent,
        memory: memory.text,
        preferences: userPreferences,
        facts: researchSummary,
      });
      const sent = await meta.agentmailSendMessageFromXena({
        projectKey: args.projectKey,
        subject: `Re: ${subject || "Research update"}`,
        body: reply,
        to: [fromEmail],
        replyToMessageId: event.messageId,
        dryRun,
      });
      await meta.mem0Add({
        projectKey: args.projectKey,
        issueIdentifier,
        namespace: "research.findings",
        content: [
          "[agentmail_research_v1]",
          `from: ${fromEmail}`,
          `subject: ${subject || "(none)"}`,
          `topic: ${(intent.topic ?? subject) || "inbound research request"}`,
          researchSummary,
        ].join("\n"),
        type: "research_finding",
        intent: "agentmail_research_completed",
        stage: "communication",
        outcome: sent.sent ? "success" : "blocked",
        source: "workflow.agentmail",
        runId,
        appId: "xena",
        agentId: "workflow.agentmail",
        infer: false,
        enableGraph: false,
        tags: ["agentmail", "research", sent.sent ? "replied" : "reply_failed"],
      });
      return;
    }

    let facts: string;
    let directReply: string | null = null;
    if (intent.intent === "digest_request") {
      facts = `Digest cadence is currently ${intervalMinutes} minutes.`;
    } else if (intent.intent === "meeting_request") {
      const calendarResult = await meta.calendarHandleMeetingRequest({
        subject,
        body: text || subject || "",
        fromEmail,
      });
      if (calendarResult.outcome === "clarification") {
        directReply = calendarResult.clarificationQuestion;
        facts = `Calendar clarification required: ${calendarResult.clarificationQuestion}`;
      } else {
        directReply = calendarResult.summary;
        facts = calendarResult.summary;
      }
    } else if (intent.intent === "task_status_request" || intent.intent === "status_update_request") {
      const snapshot = await meta.operatorGetTaskSnapshot({
        projectKey: args.projectKey,
        maxTemporalTasks: 12,
        maxLinearTasks: 12,
      });
      facts = snapshot.summary;
    } else {
      facts =
        "Execution context is available; if you want action now, specify the exact deliverable, constraints, and deadline.";
    }
    const reply =
      directReply ??
      (await meta.openaiComposeCommunicationReply({
        channel: "email",
        from: fromEmail,
        subject,
        body: text || subject || "",
        intent: intent.intent,
        memory: memory.text,
        preferences: userPreferences,
        facts,
      }));
    const sent = await meta.agentmailSendMessageFromXena({
      projectKey: args.projectKey,
      subject: `Re: ${subject || "Update"}`,
      body: reply,
      to: [fromEmail],
      replyToMessageId: event.messageId,
      dryRun,
    });
    await meta.mem0Add({
      projectKey: args.projectKey,
      issueIdentifier,
      namespace: "workflow.state",
      content: [
        "[agentmail_event_v1]",
        `event_type: ${eventType}`,
        `message_id: ${event.messageId ?? "n/a"}`,
        `from: ${fromEmail}`,
        `intent: ${intent.intent}`,
        `confidence: ${intent.confidence.toFixed(3)}`,
        `reply_sent: ${sent.sent}`,
        `reply_reason: ${sent.reason ?? "ok"}`,
        `captured_at: ${tickIso}`,
      ].join("\n"),
      type: "event",
      intent: sent.sent ? "agentmail_inbound_replied" : "agentmail_inbound_blocked",
      stage: "communication",
      outcome: sent.sent ? "updated" : "blocked",
      source: "workflow.agentmail",
      runId,
      appId: "xena",
      agentId: "workflow.agentmail",
      playbookId: selectedPlaybookId,
      infer: false,
      enableGraph: false,
      tags: ["agentmail", "inbound", intent.intent, sent.sent ? "replied" : "blocked"],
    });
  };

  const processIncomingEventMatrix = async (event: AgentmailEventSignal): Promise<void> => {
    const tickIso = new Date(Date.now()).toISOString();
    const runId = `${workflowId}:event:${event.messageId ?? event.deliveryId ?? tickIso}`;
    const eventType = compact(event.eventType);
    const fromEmail = compact(event.fromEmail);
    const subject = compact(event.subject);
    const text = compact(event.text ?? event.extractedText);

    if (eventType !== "message.received") {
      await meta.mem0Add({
        projectKey: args.projectKey,
        issueIdentifier,
        namespace: "workflow.state",
        content: [
          "[agentmail_event_v2]",
          "selector: matrix",
          `event_type: ${eventType || "unknown"}`,
          `message_id: ${event.messageId ?? "n/a"}`,
          `inbox_id: ${event.inboxId ?? "n/a"}`,
          "action: ignored_non_message_event",
          `captured_at: ${tickIso}`,
        ].join("\n"),
        type: "event",
        intent: "agentmail_event_ignored",
        stage: "communication",
        outcome: "updated",
        source: "workflow.agentmail",
        runId,
        appId: "xena",
        agentId: "workflow.agentmail",
        infer: false,
        enableGraph: false,
        tags: ["agentmail", "inbound", "ignored", "matrix"],
      });
      return;
    }

    if (!fromEmail) {
      await meta.mem0Add({
        projectKey: args.projectKey,
        issueIdentifier,
        namespace: "workflow.state",
        content: [
          "[agentmail_event_v2]",
          "selector: matrix",
          `event_type: ${eventType}`,
          `message_id: ${event.messageId ?? "n/a"}`,
          "action: skipped_missing_sender",
          `captured_at: ${tickIso}`,
        ].join("\n"),
        type: "event",
        intent: "agentmail_event_skipped",
        stage: "communication",
        outcome: "blocked",
        source: "workflow.agentmail",
        runId,
        appId: "xena",
        agentId: "workflow.agentmail",
        infer: false,
        enableGraph: false,
        tags: ["agentmail", "inbound", "skipped", "matrix"],
      });
      return;
    }

    if (!isSafeSenderEmail(fromEmail, safeSenderEmails)) {
      const claimedByName = ownerNamePattern ? ownerNamePattern.test(compact(event.fromName)) : false;
      await meta.mem0Add({
        projectKey: args.projectKey,
        issueIdentifier,
        namespace: "workflow.state",
        content: [
          "[agentmail_event_v2]",
          "selector: matrix",
          `event_type: ${eventType}`,
          `message_id: ${event.messageId ?? "n/a"}`,
          `from_email: ${fromEmail}`,
          `from_name: ${compact(event.fromName) || "n/a"}`,
          `claimed_identity_owner: ${claimedByName}`,
          "action: ignored_unsafe_sender",
          `allowed_senders: ${safeSenderEmails.join(", ")}`,
          `captured_at: ${tickIso}`,
        ].join("\n"),
        type: "event",
        intent: "agentmail_sender_ignored",
        stage: "communication",
        outcome: "blocked",
        source: "workflow.agentmail",
        runId,
        appId: "xena",
        agentId: "workflow.agentmail",
        infer: false,
        enableGraph: false,
        tags: ["agentmail", "inbound", "ignored", "unsafe_sender", "matrix"],
      });
      return;
    }

    const hydrated = await meta.agentmailHydrateInboundMessage({
      projectKey: args.projectKey,
      inboxId: event.inboxId,
      messageId: event.messageId,
      signalSubject: subject || undefined,
      signalText: text || undefined,
      signalHtml: event.html,
      signalExtractedText: event.extractedText,
      signalExtractedHtml: event.extractedHtml,
      signalFrom: event.fromRaw ?? event.fromEmail,
      signalAttachments: event.attachments,
      maxAttachments: 6,
      maxInlineBytes: 350_000,
      maxInlineChars: 6_000,
    });

    const effectiveSubject = compact(hydrated.subject) || subject;
    const inboundBody =
      compact(hydrated.extractedText) || compact(hydrated.text) || text || effectiveSubject || "No body provided.";
    const attachmentContext = buildAttachmentContext(hydrated);

    const userPreferences = await meta.mem0GetUserPreferences({
      projectKey: args.projectKey,
    });
    const memory = await meta.mem0SearchHybridContext({
      projectKey: args.projectKey,
      issueIdentifier,
      query: `${effectiveSubject}\n${inboundBody}\n${attachmentContext}`.trim() || "inbound email request",
      stage: "communication",
      intent: "agentmail_inbound",
      appId: "xena",
      agentId: "workflow.agentmail",
      runId,
      maxPacks: 12,
      maxTokens: 2000,
    });

    const runSemanticStrategy = async (
      strategyId: Extract<CommunicationStrategyId, "email-semantic" | "email-attachment-aware">,
    ): Promise<CommunicationExecutionResult> => {
      const intent = await meta.openaiClassifyCommunicationIntent({
        channel: "email",
        from: fromEmail,
        subject: effectiveSubject,
        body: inboundBody,
        memory: memory.text,
        attachmentContext,
        preferences: userPreferences,
      });

      const allowDirectTaskSnapshot =
        (intent.intent === "task_status_request" || intent.intent === "status_update_request") &&
        intent.confidence >= 0.7;

      if ((intent.needsClarification && !allowDirectTaskSnapshot) || intent.confidence < 0.62 || intent.intent === "unknown") {
        return {
          ok: false,
          intent: intent.intent,
          confidence: intent.confidence,
          errorKind: "low_confidence",
          errorMessage:
            intent.clarificationQuestion ?? "Confidence too low to execute safely with semantic strategy.",
          strategyReason: "semantic_low_confidence",
        };
      }

      let facts =
        intent.intent === "digest_request"
          ? `Digest cadence is currently ${intervalMinutes} minutes.`
          : "No additional execution facts were required for this response.";
      const attachments: OutboundAttachment[] = [];

      if (intent.intent === "meeting_request") {
        const calendarResult = await meta.calendarHandleMeetingRequest({
          subject: effectiveSubject,
          body: inboundBody,
          fromEmail,
        });
        return {
          ok: true,
          intent: intent.intent,
          confidence: intent.confidence,
          replySubject: `Re: ${effectiveSubject || "Meeting update"}`,
          replyBody:
            calendarResult.outcome === "clarification"
              ? calendarResult.clarificationQuestion
              : calendarResult.summary,
          attachments,
          strategyReason: `calendar_meeting_request:${calendarResult.outcome}`,
        };
      }

      if (intent.intent === "attachment_request") {
        if (hydrated.attachments.length === 0) {
          return {
            ok: false,
            intent: intent.intent,
            confidence: intent.confidence,
            errorKind: "attachment_unavailable",
            errorMessage: "Attachment request detected but no attachment payload was available.",
            strategyReason: "attachment_request_without_payload",
          };
        }
        facts = [
          "Received attachments from inbound email.",
          attachmentContext,
          "Use the attachment context when answering and propose concrete next action.",
        ].join("\n\n");
        const attachmentDigest = await meta.agentmailBuildTextAttachment({
          filename: `xena-attachment-notes-${tickIso.slice(0, 10)}.md`,
          text: [
            `subject: ${effectiveSubject || "(none)"}`,
            `from: ${fromEmail}`,
            "",
            attachmentContext,
          ].join("\n"),
          contentType: "text/markdown; charset=utf-8",
        });
        if (attachmentDigest) attachments.push(attachmentDigest);
      }

      if (intent.intent === "research_request") {
        if (!args.repoPath) {
          return {
            ok: false,
            intent: intent.intent,
            confidence: intent.confidence,
            errorKind: "research_failed",
            errorMessage: "Research request received but repository path is not configured.",
            strategyReason: "research_repo_missing",
          };
        }
        try {
          const topic = (intent.topic ?? effectiveSubject) || "Inbound research request";
          const objective =
            (intent.objective ?? inboundBody) ||
            "Research request received by email; respond with findings and cited sources.";

          if (useManusWebhookResearch) {
            const started = await meta.researchStart({
              issueId: runId,
              issueIdentifier,
              topic,
              objective,
              cwd: args.repoPath,
              audience: fromEmail,
              sourceHints: [effectiveSubject, fromEmail].filter((value) => value.length > 0),
              workflowId,
              projectKey: args.projectKey,
              webhookWorkflowType: "agentmail",
            });

            pendingResearchTasks.set(started.taskId, {
              runId,
              taskId: started.taskId,
              taskUrl: started.taskUrl,
              replyMessageId: event.messageId,
              fromEmail,
              effectiveSubject,
              inboundBody,
              memoryText: memory.text,
              userPreferences,
              topic,
              objective,
              confidence: intent.confidence,
            });

            facts = [
              "Research task started through Manus.",
              `Task ID: ${started.taskId}`,
              `Task URL: ${started.taskUrl}`,
              "I will follow up with completed findings as soon as Manus finishes.",
            ].join("\n");

            await meta.mem0Add({
              projectKey: args.projectKey,
              issueIdentifier,
              namespace: "workflow.state",
              content: [
                "[agentmail_research_async_v1]",
                `status: started`,
                `task_id: ${started.taskId}`,
                `task_url: ${started.taskUrl}`,
                `topic: ${topic}`,
                `from: ${fromEmail}`,
                `subject: ${effectiveSubject || "(none)"}`,
                `captured_at: ${tickIso}`,
              ].join("\n"),
              type: "event",
              intent: "agentmail_research_started",
              stage: "communication",
              outcome: "updated",
              source: "workflow.agentmail",
              runId,
              appId: "xena",
              agentId: "workflow.agentmail",
              infer: false,
              enableGraph: false,
              tags: ["agentmail", "research", "matrix", "started"],
              confidence: intent.confidence,
            });
          } else {
            const research = await long.researchRun({
              issueId: runId,
              issueIdentifier,
              topic,
              objective,
              cwd: args.repoPath,
              audience: fromEmail,
            });
            const researchSummary = buildResearchSummary(research);
            facts = researchSummary;
            const researchAttachment = await meta.agentmailBuildTextAttachment({
              filename: `xena-research-${tickIso.slice(0, 10)}.md`,
              text: researchSummary,
              contentType: "text/markdown; charset=utf-8",
            });
            if (researchAttachment) attachments.push(researchAttachment);
            await meta.mem0Add({
              projectKey: args.projectKey,
              issueIdentifier,
              namespace: "research.findings",
              content: [
                "[agentmail_research_v2]",
                `from: ${fromEmail}`,
                `subject: ${effectiveSubject || "(none)"}`,
                `topic: ${topic}`,
                researchSummary,
              ].join("\n"),
              type: "research_finding",
              intent: "agentmail_research_completed",
              stage: "communication",
              outcome: "success",
              source: "workflow.agentmail",
              runId,
              appId: "xena",
              agentId: "workflow.agentmail",
              infer: false,
              enableGraph: false,
              tags: ["agentmail", "research", "matrix", "completed"],
            });
          }
        } catch (err) {
          return {
            ok: false,
            intent: intent.intent,
            confidence: intent.confidence,
            errorKind: "research_failed",
            errorMessage: errorMessage(err),
            strategyReason: "research_execution_failed",
          };
        }
      }

      if (intent.intent === "task_status_request" || intent.intent === "status_update_request") {
        const snapshot = await meta.operatorGetTaskSnapshot({
          projectKey: args.projectKey,
          maxTemporalTasks: 12,
          maxLinearTasks: 12,
        });
        facts = snapshot.summary;
      }

      const reply = await meta.openaiComposeCommunicationReply({
        channel: "email",
        from: fromEmail,
        subject: effectiveSubject,
        body: inboundBody,
        intent: intent.intent,
        memory: memory.text,
        attachmentContext: strategyId === "email-attachment-aware" ? attachmentContext : undefined,
        preferences: userPreferences,
        facts,
      });

      return {
        ok: true,
        intent: intent.intent,
        confidence: intent.confidence,
        replySubject: `Re: ${effectiveSubject || "Update"}`,
        replyBody: reply,
        attachments,
        strategyReason: `semantic_strategy:${strategyId}`,
      };
    };

    let currentStrategy = selectInitialCommunicationStrategy(hydrated.attachments.length);
    const strategyPath: CommunicationStrategyId[] = [currentStrategy];
    const failures: CommunicationFailure[] = [];
    let execution: SuccessfulCommunicationExecution | null = null;

    for (let attempt = 0; attempt < COMMUNICATION_MAX_ATTEMPTS_TOTAL; attempt += 1) {
      let result: CommunicationExecutionResult;
      try {
        result = await runSemanticStrategy(currentStrategy);
      } catch (err) {
        result = {
          ok: false,
          intent: "unknown",
          confidence: 0.3,
          errorKind: classifyCommunicationError(err),
          errorMessage: errorMessage(err),
          strategyReason: "strategy_exception",
        };
      }

      if (result.ok) {
        execution = result;
        break;
      }

      failures.push({
        strategyId: currentStrategy,
        family: COMMUNICATION_STRATEGIES[currentStrategy].family,
        toolId: COMMUNICATION_STRATEGIES[currentStrategy].toolId,
        errorKind: result.errorKind,
        errorMessage: result.errorMessage,
      });

      const next = selectNextStrategy({
        attempts: failures,
        currentStrategy,
        currentFamily: COMMUNICATION_STRATEGIES[currentStrategy].family,
        matrixCandidates: COMMUNICATION_MATRIX[result.errorKind],
        strategyFamilyFor: (strategyId) => COMMUNICATION_STRATEGIES[strategyId].family,
        maxAttemptsPerFamily: COMMUNICATION_MAX_ATTEMPTS_PER_FAMILY,
        forceFamilySwitchErrorKinds: COMMUNICATION_FORCE_SWITCH_ERRORS,
        lastErrorKind: result.errorKind,
        fallbackOrder: COMMUNICATION_POLICY.fallbackOrder,
        fallbackOrderOnFamilySwitch: COMMUNICATION_POLICY.fallbackOrderOnFamilySwitch,
        allowSingleRetryOnNonzeroExit: COMMUNICATION_POLICY.nonzeroExitRetry.enabled,
        nonzeroExitErrorKind: COMMUNICATION_POLICY.nonzeroExitRetry.errorKind,
      });

      if (!next.nextStrategyId) break;
      currentStrategy = next.nextStrategyId;
      strategyPath.push(currentStrategy);
    }

    if (!execution) {
      const clarificationQuestion =
        "I don’t have enough confidence to execute yet. What exact outcome should I deliver from this email?";
      const clarificationReply = await meta.openaiComposeCommunicationReply({
        channel: "email",
        from: fromEmail,
        subject: effectiveSubject,
        body: inboundBody,
        intent: "unknown",
        memory: memory.text,
        attachmentContext,
        clarificationQuestion,
        preferences: userPreferences,
      });
      const sent = await meta.agentmailSendMessageFromXena({
        projectKey: args.projectKey,
        subject: `Re: ${effectiveSubject || "Clarification needed"}`,
        body: clarificationReply,
        to: [fromEmail],
        replyToMessageId: event.messageId,
        dryRun,
      });
      const failureKinds = failures.map((failure) => failure.errorKind);
      const selectedPlaybookId = DEFAULT_COMMUNICATION_PLAYBOOK_ID;
      await meta.mem0Add({
        projectKey: args.projectKey,
        issueIdentifier,
        namespace: "workflow.state",
        content: [
          "[agentmail_event_v2]",
          "selector: matrix",
          `event_type: ${eventType}`,
          `message_id: ${event.messageId ?? "n/a"}`,
          `from: ${fromEmail}`,
          "action: clarification_required_after_matrix_exhausted",
          `strategy_path: ${strategyPath.join(" -> ")}`,
          `playbook_id: ${selectedPlaybookId}`,
          `failure_kinds: ${failureKinds.join(", ") || "none"}`,
          `reply_sent: ${sent.sent}`,
          `reply_reason: ${sent.reason ?? "ok"}`,
          `captured_at: ${tickIso}`,
        ].join("\n"),
        type: "event",
        intent: "agentmail_clarification_sent",
        stage: "communication",
        outcome: sent.sent ? "updated" : "blocked",
        source: "workflow.agentmail",
        runId,
        appId: "xena",
        agentId: "workflow.agentmail",
        playbookId: selectedPlaybookId,
        infer: false,
        enableGraph: false,
        tags: ["agentmail", "inbound", "matrix", "clarification"],
      });
      return;
    }

    const sent = await meta.agentmailSendMessageFromXena({
      projectKey: args.projectKey,
      subject: execution.replySubject,
      body: execution.replyBody,
      to: [fromEmail],
      replyToMessageId: event.messageId,
      attachments: execution.attachments,
      dryRun,
    });

    const failureKinds = failures.map((failure) => failure.errorKind);
    const qualityScoreRaw = Math.round(execution.confidence * 100) - Math.max(0, failures.length - 1) * 5;
    const qualityScore = Math.max(0, Math.min(100, qualityScoreRaw));
    const selectedStrategy = strategyPath[strategyPath.length - 1] ?? currentStrategy;
    const selectedToolId = COMMUNICATION_STRATEGIES[selectedStrategy].toolId;
    const selectedPlaybookId = resolveCommunicationPlaybookId(execution.intent, useManusWebhookResearch);

    await meta.mem0Add({
      projectKey: args.projectKey,
      issueIdentifier,
      namespace: "workflow.state",
      content: [
        "[agentmail_event_v2]",
        "selector: matrix",
        `event_type: ${eventType}`,
        `message_id: ${event.messageId ?? "n/a"}`,
        `from: ${fromEmail}`,
        `intent: ${execution.intent}`,
        `confidence: ${execution.confidence.toFixed(3)}`,
        `selected_strategy: ${selectedStrategy}`,
        `playbook_id: ${selectedPlaybookId}`,
        `strategy_path: ${strategyPath.join(" -> ")}`,
        `strategy_failures: ${failures.length}`,
        `failure_kinds: ${failureKinds.join(", ") || "none"}`,
        `attachments_inbound: ${hydrated.attachments.length}`,
        `attachments_sent: ${execution.attachments.length}`,
        `reply_sent: ${sent.sent}`,
        `reply_reason: ${sent.reason ?? "ok"}`,
        `captured_at: ${tickIso}`,
      ].join("\n"),
      type: "event",
      intent: sent.sent ? "agentmail_inbound_replied" : "agentmail_inbound_blocked",
      stage: "communication",
      outcome: sent.sent ? "updated" : "blocked",
      source: "workflow.agentmail",
      runId,
      appId: "xena",
      agentId: "workflow.agentmail",
      playbookId: selectedPlaybookId,
      infer: false,
      enableGraph: false,
      tags: ["agentmail", "inbound", "matrix", execution.intent, sent.sent ? "replied" : "blocked"],
      confidence: execution.confidence,
      qualityScore,
    });

    if (strategyPath.length > 1 || failures.length > 0) {
      await meta.mem0Add({
        projectKey: args.projectKey,
        issueIdentifier,
        namespace: "code.decisions",
        content: [
          "[strategy_matrix]",
          "stage: communication",
          `selected_strategy: ${selectedStrategy}`,
          `selected_tool_id: ${selectedToolId}`,
          `selected_skill_id: ${selectedPlaybookId}`,
          `strategy_path: ${strategyPath.join(" -> ")}`,
          `trigger_error_kinds: ${failureKinds.join(", ") || "none"}`,
          `attempts: ${Math.max(1, strategyPath.length)}`,
        ].join("\n"),
        type: "decision",
        intent: "communication_matrix_decision",
        stage: "communication",
        outcome: sent.sent ? "success" : "blocked",
        source: "workflow.agentmail",
        runId,
        appId: "xena",
        agentId: "workflow.agentmail",
        infer: false,
        enableGraph: false,
        confidence: execution.confidence,
        qualityScore,
        playbookId: selectedPlaybookId,
        tags: ["communication", "matrix", "decision"],
      });
    }
  };

  const processManusEvent = async (event: ManusEventSignal): Promise<void> => {
    const tickIso = new Date(Date.now()).toISOString();
    const runId = `${workflowId}:manus:${event.eventId ?? event.taskId ?? tickIso}`;
    const eventType = compact(event.eventType);
    const taskId = compact(event.taskId);

    if (!taskId) {
      await meta.mem0Add({
        projectKey: args.projectKey,
        issueIdentifier,
        namespace: "workflow.state",
        content: [
          "[agentmail_research_async_v1]",
          "action: manus_event_skipped_missing_task_id",
          `event_type: ${eventType || "unknown"}`,
          `captured_at: ${tickIso}`,
        ].join("\n"),
        type: "event",
        intent: "agentmail_research_event_skipped",
        stage: "communication",
        outcome: "blocked",
        source: "workflow.agentmail",
        runId,
        appId: "xena",
        agentId: "workflow.agentmail",
        infer: false,
        enableGraph: false,
        tags: ["agentmail", "research", "matrix", "skipped"],
      });
      return;
    }

    const pending = pendingResearchTasks.get(taskId);
    if (!pending) {
      await meta.mem0Add({
        projectKey: args.projectKey,
        issueIdentifier,
        namespace: "workflow.state",
        content: [
          "[agentmail_research_async_v1]",
          "action: manus_event_ignored_untracked_task",
          `event_type: ${eventType || "unknown"}`,
          `task_id: ${taskId}`,
          `captured_at: ${tickIso}`,
        ].join("\n"),
        type: "event",
        intent: "agentmail_research_event_ignored",
        stage: "communication",
        outcome: "updated",
        source: "workflow.agentmail",
        runId,
        appId: "xena",
        agentId: "workflow.agentmail",
        infer: false,
        enableGraph: false,
        tags: ["agentmail", "research", "matrix", "ignored"],
      });
      return;
    }

    if (event.taskUrl && event.taskUrl.trim()) {
      pending.taskUrl = event.taskUrl.trim();
    }

    if (eventType !== "task_stopped") {
      await meta.mem0Add({
        projectKey: args.projectKey,
        issueIdentifier,
        namespace: "workflow.state",
        content: [
          "[agentmail_research_async_v1]",
          "action: manus_event_acknowledged",
          `event_type: ${eventType || "unknown"}`,
          `task_id: ${taskId}`,
          `task_url: ${pending.taskUrl}`,
          `captured_at: ${tickIso}`,
        ].join("\n"),
        type: "event",
        intent: "agentmail_research_event_acknowledged",
        stage: "communication",
        outcome: "updated",
        source: "workflow.agentmail",
        runId,
        appId: "xena",
        agentId: "workflow.agentmail",
        infer: false,
        enableGraph: false,
        tags: ["agentmail", "research", "matrix", "event"],
      });
      return;
    }

    const stopReason = compact(event.stopReason).toLowerCase();
    if (stopReason === "ask") {
      const clarificationQuestion =
        compact(event.message) || "Manus asked for additional input before it can complete this research task.";
      const clarificationReply = await meta.openaiComposeCommunicationReply({
        channel: "email",
        from: pending.fromEmail,
        subject: pending.effectiveSubject,
        body: pending.inboundBody,
        intent: "research_request",
        memory: pending.memoryText,
        clarificationQuestion,
        preferences: pending.userPreferences,
        facts: `Task URL: ${pending.taskUrl}`,
      });
      const sent = await meta.agentmailSendMessageFromXena({
        projectKey: args.projectKey,
        subject: `Re: ${pending.effectiveSubject || "Research follow-up"}`,
        body: clarificationReply,
        to: [pending.fromEmail],
        replyToMessageId: pending.replyMessageId,
        dryRun,
      });
      await meta.mem0Add({
        projectKey: args.projectKey,
        issueIdentifier,
        namespace: "workflow.state",
        content: [
          "[agentmail_research_async_v1]",
          "status: needs_input",
          `task_id: ${taskId}`,
          `task_url: ${pending.taskUrl}`,
          `question: ${clarificationQuestion}`,
          `reply_sent: ${sent.sent}`,
          `reply_reason: ${sent.reason ?? "ok"}`,
          `captured_at: ${tickIso}`,
        ].join("\n"),
        type: "event",
        intent: "agentmail_research_needs_input",
        stage: "communication",
        outcome: sent.sent ? "updated" : "blocked",
        source: "workflow.agentmail",
        runId,
        appId: "xena",
        agentId: "workflow.agentmail",
        infer: false,
        enableGraph: false,
        tags: ["agentmail", "research", "matrix", "needs_input"],
      });
      return;
    }

    if (stopReason !== "" && stopReason !== "finish") {
      await meta.mem0Add({
        projectKey: args.projectKey,
        issueIdentifier,
        namespace: "workflow.state",
        content: [
          "[agentmail_research_async_v1]",
          "status: unsupported_stop_reason",
          `task_id: ${taskId}`,
          `stop_reason: ${stopReason}`,
          `captured_at: ${tickIso}`,
        ].join("\n"),
        type: "event",
        intent: "agentmail_research_failed",
        stage: "communication",
        outcome: "failed",
        source: "workflow.agentmail",
        runId,
        appId: "xena",
        agentId: "workflow.agentmail",
        infer: false,
        enableGraph: false,
        tags: ["agentmail", "research", "matrix", "failed"],
      });
      return;
    }

    try {
      const research = await meta.researchFinalizeTask({
        issueId: pending.runId,
        issueIdentifier,
        topic: pending.topic,
        taskId,
        sourceHints: [pending.effectiveSubject, pending.fromEmail].filter((value) => value.length > 0),
        maxSources: 8,
      });
      const researchSummary = buildResearchSummary(research);
      const researchAttachment = await meta.agentmailBuildTextAttachment({
        filename: `xena-research-${tickIso.slice(0, 10)}.md`,
        text: researchSummary,
        contentType: "text/markdown; charset=utf-8",
      });
      const reply = await meta.openaiComposeCommunicationReply({
        channel: "email",
        from: pending.fromEmail,
        subject: pending.effectiveSubject,
        body: pending.inboundBody,
        intent: "research_request",
        memory: pending.memoryText,
        preferences: pending.userPreferences,
        facts: researchSummary,
      });
      const sent = await meta.agentmailSendMessageFromXena({
        projectKey: args.projectKey,
        subject: `Re: ${pending.effectiveSubject || "Research update"}`,
        body: reply,
        to: [pending.fromEmail],
        replyToMessageId: pending.replyMessageId,
        attachments: researchAttachment ? [researchAttachment] : [],
        dryRun,
      });
      await meta.mem0Add({
        projectKey: args.projectKey,
        issueIdentifier,
        namespace: "research.findings",
        content: [
          "[agentmail_research_v3]",
          `from: ${pending.fromEmail}`,
          `subject: ${pending.effectiveSubject || "(none)"}`,
          `topic: ${pending.topic}`,
          `task_id: ${taskId}`,
          `task_url: ${pending.taskUrl}`,
          researchSummary,
        ].join("\n"),
        type: "research_finding",
        intent: "agentmail_research_completed",
        stage: "communication",
        outcome: sent.sent ? "success" : "blocked",
        source: "workflow.agentmail",
        runId: pending.runId,
        appId: "xena",
        agentId: "workflow.agentmail",
        infer: false,
        enableGraph: false,
        tags: ["agentmail", "research", "matrix", "completed"],
        confidence: pending.confidence,
      });
      pendingResearchTasks.delete(taskId);
    } catch (err) {
      const msg = errorMessage(err);
      const body = [
        "I started your Manus research task, but I couldn't finalize the result yet.",
        `Task ID: ${taskId}`,
        `Task URL: ${pending.taskUrl}`,
        "",
        `Error: ${msg}`,
      ].join("\n");
      const sent = await meta.agentmailSendMessageFromXena({
        projectKey: args.projectKey,
        subject: `Re: ${pending.effectiveSubject || "Research update"}`,
        body,
        to: [pending.fromEmail],
        replyToMessageId: pending.replyMessageId,
        dryRun,
      });
      await meta.mem0Add({
        projectKey: args.projectKey,
        issueIdentifier,
        namespace: "workflow.state",
        content: [
          "[agentmail_research_async_v1]",
          "status: finalize_failed",
          `task_id: ${taskId}`,
          `task_url: ${pending.taskUrl}`,
          `error: ${msg}`,
          `reply_sent: ${sent.sent}`,
          `reply_reason: ${sent.reason ?? "ok"}`,
          `captured_at: ${tickIso}`,
        ].join("\n"),
        type: "event",
        intent: "agentmail_research_failed",
        stage: "communication",
        outcome: "failed",
        source: "workflow.agentmail",
        runId: pending.runId,
        appId: "xena",
        agentId: "workflow.agentmail",
        infer: false,
        enableGraph: false,
        tags: ["agentmail", "research", "matrix", "failed"],
      });
    }
  };

  let nextTickAt = intervalMinutes > 0 ? Date.now() + intervalMs(intervalMinutes) : Number.POSITIVE_INFINITY;

  while (true) {
    let hasEvent = false;
    if (intervalMinutes > 0) {
      const waitMs = Math.max(1, nextTickAt - Date.now());
      hasEvent = await condition(() => pendingEvents.length > 0 || pendingManusEvents.length > 0, waitMs);
    } else {
      await condition(() => pendingEvents.length > 0 || pendingManusEvents.length > 0);
      hasEvent = true;
    }

    if (hasEvent) {
      while (pendingManusEvents.length > 0) {
        const event = pendingManusEvents.shift()!;
        await processManusEvent(event);
      }
      while (pendingEvents.length > 0) {
        const event = pendingEvents.shift()!;
        if (useCommunicationMatrix) {
          await processIncomingEventMatrix(event);
        } else {
          await processIncomingEventLegacy(event);
        }
      }
      continue;
    }

    await runPeriodicDigestTick();
    nextTickAt = Date.now() + intervalMs(intervalMinutes);
  }
}
