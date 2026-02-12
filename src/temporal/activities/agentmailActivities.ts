import {
  agentmailCreateInbox,
  agentmailDownloadAttachment,
  agentmailGetMessage,
  agentmailGetMessageAttachment,
  agentmailListInboxes,
  agentmailSendMessage,
  createAgentmailClient,
} from "../../agentmail.js";
import { loadWorkerEnv } from "../../env.js";
import { logger } from "../../logger.js";

export type AgentmailSendAttachment = {
  filename?: string;
  contentType?: string;
  contentDisposition?: "inline" | "attachment";
  contentId?: string;
  contentBase64?: string;
  text?: string;
  url?: string;
};

export type AgentmailEnsureInboxResult = {
  enabled: boolean;
  inboxId?: string;
  email?: string;
  created?: boolean;
  reason?: string;
};

export type AgentmailSendResult = {
  sent: boolean;
  inboxId?: string;
  messageId?: string;
  threadId?: string;
  attachmentCount?: number;
  reason?: string;
};

export type AgentmailHydratedInboundAttachment = {
  attachmentId: string;
  filename?: string;
  size?: number;
  contentType?: string;
  contentDisposition?: "inline" | "attachment";
  contentId?: string;
  downloadUrl?: string;
  expiresAt?: string;
  inlineText?: string;
  inlineTextTruncated?: boolean;
  fetchError?: string;
};

export type AgentmailHydratedInboundMessage = {
  inboxId?: string;
  messageId?: string;
  threadId?: string;
  from?: string;
  subject?: string;
  text?: string;
  html?: string;
  extractedText?: string;
  extractedHtml?: string;
  attachments: AgentmailHydratedInboundAttachment[];
  attachmentSummary: string;
};

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeUsername(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "xena";
}

function parseRecipients(value: string | string[] | undefined, fallback: string | undefined): string[] {
  const input =
    Array.isArray(value)
      ? value
      : typeof value === "string"
        ? value.split(",")
        : (fallback ?? "").split(",");

  return [...new Set(input.map((part) => part.trim()).filter((part) => part.length > 0))];
}

function isTextualContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const normalized = contentType.toLowerCase();
  if (normalized.startsWith("text/")) return true;
  return (
    normalized.includes("json") ||
    normalized.includes("xml") ||
    normalized.includes("yaml") ||
    normalized.includes("csv") ||
    normalized.includes("markdown") ||
    normalized.includes("x-www-form-urlencoded")
  );
}

function normalizeAttachment(input: AgentmailSendAttachment): {
  filename?: string;
  contentType?: string;
  contentDisposition?: "inline" | "attachment";
  contentId?: string;
  content?: string;
  url?: string;
} | null {
  const content = asString(input.contentBase64);
  const text = asString(input.text);
  const url = asString(input.url);
  if (!content && !text && !url) return null;

  return {
    filename: asString(input.filename) ?? undefined,
    contentType: asString(input.contentType) ?? undefined,
    contentDisposition: input.contentDisposition,
    contentId: asString(input.contentId) ?? undefined,
    content: content ?? (text ? Buffer.from(text, "utf8").toString("base64") : undefined),
    url: url ?? undefined,
  };
}

function buildAttachmentSummary(attachments: readonly AgentmailHydratedInboundAttachment[]): string {
  if (attachments.length === 0) return "attachments: none";
  const rows = attachments.map((attachment, index) => {
    const parts = [
      `#${index + 1}`,
      `id=${attachment.attachmentId}`,
      `name=${attachment.filename ?? "n/a"}`,
      `size=${attachment.size ?? "n/a"}`,
      `type=${attachment.contentType ?? "n/a"}`,
    ];
    if (attachment.inlineText) {
      parts.push(`inline_text=${attachment.inlineTextTruncated ? "truncated" : "included"}`);
    }
    if (attachment.fetchError) {
      parts.push(`fetch_error=${attachment.fetchError}`);
    }
    return `- ${parts.join("; ")}`;
  });
  return ["attachments:", ...rows].join("\n");
}

