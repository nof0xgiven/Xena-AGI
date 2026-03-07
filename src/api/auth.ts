import { timingSafeEqual } from "node:crypto";

export const WEBHOOK_TOKEN_HEADER = "x-xena-webhook-token";

function readBearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) {
    return null;
  }

  const [scheme, ...rest] = headerValue.trim().split(/\s+/);

  if (scheme?.toLowerCase() !== "bearer" || rest.length === 0) {
    return null;
  }

  const token = rest.join(" ").trim();

  return token.length > 0 ? token : null;
}

function tokenMatches(expectedToken: string, providedToken: string | null): boolean {
  const expectedBuffer = Buffer.from(expectedToken, "utf8");
  const providedBuffer = Buffer.from(providedToken ?? "", "utf8");

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

export function isAuthorizedApiRequest(
  authorizationHeader: string | undefined,
  expectedToken: string
): boolean {
  return tokenMatches(expectedToken, readBearerToken(authorizationHeader));
}

export function isAuthorizedWebhookRequest(
  headerValue: string | undefined,
  expectedToken: string
): boolean {
  return tokenMatches(expectedToken, headerValue?.trim() ?? null);
}
