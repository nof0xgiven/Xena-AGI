import crypto from "node:crypto";

type ManusWebhookPublicKeyResponse = {
  public_key?: string;
  publicKey?: string;
};

export type VerifyManusWebhookSignatureInput = {
  apiKey?: string;
  baseUrl?: string;
  pinnedPublicKeyPem?: string;
  requestUrl: string;
  rawBody: Buffer;
  signatureHeader?: string;
  timestampHeader?: string;
  nowMs?: number;
};

export type VerifyManusWebhookSignatureResult = {
  ok: boolean;
  reason?: string;
};

const PUBLIC_KEY_CACHE_TTL_MS = 10 * 60 * 1000;
let cachedPublicKey: { key: string; fetchedAt: number; cacheKey: string } | null = null;

function normalizeBaseUrl(value: string | undefined): string {
  const raw = (value ?? "https://api.manus.ai/v1").trim();
  return raw.replace(/\/+$/, "");
}

async function fetchManusWebhookPublicKey(opts: {
  apiKey?: string;
  baseUrl?: string;
}): Promise<string> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const cacheKey = `${baseUrl}|${opts.apiKey ? "with-key" : "no-key"}`;
  const now = Date.now();
  if (
    cachedPublicKey &&
    cachedPublicKey.cacheKey === cacheKey &&
    now - cachedPublicKey.fetchedAt <= PUBLIC_KEY_CACHE_TTL_MS
  ) {
    return cachedPublicKey.key;
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (opts.apiKey?.trim()) {
    headers.API_KEY = opts.apiKey.trim();
  }

  const response = await fetch(`${baseUrl}/webhook/public_key`, {
    method: "GET",
    headers,
  });
  if (!response.ok) {
    throw new Error(`public key fetch failed (${response.status})`);
  }
  const payload = (await response.json()) as ManusWebhookPublicKeyResponse;
  const publicKey = (payload.public_key ?? payload.publicKey ?? "").trim();
  if (!publicKey) {
    throw new Error("public key payload missing public_key");
  }

  cachedPublicKey = {
    key: publicKey,
    fetchedAt: now,
    cacheKey,
  };
  return publicKey;
}

export async function verifyManusWebhookSignature(
  opts: VerifyManusWebhookSignatureInput,
): Promise<VerifyManusWebhookSignatureResult> {
  const signature = opts.signatureHeader?.trim();
  const timestampRaw = opts.timestampHeader?.trim();
  if (!signature) return { ok: false, reason: "missing X-Webhook-Signature header" };
  if (!timestampRaw) return { ok: false, reason: "missing X-Webhook-Timestamp header" };

  const timestamp = Number.parseInt(timestampRaw, 10);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, reason: "invalid webhook timestamp" };
  }
  const nowSeconds = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestamp) > 300) {
    return { ok: false, reason: "timestamp outside 5 minute verification window" };
  }

  const bodyHashHex = crypto.createHash("sha256").update(opts.rawBody).digest("hex");
  const signatureContent = `${timestampRaw}.${opts.requestUrl}.${bodyHashHex}`;
  const contentHash = crypto.createHash("sha256").update(signatureContent).digest();

  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signature, "base64");
  } catch {
    return { ok: false, reason: "invalid base64 signature" };
  }
  if (signatureBytes.length === 0) {
    return { ok: false, reason: "empty signature payload" };
  }

  let publicKeyPem: string;
  try {
    publicKeyPem = opts.pinnedPublicKeyPem?.trim()
      ? opts.pinnedPublicKeyPem.trim()
      : await fetchManusWebhookPublicKey({
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `unable to resolve Manus public key: ${detail}` };
  }

  try {
    const verified = crypto.verify("RSA-SHA256", contentHash, publicKeyPem, signatureBytes);
    return verified ? { ok: true } : { ok: false, reason: "signature verification failed" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `signature verification error: ${detail}` };
  }
}