export async function agentmailEnsureInbox(opts: {
  projectKey: string;
  clientId?: string;
  username?: string;
  domain?: string;
  displayName?: string;
}): Promise<AgentmailEnsureInboxResult> {
  const env = loadWorkerEnv();
  if (!env.AGENTMAIL_API_KEY) {
    return {
      enabled: false,
      reason: "agentmail_api_key_missing",
    };
  }

  const client = createAgentmailClient({
    apiKey: env.AGENTMAIL_API_KEY,
    baseUrl: env.AGENTMAIL_BASE_URL,
  });

  const explicitInboxId = asString(env.XENA_AGENTMAIL_INBOX_ID);
  if (explicitInboxId) {
    return {
      enabled: true,
      inboxId: explicitInboxId,
      created: false,
      reason: "using_configured_inbox_id",
    };
  }

  const clientId = asString(opts.clientId) ?? `xena-${opts.projectKey}-assistant`;
  let pageToken: string | undefined;
  for (let i = 0; i < 10; i += 1) {
    const listed = await agentmailListInboxes({
      client,
      limit: 100,
      pageToken,
    });
    const existing = listed.inboxes.find((inbox) => inbox.clientId === clientId);
    if (existing) {
      return {
        enabled: true,
        inboxId: existing.inboxId,
        email: existing.email,
        created: false,
      };
    }
    if (!listed.nextPageToken) break;
    pageToken = listed.nextPageToken;
  }

  const username = normalizeUsername(
    asString(opts.username) ?? asString(env.XENA_AGENTMAIL_USERNAME) ?? `xena-${opts.projectKey}`,
  );
  const domain = asString(opts.domain) ?? asString(env.XENA_AGENTMAIL_DOMAIN) ?? undefined;
  const displayName = asString(opts.displayName) ?? asString(env.XENA_AGENTMAIL_DISPLAY_NAME) ?? "Xena";

  const created = await agentmailCreateInbox({
    client,
    username,
    domain,
    displayName,
    clientId,
  });
  return {
    enabled: true,
    inboxId: created.inboxId,
    email: created.email,
    created: true,
  };
}

export async function agentmailSendMessageFromXena(opts: {
  projectKey: string;
  subject: string;
  body: string;
  to?: string | string[];
  attachments?: AgentmailSendAttachment[];
  dryRun?: boolean;
}): Promise<AgentmailSendResult> {
  try {
    const env = loadWorkerEnv();
    const recipients = parseRecipients(opts.to, env.XENA_OWNER_EMAIL);
    if (recipients.length === 0) {
      return {
        sent: false,
        reason: "owner_email_missing",
      };
    }

    const ensured = await agentmailEnsureInbox({ projectKey: opts.projectKey });
    if (!ensured.enabled || !ensured.inboxId) {
      return {
        sent: false,
        reason: ensured.reason ?? "agentmail_not_configured",
      };
    }

    if (opts.dryRun === true) {
      return {
        sent: false,
        inboxId: ensured.inboxId,
        attachmentCount: opts.attachments?.length ?? 0,
        reason: "dry_run",
      };
    }

    const client = createAgentmailClient({
      apiKey: env.AGENTMAIL_API_KEY!,
      baseUrl: env.AGENTMAIL_BASE_URL,
    });
    const subject = asString(opts.subject) ?? "[Xena] Update";
    const text = asString(opts.body) ?? "No message body provided.";
    const attachments = (opts.attachments ?? [])
      .map(normalizeAttachment)
      .filter((attachment): attachment is NonNullable<ReturnType<typeof normalizeAttachment>> => attachment !== null);

    const sent = await agentmailSendMessage({
      client,
      inboxId: ensured.inboxId,
      to: recipients,
      subject,
      text,
      attachments,
    });

    return {
      sent: true,
      inboxId: ensured.inboxId,
      messageId: sent.messageId,
      threadId: sent.threadId,
      attachmentCount: attachments.length,
    };
  } catch (err) {
    logger.warn({ err, subject: opts.subject }, "agentmailSendMessageFromXena failed");
    return {
      sent: false,
      reason: "agentmail_send_failed",
    };
  }
}

export async function agentmailBuildTextAttachment(opts: {
  filename: string;
  text: string;
  contentType?: string;
}): Promise<AgentmailSendAttachment | null> {
  const filename = asString(opts.filename);
  const text = asString(opts.text);
  if (!filename || !text) return null;
  return {
    filename,
    text,
    contentType: asString(opts.contentType) ?? "text/plain; charset=utf-8",
    contentDisposition: "attachment",
  };
}

