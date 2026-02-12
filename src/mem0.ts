import { isMemoryNamespace, MEMORY_NAMESPACES, type MemoryNamespace } from "./memory/policy.js";

export type Mem0Client = {
  apiKey: string;
  baseUrl: string;
};

export type Mem0SearchEntry = {
  id?: string;
  memory: string;
  metadata: Record<string, unknown>;
  score?: number;
  createdAt?: string;
  updatedAt?: string;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export function createMem0Client(opts: { apiKey: string; baseUrl?: string }): Mem0Client {
  // Default to Mem0 Cloud API base URL. Allow overrides for self-hosted / proxy deployments.
  // If this ever changes upstream, set MEM0_BASE_URL explicitly.
  const baseUrl = normalizeBaseUrl(opts.baseUrl ?? "https://api.mem0.ai");
  return { apiKey: opts.apiKey, baseUrl };
}

async function mem0FetchJson(opts: {
  mem0: Mem0Client;
  path: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}): Promise<unknown> {
  const url = new URL(`${opts.mem0.baseUrl}${opts.path}`);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }

  const hasBody = opts.body !== undefined;
  const method = opts.method ?? "POST";
  const res = await fetch(url, {
    method,
    headers: hasBody
      ? {
          "content-type": "application/json",
          // Mem0 REST expects token auth.
          authorization: `Token ${opts.mem0.apiKey}`,
        }
      : {
          // Mem0 REST expects token auth.
          authorization: `Token ${opts.mem0.apiKey}`,
        },
    body: hasBody ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });

  const text = await res.text();
  if (!res.ok) {
    const snippet = text.length > 4000 ? `${text.slice(0, 4000)}\n...` : text;
    throw new Error(`mem0 request failed (${res.status}) POST ${url}\n\n${snippet}`);
  }

  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toIsoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  return Number.isFinite(value) ? value : undefined;
}

export async function mem0SearchEntries(opts: {
  mem0: Mem0Client;
  query: string;
  userId: string;
  limit?: number;
  namespace?: MemoryNamespace;
  agentId?: string;
  appId?: string;
  runId?: string;
  metadataFilters?: Record<string, unknown>;
}): Promise<Mem0SearchEntry[]> {
  const filters: Record<string, unknown>[] = [{ user_id: opts.userId }];
  if (opts.agentId) {
    filters.push({ agent_id: opts.agentId });
  }
  if (opts.appId) {
    filters.push({ app_id: opts.appId });
  }
  if (opts.runId) {
    filters.push({ run_id: opts.runId });
  }
  if (opts.namespace) {
    filters.push({
      metadata: {
        namespace: opts.namespace,
      },
    });
  }
  if (opts.metadataFilters) {
    for (const [key, value] of Object.entries(opts.metadataFilters)) {
      if (key.trim().length === 0 || value === undefined) continue;
      filters.push({
        metadata: {
          [key]: value,
        },
      });
    }
  }

  const payload = {
    query: opts.query,
    filters: { AND: filters },
    top_k: opts.limit ?? 10,
    version: "v2",
    fields: ["memory", "metadata", "created_at", "updated_at", "user_id"],
  };

  // Mem0 uses v2 for search.
  // Use trailing slash to avoid 301/302 redirects that can downgrade POST -> GET.
  const res = await mem0FetchJson({
    mem0: opts.mem0,
    path: "/v2/memories/search/",
    method: "POST",
    body: payload,
  });

  if (!Array.isArray(res)) {
    if (typeof res === "string" && res.trim()) {
      return [
        {
          memory: res.trim(),
          metadata: {
            namespace: opts.namespace ?? MEMORY_NAMESPACES.TICKET_CONTEXT,
          },
        },
      ];
    }
    return [];
  }

  const entries: Mem0SearchEntry[] = [];
  for (const item of res) {
    if (!item || typeof item !== "object") continue;
    const m = (item as any).memory;
    if (typeof m !== "string" || !m.trim()) continue;

    const metadata = toRecord((item as any).metadata);
    const namespaceValue = metadata.namespace;
    if (!isMemoryNamespace(String(namespaceValue ?? ""))) {
      metadata.namespace = opts.namespace ?? MEMORY_NAMESPACES.TICKET_CONTEXT;
    }

    entries.push({
      id: typeof (item as any).id === "string" ? (item as any).id : undefined,
      memory: m.trim(),
      metadata,
      score: toFiniteNumber((item as any).score),
      createdAt: toIsoOrUndefined((item as any).created_at),
      updatedAt: toIsoOrUndefined((item as any).updated_at),
    });
  }

  return entries;
}

export async function mem0Search(opts: {
  mem0: Mem0Client;
  query: string;
  userId: string;
  limit?: number;
  namespace?: MemoryNamespace;
  agentId?: string;
  appId?: string;
  runId?: string;
  metadataFilters?: Record<string, unknown>;
}): Promise<string> {
  const entries = await mem0SearchEntries(opts);

  const lines: string[] = [];
  for (const entry of entries) {
    const mdIssue = typeof entry.metadata.issue === "string" ? entry.metadata.issue : null;
    lines.push(mdIssue ? `- (${mdIssue}) ${entry.memory}` : `- ${entry.memory}`);
  }
  return lines.join("\n");
}

