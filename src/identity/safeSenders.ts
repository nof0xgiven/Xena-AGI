export const DEFAULT_SAFE_SENDER_EMAILS = [] as const;

function normalizeEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  return normalized;
}

export function parseSafeSenderEmails(raw: string | undefined): string[] {
  if (!raw) return [];
  const parts = raw.split(/[,\n;]+/g);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const email = normalizeEmail(part);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

export function normalizeSafeSenderList(emails: readonly string[] | undefined): string[] {
  if (!emails || emails.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const email of emails) {
    const normalized = normalizeEmail(email);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function resolveSafeSenderEmails(raw: string | undefined): string[] {
  const parsed = parseSafeSenderEmails(raw);
  if (parsed.length > 0) return parsed;
  return [...DEFAULT_SAFE_SENDER_EMAILS];
}

export function resolveSafeSenderList(emails: readonly string[] | undefined): string[] {
  const parsed = normalizeSafeSenderList(emails);
  if (parsed.length > 0) return parsed;
  return [...DEFAULT_SAFE_SENDER_EMAILS];
}

export function isSafeSenderEmail(email: string | null | undefined, safeList: readonly string[]): boolean {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  return safeList.includes(normalized);
}