export async function agentmailHydrateInboundMessage(opts: {
  projectKey: string;
  inboxId?: string;
  messageId?: string;
  signalSubject?: string;
  signalText?: string;
  signalHtml?: string;
  signalExtractedText?: string;
  signalExtractedHtml?: string;
  signalFrom?: string;
  signalAttachments?: Array<{
    attachmentId: string;
    filename?: string;
    size?: number;
    contentType?: string;
    contentDisposition?: "inline" | "attachment";
    contentId?: string;
  }>;
  maxAttachments?: number;
  maxInlineBytes?: number;
  maxInlineChars?: number;
}): Promise<AgentmailHydratedInboundMessage> {
  const out: AgentmailHydratedInboundMessage = {
    inboxId: asString(opts.inboxId) ?? undefined,
    messageId: asString(opts.messageId) ?? undefined,
    subject: asString(opts.signalSubject) ?? undefined,
    text: asString(opts.signalText) ?? undefined,
    html: asString(opts.signalHtml) ?? undefined,
    extractedText: asString(opts.signalExtractedText) ?? undefined,
    extractedHtml: asString(opts.signalExtractedHtml) ?? undefined,
    from: asString(opts.signalFrom) ?? undefined,
    attachments: (opts.signalAttachments ?? []).map((attachment) => ({
      attachmentId: attachment.attachmentId,
      filename: attachment.filename,
      size: attachment.size,
      contentType: attachment.contentType,
      contentDisposition: attachment.contentDisposition,
      contentId: attachment.contentId,
    })),
    attachmentSummary: "attachments: none",
  };

  const env = loadWorkerEnv();
  if (!env.AGENTMAIL_API_KEY) {
    out.attachmentSummary = buildAttachmentSummary(out.attachments);
    return out;
  }

  const inboxId = asString(opts.inboxId);
  const messageId = asString(opts.messageId);
  if (!inboxId || !messageId) {
    out.attachmentSummary = buildAttachmentSummary(out.attachments);
    return out;
  }

  const maxAttachments = Number.isFinite(opts.maxAttachments) ? Math.max(0, Math.floor(opts.maxAttachments!)) : 6;
  const maxInlineBytes =
    Number.isFinite(opts.maxInlineBytes) && opts.maxInlineBytes! > 0 ? Math.floor(opts.maxInlineBytes!) : 350_000;
  const maxInlineChars =
    Number.isFinite(opts.maxInlineChars) && opts.maxInlineChars! > 0 ? Math.floor(opts.maxInlineChars!) : 6_000;

  const client = createAgentmailClient({
    apiKey: env.AGENTMAIL_API_KEY,
    baseUrl: env.AGENTMAIL_BASE_URL,
  });

  try {
    const message = await agentmailGetMessage({
      client,
      inboxId,
      messageId,
    });

    out.threadId = message.threadId;
    out.subject = message.subject ?? out.subject;
    out.text = message.text ?? out.text;
    out.html = message.html ?? out.html;
    out.extractedText = message.extractedText ?? out.extractedText;
    out.extractedHtml = message.extractedHtml ?? out.extractedHtml;
    out.from = message.from ?? out.from;

    const sourceAttachments =
      message.attachments.length > 0
        ? message.attachments
        : out.attachments.map((attachment) => ({
            attachmentId: attachment.attachmentId,
            filename: attachment.filename,
            size: attachment.size,
            contentType: attachment.contentType,
            contentDisposition: attachment.contentDisposition,
            contentId: attachment.contentId,
          }));

    const hydrated: AgentmailHydratedInboundAttachment[] = [];
    for (const attachment of sourceAttachments.slice(0, maxAttachments)) {
      const base: AgentmailHydratedInboundAttachment = {
        attachmentId: attachment.attachmentId,
        filename: attachment.filename,
        size: attachment.size,
        contentType: attachment.contentType,
        contentDisposition: attachment.contentDisposition,
        contentId: attachment.contentId,
      };
      try {
        const handle = await agentmailGetMessageAttachment({
          client,
          inboxId,
          messageId,
          attachmentId: attachment.attachmentId,
        });
        base.downloadUrl = handle.downloadUrl;
        base.expiresAt = handle.expiresAt;
        base.filename = handle.filename ?? base.filename;
        base.size = handle.size ?? base.size;
        base.contentType = handle.contentType ?? base.contentType;
        base.contentDisposition = handle.contentDisposition ?? base.contentDisposition;
        base.contentId = handle.contentId ?? base.contentId;

        const canInline =
          Boolean(base.downloadUrl) &&
          isTextualContentType(base.contentType) &&
          (typeof base.size !== "number" || base.size <= maxInlineBytes);

        if (canInline && base.downloadUrl) {
          const downloaded = await agentmailDownloadAttachment({ downloadUrl: base.downloadUrl });
          const decoded = Buffer.from(downloaded.data).toString("utf8");
          const normalized = decoded.replace(/\u0000/g, "").trim();
          if (normalized) {
            base.inlineText = normalized.slice(0, maxInlineChars);
            base.inlineTextTruncated = normalized.length > maxInlineChars;
          }
        }
      } catch (err) {
        base.fetchError = err instanceof Error ? err.message : String(err);
      }
      hydrated.push(base);
    }

    out.attachments = hydrated;
    out.attachmentSummary = buildAttachmentSummary(out.attachments);
    return out;
  } catch (err) {
    logger.warn({ err, inboxId, messageId }, "agentmailHydrateInboundMessage failed");
    out.attachmentSummary = buildAttachmentSummary(out.attachments);
    return out;
  }
}
