export type AgentmailClient = {
  apiKey: string;
  baseUrl: string;
};

export type AgentmailAttachment = {
  attachmentId: string;
  filename?: string;
  size?: number;
  contentType?: string;
  contentDisposition?: "inline" | "attachment";
  contentId?: string;
};

export type AgentmailMessage = {
  inboxId: string;
  messageId: string;
  threadId?: string;
  from?: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string;
  text?: string;
  html?: string;
  extractedText?: string;
  extractedHtml?: string;
  createdAt?: string;
  updatedAt?: string;
  attachments: AgentmailAttachment[];
};

export type AgentmailAttachmentHandle = AgentmailAttachment & {
  downloadUrl: string;
  expiresAt: string;
};

export type AgentmailOutgoingAttachment = {
  filename?: string;
  contentType?: string;
  contentDisposition?: "inline" | "attachment";
  contentId?: string;
  content?: string;
  url?: string;
};

export type AgentmailInbox = {
  inboxId: string;
  email?: string;
  displayName?: string;
  clientId?: string;
  username?: string;
  domain?: string;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export function createAgentmailClient(opts: { apiKey: string; baseUrl?: string }): AgentmailClient {
  return {
    apiKey: opts.apiKey,
    baseUrl: normalizeBaseUrl(opts.baseUrl ?? "https://api.agentmail.to"),
  };
}

async function agentmailFetchJson(opts: {
  client: AgentmailClient;
  path: string;
  method: "GET" | "POST";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}): Promise<unknown> {
  const url = new URL(`${opts.client.baseUrl}${opts.path}`);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }

  const hasBody = opts.body !== undefined;
  const res = await fetch(url, {
    method: opts.method,
    headers: hasBody
      ? {
          authorization: `Bearer ${opts.client.apiKey}`,
          "content-type": "application/json",
        }
      : {
          authorization: `Bearer ${opts.client.apiKey}`,
        },
    body: hasBody ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });

  const text = await res.text();
  if (!res.ok) {
    const snippet = text.length > 4000 ? `${text.slice(0, 4000)}\n...` : text;
    throw new Error(`AgentMail request failed (${res.status}) ${opts.method} ${url}\n\n${snippet}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function agentmailFetchBinary(opts: {
  url: string;
  method?: "GET";
}): Promise<{ data: Uint8Array; contentType?: string }> {
  const res = await fetch(opts.url, {
    method: opts.method ?? "GET",
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = await res.text();
    const snippet = text.length > 4000 ? `${text.slice(0, 4000)}\n...` : text;
    throw new Error(`AgentMail attachment download failed (${res.status}) ${opts.url}\n\n${snippet}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return {
    data: new Uint8Array(arrayBuffer),
    contentType: asString(res.headers.get("content-type") ?? undefined),
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => asString(item)).filter((item): item is string => Boolean(item));
  }
  const single = asString(value);
  if (!single) return [];
  return [single];
}

function parseAttachment(value: unknown): AgentmailAttachment | null {
  const row = asObject(value);
  const attachmentId = asString(row.attachment_id) ?? asString(row.id);
  if (!attachmentId) return null;
  return {
    attachmentId,
    filename: asString(row.filename),
    size: asNumber(row.size),
    contentType: asString(row.content_type) ?? asString(row.contentType),
    contentDisposition:
      (asString(row.content_disposition) as "inline" | "attachment" | undefined) ??
      (asString(row.contentDisposition) as "inline" | "attachment" | undefined),
    contentId: asString(row.content_id) ?? asString(row.contentId),
  };
}

function parseMessage(value: unknown): AgentmailMessage | null {
  const row = asObject(value);
  const inboxId = asString(row.inbox_id) ?? asString(row.inboxId);
  const messageId = asString(row.message_id) ?? asString(row.messageId) ?? asString(row.id);
  if (!inboxId || !messageId) return null;
  const attachmentsRaw = Array.isArray(row.attachments) ? row.attachments : [];
  return {
    inboxId,
    messageId,
    threadId: asString(row.thread_id) ?? asString(row.threadId),
    from: asString(row.from),
    to: parseStringArray(row.to),
    cc: parseStringArray(row.cc),
    bcc: parseStringArray(row.bcc),
    subject: asString(row.subject),
    text: asString(row.text),
    html: asString(row.html),
    extractedText: asString(row.extracted_text) ?? asString(row.extractedText),
    extractedHtml: asString(row.extracted_html) ?? asString(row.extractedHtml),
    createdAt: asString(row.created_at) ?? asString(row.createdAt),
    updatedAt: asString(row.updated_at) ?? asString(row.updatedAt),
    attachments: attachmentsRaw
      .map(parseAttachment)
      .filter((attachment): attachment is AgentmailAttachment => attachment !== null),
  };
}

function parseInbox(value: unknown): AgentmailInbox | null {
  const row = asObject(value);
  const inboxId = asString(row.inbox_id) ?? asString(row.id);
  if (!inboxId) return null;
  return {
    inboxId,
    email: asString(row.email),
    displayName: asString(row.display_name) ?? asString(row.name),
    clientId: asString(row.client_id),
    username: asString(row.username),
    domain: asString(row.domain),
  };
}

export async function agentmailListInboxes(opts: {
  client: AgentmailClient;
  limit?: number;
  pageToken?: string;
}): Promise<{ inboxes: AgentmailInbox[]; nextPageToken?: string }> {
  const payload = await agentmailFetchJson({
    client: opts.client,
    path: "/v0/inboxes",
    method: "GET",
    query: {
      limit: opts.limit,
      page_token: opts.pageToken,
    },
  });
  const row = asObject(payload);
  const inboxesRaw = Array.isArray(row.inboxes) ? row.inboxes : [];
  const inboxes = inboxesRaw
    .map(parseInbox)
    .filter((inbox): inbox is AgentmailInbox => inbox !== null);
  return {
    inboxes,
    nextPageToken: asString(row.next_page_token),
  };
}

export async function agentmailCreateInbox(opts: {
  client: AgentmailClient;
  username: string;
  domain?: string;
  displayName?: string;
  clientId?: string;
}): Promise<AgentmailInbox> {
  const payload = await agentmailFetchJson({
    client: opts.client,
    path: "/v0/inboxes",
    method: "POST",
    body: {
      username: opts.username,
      domain: opts.domain,
      display_name: opts.displayName,
      client_id: opts.clientId,
    },
  });
  const parsed = parseInbox(payload);
  if (!parsed) {
    throw new Error(`Unable to parse AgentMail inbox response: ${JSON.stringify(payload)}`);
  }
  return parsed;
}

export async function agentmailSendMessage(opts: {
  client: AgentmailClient;
  inboxId: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  attachments?: AgentmailOutgoingAttachment[];
}): Promise<{ messageId?: string; threadId?: string; raw: unknown }> {
  const attachments = (opts.attachments ?? []).map((attachment) => ({
    filename: attachment.filename,
    content_type: attachment.contentType,
    content_disposition: attachment.contentDisposition,
    content_id: attachment.contentId,
    content: attachment.content,
    url: attachment.url,
  }));
  const payload = await agentmailFetchJson({
    client: opts.client,
    path: `/v0/inboxes/${encodeURIComponent(opts.inboxId)}/messages/send`,
    method: "POST",
    body: {
      to: opts.to,
      cc: opts.cc,
      bcc: opts.bcc,
      reply_to: opts.replyTo,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
      attachments: attachments.length > 0 ? attachments : undefined,
    },
  });
  const row = asObject(payload);
  const messageId =
    asString(row.message_id) ??
    asString(row.id) ??
    asString(row.email_id);
  const threadId = asString(row.thread_id) ?? asString(row.threadId);
  return {
    messageId,
    threadId,
    raw: payload,
  };
}

export async function agentmailGetMessage(opts: {
  client: AgentmailClient;
  inboxId: string;
  messageId: string;
}): Promise<AgentmailMessage> {
  const payload = await agentmailFetchJson({
    client: opts.client,
    path: `/v0/inboxes/${encodeURIComponent(opts.inboxId)}/messages/${encodeURIComponent(opts.messageId)}`,
    method: "GET",
  });
  const parsed = parseMessage(payload);
  if (!parsed) {
    throw new Error(`Unable to parse AgentMail message response: ${JSON.stringify(payload)}`);
  }
  return parsed;
}

export async function agentmailGetMessageAttachment(opts: {
  client: AgentmailClient;
  inboxId: string;
  messageId: string;
  attachmentId: string;
}): Promise<AgentmailAttachmentHandle> {
  const payload = await agentmailFetchJson({
    client: opts.client,
    path:
      `/v0/inboxes/${encodeURIComponent(opts.inboxId)}` +
      `/messages/${encodeURIComponent(opts.messageId)}` +
      `/attachments/${encodeURIComponent(opts.attachmentId)}`,
    method: "GET",
  });
  const row = asObject(payload);
  const base = parseAttachment(row);
  const downloadUrl = asString(row.download_url) ?? asString(row.downloadUrl);
  const expiresAt = asString(row.expires_at) ?? asString(row.expiresAt);
  if (!base || !downloadUrl || !expiresAt) {
    throw new Error(`Unable to parse AgentMail attachment response: ${JSON.stringify(payload)}`);
  }
  return {
    ...base,
    downloadUrl,
    expiresAt,
  };
}

export async function agentmailDownloadAttachment(opts: {
  downloadUrl: string;
}): Promise<{ data: Uint8Array; contentType?: string }> {
  return agentmailFetchBinary({
    url: opts.downloadUrl,
    method: "GET",
  });
}
