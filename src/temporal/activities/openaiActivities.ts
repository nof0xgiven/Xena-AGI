import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import { loadWorkerEnv } from "../../env.js";
import { z } from "zod";
import { renderUserPreferencesForPrompt, type UserPreferencesProfile } from "../../memory/userPreferences.js";
import fs from "node:fs/promises";
import path from "node:path";

const UncertaintySchema = z.object({
  needsClarification: z.boolean(),
  clarificationQuestion: z.string().min(1).max(280).optional(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(400).optional(),
});

const CommunicationIntentSchema = z.object({
  intent: z.enum([
    "research_request",
    "digest_request",
    "meeting_request",
    "status_update_request",
    "task_status_request",
    "attachment_request",
    "unknown",
  ]),
  confidence: z.number().min(0).max(1),
  needsClarification: z.boolean(),
  clarificationQuestion: z.string().min(1).max(280).optional(),
  topic: z.string().min(1).max(220).optional(),
  objective: z.string().min(1).max(360).optional(),
  rationale: z.string().min(1).max(400).optional(),
});

function buildDefaultPersonalityProfile(): string {
  const ownerName = process.env.XENA_OWNER_NAME || "the owner";
  return [
    `You are Xena, ${ownerName}'s sharp and loyal operator partner.`,
    "Voice: concise, natural, direct, lightly witty when appropriate, never robotic.",
    "Role: orchestrator and delivery manager. You coordinate work and outcomes; you do not pretend to have done work that did not happen.",
    "Style: lead with the answer, then supporting context if needed.",
    `Use 'we' for shared goals and 'you' for ${ownerName}'s decisions.`,
    "Be professional but human. Avoid canned phrasing and polite filler.",
  ].join("\n");
}

let personalityDirectivePromise: Promise<string> | null = null;

function resolveOwnerPlaceholders(text: string): string {
  const ownerName = process.env.XENA_OWNER_NAME || "the owner";
  return text.replace(/\{\{OWNER_NAME\}\}/g, ownerName);
}

async function getPersonalityDirective(): Promise<string> {
  if (!personalityDirectivePromise) {
    personalityDirectivePromise = (async () => {
      try {
        const personalityPath = path.resolve(process.cwd(), "docs/personality.md");
        const raw = await fs.readFile(personalityPath, "utf8");
        const trimmed = raw.trim();
        if (trimmed.length > 0) {
          return `Personality Profile (docs/personality.md):\n${resolveOwnerPlaceholders(trimmed)}`;
        }
      } catch {
        // fallback below
      }
      return `Personality Profile (fallback):\n${buildDefaultPersonalityProfile()}`;
    })();
  }
  return personalityDirectivePromise;
}

function toSingleQuestion(text: string | undefined): string | null {
  const t = (text ?? "").trim().replace(/\s+/g, " ");
  if (!t) return null;
  const q = t.split("?")[0]?.trim();
  if (!q) return null;
  return `${q}?`;
}

function toneDirective(tone: UserPreferencesProfile["tone"]): string {
  switch (tone) {
    case "friendly":
      return "Tone preference: friendly and collaborative while staying concrete.";
    case "balanced":
      return "Tone preference: balanced and pragmatic.";
    case "direct":
    default:
      return "Tone preference: direct and to the point.";
  }
}

function verbosityDirective(verbosity: UserPreferencesProfile["replyVerbosity"]): string {
  switch (verbosity) {
    case "short":
      return "Reply length preference: keep to 1-3 short sentences when possible.";
    case "detailed":
      return "Reply length preference: include enough detail to make the next action obvious.";
    case "balanced":
    default:
      return "Reply length preference: concise but complete.";
  }
}

function updateCadenceDirective(cadence: UserPreferencesProfile["updateCadence"]): string {
  switch (cadence) {
    case "low":
      return "Update cadence preference: milestone-only updates unless blocked or explicitly asked.";
    case "balanced":
      return "Update cadence preference: key stage updates, avoid routine chatter.";
    case "high":
    default:
      return "Update cadence preference: provide regular progress updates.";
  }
}

function preferencePrompt(profile: UserPreferencesProfile | undefined): string {
  if (!profile) return "(none provided; use default direct concise teammate style)";
  return renderUserPreferencesForPrompt(profile);
}

export async function openaiAnswerComment(opts: {
  issueIdentifier: string;
  issueTitle: string;
  issueDescription: string | null;
  memory: string;
  recentComments?: string;
  stage: string;
  commentBody: string;
  preferences?: UserPreferencesProfile;
}): Promise<string> {
  const env = loadWorkerEnv();
  const personality = await getPersonalityDirective();

  const sys = [
    "You are Xena, a teammate on the engineering team.",
    "Answer the user's comment based on the Linear ticket context and memory.",
    personality,
    "Rules:",
    "- Be concise and actionable.",
    "- If the user is asking for something that blocks execution, ask for the minimum needed details.",
    "- Do not claim you've executed steps you have not executed.",
    "- Do not mention being an AI or a model.",
    "- Avoid emoji unless the user used emoji first; max one if used.",
    opts.preferences ? toneDirective(opts.preferences.tone) : "Tone preference: direct and pragmatic.",
    opts.preferences ? verbosityDirective(opts.preferences.replyVerbosity) : "Reply length preference: concise but complete.",
    opts.preferences ? updateCadenceDirective(opts.preferences.updateCadence) : "Update cadence preference: balanced.",
  ].join("\n");

  const prompt = [
    `Issue: ${opts.issueIdentifier}`,
    `Title: ${opts.issueTitle}`,
    `Description:\n${opts.issueDescription ?? ""}`,
    `Stage: ${opts.stage}`,
    `User preferences:\n${preferencePrompt(opts.preferences)}`,
    `Memory (mem0):\n${opts.memory}`,
    `Recent comments:\n${opts.recentComments ?? ""}`,
    `Comment:\n${opts.commentBody}`,
  ].join("\n\n");

  const res = await generateText({
    model: openai(env.XENA_OPENAI_MODEL),
    system: sys,
    prompt,
  });

  return res.text.trim();
}

export type OpenaiCommentUncertaintyResult = {
  needsClarification: boolean;
  clarificationQuestion: string | null;
  confidence: number;
  rationale: string | null;
};

export async function openaiClassifyCommentUncertainty(opts: {
  issueIdentifier: string;
  issueTitle: string;
  issueDescription: string | null;
  memory: string;
  recentComments?: string;
  stage: string;
  commentBody: string;
  preferences?: UserPreferencesProfile;
}): Promise<OpenaiCommentUncertaintyResult> {
  const env = loadWorkerEnv();

  const sys = [
    "You classify whether a teammate comment can be answered now or needs one clarification question.",
    "Return structured output only.",
    "Rules:",
    "- needsClarification=true only when one missing detail blocks a reliable answer/action.",
    "- If needsClarification=true, provide exactly one concise question.",
    "- If needsClarification=false, leave clarificationQuestion empty.",
    "- confidence is 0..1 for answerability right now.",
    opts.preferences ? toneDirective(opts.preferences.tone) : "Tone preference: direct and pragmatic.",
  ].join("\n");

  const prompt = [
    `Issue: ${opts.issueIdentifier}`,
    `Title: ${opts.issueTitle}`,
    `Description:\n${opts.issueDescription ?? ""}`,
    `Stage: ${opts.stage}`,
    `User preferences:\n${preferencePrompt(opts.preferences)}`,
    `Memory:\n${opts.memory}`,
    `Recent comments:\n${opts.recentComments ?? ""}`,
    `Comment:\n${opts.commentBody}`,
  ].join("\n\n");

  try {
    const res = await generateText({
      model: openai(env.XENA_OPENAI_MODEL),
      system: sys,
      prompt:
        `${prompt}\n\n` +
        `Return strict JSON only with keys: needsClarification, clarificationQuestion, confidence, rationale.`,
    });
    const text = res.text.trim();
    const objText = text.match(/\{[\s\S]*\}/)?.[0] ?? text;
    const parsed = UncertaintySchema.parse(JSON.parse(objText));
    const question = toSingleQuestion(parsed.clarificationQuestion);
    const needsClarification = parsed.needsClarification && question !== null;
    return {
      needsClarification,
      clarificationQuestion: needsClarification ? question : null,
      confidence: parsed.confidence,
      rationale: parsed.rationale ?? null,
    };
  } catch {
    const body = opts.commentBody.trim();
    const vagueOnly = /\b(this|that|it|same)\b/i.test(body) && body.length < 80;
    if (vagueOnly) {
      return {
        needsClarification: true,
        clarificationQuestion: "Can you share the specific expected outcome for this ticket?",
        confidence: 0.3,
        rationale: "Heuristic fallback: ambiguous short comment.",
      };
    }
    return {
      needsClarification: false,
      clarificationQuestion: null,
      confidence: 0.6,
      rationale: "Heuristic fallback: answerable without blocking ambiguity.",
    };
  }
}

export async function openaiComposeTeammateReply(opts: {
  issueIdentifier: string;
  issueTitle: string;
  issueDescription: string | null;
  memory: string;
  recentComments: string;
  taskContext: string;
  intent: string;
  draft?: string;
  triggerComment?: string;
  facts?: string;
  preferences?: UserPreferencesProfile;
}): Promise<string> {
  const env = loadWorkerEnv();
  const personality = await getPersonalityDirective();

  const sys = [
    "You are Xena, a real teammate in an engineering org.",
    "Write one Linear comment reply.",
    personality,
    "Requirements:",
    "- Sound human and grounded. No AI framing.",
    "- Avoid emoji unless the user used emoji first; max one if used.",
    "- Be concise and specific.",
    "- Lead with the answer in the first line.",
    "- Prefer plain, natural language over system-report formatting.",
    "- Default to plain text; avoid markdown-heavy formatting unless the user explicitly asks for a structured report.",
    "- Use the current task context, recent comments, and memory.",
    "- Do not repeat canned phrases from recent comments; vary wording naturally.",
    "- Ask a clarification question only when missing information blocks a reliable response or next action.",
    "- For status/progress intents, do not ask a question unless execution is truly blocked.",
    "- Never claim actions that did not happen.",
    opts.preferences ? toneDirective(opts.preferences.tone) : "Tone preference: direct and pragmatic.",
    opts.preferences ? verbosityDirective(opts.preferences.replyVerbosity) : "Reply length preference: concise but complete.",
    opts.preferences ? updateCadenceDirective(opts.preferences.updateCadence) : "Update cadence preference: balanced.",
  ].join("\n");

  const prompt = [
    `Intent: ${opts.intent}`,
    `Issue: ${opts.issueIdentifier}`,
    `Title: ${opts.issueTitle}`,
    `Description:\n${opts.issueDescription ?? ""}`,
    `User preferences:\n${preferencePrompt(opts.preferences)}`,
    `Task context:\n${opts.taskContext}`,
    `Recent comments:\n${opts.recentComments}`,
    `Memory (mem0):\n${opts.memory}`,
    `Trigger comment:\n${opts.triggerComment ?? ""}`,
    `Facts:\n${opts.facts ?? ""}`,
    `Draft to improve (optional):\n${opts.draft ?? ""}`,
  ].join("\n\n");

  const res = await generateText({
    model: openai(env.XENA_OPENAI_MODEL),
    system: sys,
    prompt,
  });

  return res.text.trim();
}

export type CommunicationIntentResult = {
  intent:
    | "research_request"
    | "digest_request"
    | "meeting_request"
    | "status_update_request"
    | "task_status_request"
    | "attachment_request"
    | "unknown";
  confidence: number;
  needsClarification: boolean;
  clarificationQuestion: string | null;
  topic: string | null;
  objective: string | null;
  rationale: string | null;
};

export async function openaiClassifyCommunicationIntent(opts: {
  channel: "email" | "slack";
  from?: string | null;
  subject?: string | null;
  body: string;
  memory?: string;
  attachmentContext?: string;
  preferences?: UserPreferencesProfile;
}): Promise<CommunicationIntentResult> {
  const env = loadWorkerEnv();

  const sys = [
    "You classify inbound teammate communications for a personal operator named Xena.",
    "Choose one intent: research_request, digest_request, meeting_request, status_update_request, task_status_request, attachment_request, unknown.",
    "Use needsClarification=true when ambiguity blocks reliable execution; provide exactly one concise question.",
    "Set confidence based on executability now.",
    "Return strict JSON only.",
    opts.preferences ? toneDirective(opts.preferences.tone) : "Tone preference: direct and pragmatic.",
  ].join("\n");

  const prompt = [
    `Channel: ${opts.channel}`,
    `From: ${opts.from ?? ""}`,
    `Subject: ${opts.subject ?? ""}`,
    `Body:\n${opts.body}`,
    `Attachment context:\n${opts.attachmentContext ?? ""}`,
    `Memory:\n${opts.memory ?? ""}`,
    `User preferences:\n${preferencePrompt(opts.preferences)}`,
  ].join("\n\n");

  const res = await generateText({
    model: openai(env.XENA_OPENAI_MODEL),
    system: sys,
    prompt:
      `${prompt}\n\n` +
      "Return strict JSON with keys: intent, confidence, needsClarification, clarificationQuestion, topic, objective, rationale.",
  });
  const text = res.text.trim();
  const objText = text.match(/\{[\s\S]*\}/)?.[0] ?? text;

  let parsed: z.infer<typeof CommunicationIntentSchema>;
  try {
    const candidate = JSON.parse(objText) as Record<string, unknown>;
    if (typeof candidate.clarificationQuestion === "string" && candidate.clarificationQuestion.trim().length === 0) {
      delete candidate.clarificationQuestion;
    }
    parsed = CommunicationIntentSchema.parse(candidate);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`communication_intent_parse_failed: ${reason}`);
  }

  const clarificationQuestion = parsed.needsClarification ? toSingleQuestion(parsed.clarificationQuestion) : null;

  return {
    intent: parsed.intent,
    confidence: parsed.confidence,
    needsClarification: parsed.needsClarification && clarificationQuestion !== null,
    clarificationQuestion: parsed.needsClarification ? clarificationQuestion : null,
    topic: parsed.topic?.trim() ?? null,
    objective: parsed.objective?.trim() ?? null,
    rationale: parsed.rationale ?? null,
  };
}

