export type VerifiedSource = {
  raw: string;
  url: string;
  domain: string;
  path: string;
};

export type InvalidSource = {
  raw: string;
  reason: string;
};

export type DuplicateSource = {
  raw: string;
  canonicalUrl: string;
};

export type SourceVerificationResult = {
  candidates: string[];
  valid: VerifiedSource[];
  invalid: InvalidSource[];
  duplicates: DuplicateSource[];
};

const MARKDOWN_LINK_REGEX = /\[[^\]]+\]\(([^)\s]+)\)/g;
const BARE_URL_REGEX = /\bhttps?:\/\/[^\s<>"'`|]+/gi;
const TRAILING_PUNCTUATION_REGEX = /[.,;!?]+$/;

const TRACKING_QUERY_PARAM_KEYS = new Set([
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "ref",
  "source",
]);

function uniqueNonEmpty(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function cleanCandidate(candidate: string): string {
  let value = candidate.trim();
  if (value.startsWith("<") && value.endsWith(">")) {
    value = value.slice(1, -1).trim();
  }

  while (TRAILING_PUNCTUATION_REGEX.test(value)) {
    value = value.replace(TRAILING_PUNCTUATION_REGEX, "");
  }
  return value;
}

function normalizeQueryParamKey(key: string): string {
  return key.trim().toLowerCase();
}

function isTrackingParam(key: string): boolean {
  const normalized = normalizeQueryParamKey(key);
  return normalized.startsWith("utm_") || TRACKING_QUERY_PARAM_KEYS.has(normalized);
}

function canonicalizeUrl(candidate: string): { canonical: string; domain: string; path: string } | InvalidSource {
  const cleaned = cleanCandidate(candidate);
  if (!cleaned) {
    return { raw: candidate, reason: "Empty URL candidate." };
  }

  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    return { raw: candidate, reason: "Failed to parse URL." };
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    return { raw: candidate, reason: `Unsupported protocol "${parsed.protocol}".` };
  }

  if (!parsed.hostname) {
    return { raw: candidate, reason: "Missing hostname." };
  }

  parsed.protocol = protocol;
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";

  const pathname = (parsed.pathname || "/").replace(/\/{2,}/g, "/");
  parsed.pathname = pathname !== "/" ? pathname.replace(/\/+$/, "") : "/";

  const sortedParams = Array.from(parsed.searchParams.entries())
    .filter(([key]) => !isTrackingParam(key))
    .sort(([aKey, aValue], [bKey, bValue]) => {
      if (aKey === bKey) return aValue.localeCompare(bValue);
      return aKey.localeCompare(bKey);
    });

  parsed.search = "";
  for (const [key, value] of sortedParams) {
    parsed.searchParams.append(key, value);
  }

  const canonicalPath = parsed.pathname === "/" ? "" : parsed.pathname;
  const canonical = `${parsed.protocol}//${parsed.host}${canonicalPath}${parsed.search}`;

  return {
    canonical,
    domain: parsed.hostname,
    path: parsed.pathname || "/",
  };
}

function toInputArray(input: string | readonly string[]): string[] {
  if (typeof input === "string") return [input];
  return [...input];
}

export function parseSourceUrls(input: string | readonly string[]): string[] {
  const inputs = toInputArray(input);
  const candidates: string[] = [];

  for (const value of inputs) {
    for (const match of value.matchAll(MARKDOWN_LINK_REGEX)) {
      if (match[1]) candidates.push(match[1]);
    }
    for (const match of value.matchAll(BARE_URL_REGEX)) {
      if (match[0]) candidates.push(match[0]);
    }
  }

  return uniqueNonEmpty(candidates);
}

export function verifySourceUrls(input: string | readonly string[]): SourceVerificationResult {
  const candidates = parseSourceUrls(input);
  const seen = new Set<string>();
  const valid: VerifiedSource[] = [];
  const invalid: InvalidSource[] = [];
  const duplicates: DuplicateSource[] = [];

  for (const candidate of candidates) {
    const canonicalized = canonicalizeUrl(candidate);
    if ("reason" in canonicalized) {
      invalid.push(canonicalized);
      continue;
    }

    if (seen.has(canonicalized.canonical)) {
      duplicates.push({ raw: candidate, canonicalUrl: canonicalized.canonical });
      continue;
    }

    seen.add(canonicalized.canonical);
    valid.push({
      raw: candidate,
      url: canonicalized.canonical,
      domain: canonicalized.domain,
      path: canonicalized.path,
    });
  }

  return {
    candidates,
    valid,
    invalid,
    duplicates,
  };
}

export function dedupeSourceUrls(urls: readonly string[]): string[] {
  return verifySourceUrls(urls).valid.map((source) => source.url);
}
