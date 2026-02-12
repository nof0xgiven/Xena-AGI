import crypto from "node:crypto";

export function verifyLinearWebhookSignature(opts: {
  webhookSecret: string;
  rawBody: Buffer;
  signatureHeader: string | undefined;
}): boolean {
  const sig = opts.signatureHeader;
  if (!sig) return false;

  const computed = crypto
    .createHmac("sha256", opts.webhookSecret)
    .update(opts.rawBody)
    .digest("hex");

  // Linear docs: signature is the hex digest (no prefix). Compare in constant time.
  try {
    return crypto.timingSafeEqual(
      Buffer.from(computed, "hex"),
      Buffer.from(sig, "hex"),
    );
  } catch {
    return false;
  }
}

