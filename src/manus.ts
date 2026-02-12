export type ManusClient = {
  apiKey: string;
  baseUrl: string;
};

export type ManusTaskCreateResponse = {
  id: string;
  status: string;
  createdAt?: string;
  taskUrl?: string;
  shareUrl?: string;
};

export type ManusTaskFile = {
  id?: string;
  name: string;
  url: string;
};

export type ManusTaskDetail = {
  id: string;
  status: string;
  result: {
    text?: string;
    files: ManusTaskFile[];
  };
  error?: string;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
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

async function manusFetchJson(opts: {
  client: ManusClient;
  path: string;
  method: "GET" | "POST";
  body?: unknown;
}): Promise<unknown> {
  const url = `${opts.client.baseUrl}${opts.path}`;
  const hasBody = opts.body !== undefined;
  const res = await fetch(url, {
    method: opts.method,
    headers: hasBody
      ? {
          API_KEY: opts.client.apiKey,
          accept: "application/json",
          "content-type": "application/json",
        }
      : {
          API_KEY: opts.client.apiKey,
          accept: "application/json",
        },
    body: hasBody ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });

  const text = await res.text();
  if (!res.ok) {
    const snippet = text.length > 4000 ? `${text.slice(0, 4000)}\n...` : text;
    throw new Error(`Manus API request failed (${res.status}) ${opts.method} ${url}\n\n${snippet}`);
  }

  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseManusFile(raw: unknown): ManusTaskFile | null {
  const row = asObject(raw);
  const url = asString(row.url);
  const name = asString(row.name) ?? asString(row.file_name);
  if (!url || !name) return null;
  return {
    id: asString(row.id),
    name,
    url,
  };
}

function parseTaskCreate(raw: unknown): ManusTaskCreateResponse {
  const row = asObject(raw);
  const id = asString(row.id) ?? asString(row.task_id);
  const status = asString(row.status) ?? "pending";
  if (!id) {
    throw new Error(`Unable to parse Manus task create response: ${JSON.stringify(raw)}`);
  }
  return {
    id,
    status,
    createdAt: asString(row.created_at) ?? asString(row.createdAt),
    taskUrl: asString(row.task_url) ?? asString(row.taskUrl),
    shareUrl: asString(row.share_url) ?? asString(row.shareUrl),
  };
}

function parseOutputPayload(row: Record<string, unknown>): {
  text?: string;
  files: ManusTaskFile[];
} {
  const output = Array.isArray(row.output) ? row.output : [];
  const textParts: string[] = [];
  const files = new Map<string, ManusTaskFile>();

  for (const message of output) {
    const msg = asObject(message);
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const contentItem of content) {
      const item = asObject(contentItem);
      const text = asString(item.text);
      if (text) textParts.push(text);

      const fileUrl = asString(item.fileUrl) ?? asString(item.file_url);
      const fileName = asString(item.fileName) ?? asString(item.file_name);
      if (fileUrl) {
        const key = `${fileName ?? "file"}::${fileUrl}`;
        if (!files.has(key)) {
          files.set(key, {
            id: asString(item.id),
            name: fileName ?? "artifact",
            url: fileUrl,
          });
        }
      }
    }
  }

  return {
    text: textParts.length > 0 ? textParts.join("\n\n").trim() : undefined,
    files: [...files.values()],
  };
}

function parseTaskDetail(raw: unknown): ManusTaskDetail {
  const row = asObject(raw);
  const id = asString(row.id) ?? asString(row.task_id);
  const status = asString(row.status);
  const result = asObject(row.result);
  const parsedOutput = parseOutputPayload(row);
  const filesRaw = Array.isArray(result.files) ? result.files : [];
  const resultFiles = [
    ...filesRaw.map(parseManusFile).filter((file): file is ManusTaskFile => file !== null),
    ...parsedOutput.files,
  ];
  const fileDedup = new Map<string, ManusTaskFile>();
  for (const file of resultFiles) {
    fileDedup.set(`${file.name}::${file.url}`, file);
  }
  if (!id || !status) {
    throw new Error(`Unable to parse Manus task detail response: ${JSON.stringify(raw)}`);
  }
  return {
    id,
    status,
    result: {
      text: asString(result.text) ?? parsedOutput.text ?? asString(row.message),
      files: [...fileDedup.values()],
    },
    error: asString(row.error),
  };
}

export function createManusClient(opts: { apiKey: string; baseUrl?: string }): ManusClient {
  return {
    apiKey: opts.apiKey,
    baseUrl: normalizeBaseUrl(opts.baseUrl ?? "https://api.manus.ai/v1"),
  };
}

export async function manusCreateTask(opts: {
  client: ManusClient;
  prompt: string;
  webhookUrl?: string;
}): Promise<ManusTaskCreateResponse> {
  const payload: Record<string, unknown> = {
    prompt: opts.prompt,
  };
  if (opts.webhookUrl) payload.webhook_url = opts.webhookUrl;

  const raw = await manusFetchJson({
    client: opts.client,
    path: "/tasks",
    method: "POST",
    body: payload,
  });
  return parseTaskCreate(raw);
}

export async function manusGetTask(opts: {
  client: ManusClient;
  taskId: string;
}): Promise<ManusTaskDetail> {
  const raw = await manusFetchJson({
    client: opts.client,
    path: `/tasks/${encodeURIComponent(opts.taskId)}`,
    method: "GET",
  });
  return parseTaskDetail(raw);
}

export async function manusCancelTask(opts: {
  client: ManusClient;
  taskId: string;
}): Promise<void> {
  const taskId = encodeURIComponent(opts.taskId);
  try {
    await manusFetchJson({
      client: opts.client,
      path: `/tasks/${taskId}/cancel`,
      method: "POST",
    });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("(404)")) {
      throw error;
    }
  }

  await manusFetchJson({
    client: opts.client,
    path: `/tasks/${taskId}/stop`,
    method: "POST",
  });
}