export async function openaiComposeCommunicationReply(opts: {
  channel: "email" | "slack";
  from?: string | null;
  subject?: string | null;
  body: string;
  intent: CommunicationIntentResult["intent"];
  facts?: string;
  memory?: string;
  attachmentContext?: string;
  preferences?: UserPreferencesProfile;
  clarificationQuestion?: string | null;
}): Promise<string> {
  const env = loadWorkerEnv();
  const personality = await getPersonalityDirective();
  const sys = [
    "You are Xena, a personal operator and teammate.",
    "Write one concise human response message.",
    personality,
    "No AI framing. No fake claims.",
    "Never use generic filler like 'I've got this' or vague promises.",
    "Lead with the answer in the first sentence.",
    "Sound like a trusted teammate, not a monitoring system.",
    "State what you already did, and what you will do next only when relevant.",
    "Keep timestamps and raw system details minimal unless specifically requested.",
    "If sharing status, summarize first, then include only the most important facts.",
    "Default to plain text; avoid markdown-heavy formatting unless the user explicitly asks for a structured report.",
    "Avoid emoji unless the user used emoji first; max one if used.",
    "If clarificationQuestion is present, ask only that one question and keep it short.",
    opts.preferences ? toneDirective(opts.preferences.tone) : "Tone preference: direct and pragmatic.",
    opts.preferences ? verbosityDirective(opts.preferences.replyVerbosity) : "Reply length preference: concise but complete.",
  ].join("\n");

  const prompt = [
    `Channel: ${opts.channel}`,
    `From: ${opts.from ?? ""}`,
    `Subject: ${opts.subject ?? ""}`,
    `Inbound message:\n${opts.body}`,
    `Intent: ${opts.intent}`,
    `Attachment context:\n${opts.attachmentContext ?? ""}`,
    `Memory:\n${opts.memory ?? ""}`,
    `Facts:\n${opts.facts ?? ""}`,
    `Clarification question:\n${opts.clarificationQuestion ?? ""}`,
    `User preferences:\n${preferencePrompt(opts.preferences)}`,
  ].join("\n\n");

  const res = await generateText({
    model: openai(env.XENA_OPENAI_MODEL),
    system: sys,
    prompt,
  });
  return res.text.trim();
}