export async function mem0Add(opts: {
  mem0: Mem0Client;
  content: string;
  userId: string;
  metadata?: Record<string, unknown>;
  namespace?: MemoryNamespace;
  infer?: boolean;
  enableGraph?: boolean;
  agentId?: string;
  appId?: string;
  runId?: string;
}): Promise<void> {
  const namespace = opts.namespace ?? MEMORY_NAMESPACES.TICKET_CONTEXT;
  const infer = typeof opts.infer === "boolean" ? opts.infer : opts.enableGraph === true;

  const payload: Record<string, unknown> = {
    messages: [{ role: "user", content: opts.content }],
    user_id: opts.userId,
    metadata: {
      ...(opts.metadata ?? {}),
      namespace,
    },
    infer,
  };
  if (opts.enableGraph) {
    payload.enable_graph = true;
  }
  if (opts.agentId) {
    payload.agent_id = opts.agentId;
  }
  if (opts.appId) {
    payload.app_id = opts.appId;
  }
  if (opts.runId) {
    payload.run_id = opts.runId;
  }

  // Mem0 uses v1 for add.
  await mem0FetchJson({
    mem0: opts.mem0,
    path: "/v1/memories/",
    method: "POST",
    body: payload,
  });
}

function parseListResponse(response: unknown): {
  rows: unknown[];
  nextPage: number | null;
} {
  if (Array.isArray(response)) {
    return {
      rows: response,
      nextPage: null,
    };
  }

  if (!response || typeof response !== "object") {
    return {
      rows: [],
      nextPage: null,
    };
  }

  const rows = Array.isArray((response as any).results) ? ((response as any).results as unknown[]) : [];
  const next = typeof (response as any).next === "string" ? (response as any).next : null;
  if (!next) {
    return {
      rows,
      nextPage: null,
    };
  }

  try {
    const nextUrl = new URL(next);
    const pageValue = nextUrl.searchParams.get("page");
    const page = pageValue ? Number.parseInt(pageValue, 10) : Number.NaN;
    if (Number.isFinite(page) && page > 0) {
      return {
        rows,
        nextPage: page,
      };
    }
  } catch {
    // ignore and fall back to no next page.
  }

  return {
    rows,
    nextPage: null,
  };
}

function matchesMetadataFilters(metadata: Record<string, unknown>, filters?: Record<string, unknown>): boolean {
  if (!filters) return true;
  for (const [key, expected] of Object.entries(filters)) {
    if (!key.trim()) continue;
    if (expected === undefined) continue;
    const actual = metadata[key];
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual)) return false;
      for (const value of expected) {
        if (!actual.includes(value)) return false;
      }
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

export async function mem0ListEntries(opts: {
  mem0: Mem0Client;
  userId: string;
  namespace?: MemoryNamespace;
  agentId?: string;
  appId?: string;
  runId?: string;
  page?: number;
  pageSize?: number;
  metadataFilters?: Record<string, unknown>;
}): Promise<{
  entries: Mem0SearchEntry[];
  nextPage: number | null;
}> {
  const response = await mem0FetchJson({
    mem0: opts.mem0,
    path: "/v1/memories/",
    method: "GET",
    query: {
      user_id: opts.userId,
      agent_id: opts.agentId,
      app_id: opts.appId,
      run_id: opts.runId,
      page: opts.page ?? 1,
      page_size: opts.pageSize ?? 100,
    },
  });

  const parsed = parseListResponse(response);
  const entries: Mem0SearchEntry[] = [];
  for (const item of parsed.rows) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;

    const memoryValue =
      typeof row.memory === "string" && row.memory.trim()
        ? row.memory.trim()
        : typeof row.data === "object" &&
            row.data !== null &&
            typeof (row.data as Record<string, unknown>).memory === "string" &&
            ((row.data as Record<string, unknown>).memory as string).trim()
          ? ((row.data as Record<string, unknown>).memory as string).trim()
          : "";
    if (!memoryValue) continue;

    const metadata = toRecord(row.metadata);
    const namespaceValue = metadata.namespace;
    if (!isMemoryNamespace(String(namespaceValue ?? ""))) {
      metadata.namespace = MEMORY_NAMESPACES.TICKET_CONTEXT;
    }
    if (opts.namespace && metadata.namespace !== opts.namespace) continue;
    if (!matchesMetadataFilters(metadata, opts.metadataFilters)) continue;

    entries.push({
      id: typeof row.id === "string" ? row.id : undefined,
      memory: memoryValue,
      metadata,
      score: toFiniteNumber(row.score),
      createdAt: toIsoOrUndefined(row.created_at),
      updatedAt: toIsoOrUndefined(row.updated_at),
    });
  }

  return {
    entries,
    nextPage: parsed.nextPage,
  };
}

export async function mem0Delete(opts: {
  mem0: Mem0Client;
  memoryId: string;
}): Promise<void> {
  const memoryId = opts.memoryId.trim();
  if (!memoryId) return;
  await mem0FetchJson({
    mem0: opts.mem0,
    path: `/v1/memories/${encodeURIComponent(memoryId)}/`,
    method: "DELETE",
  });
}
