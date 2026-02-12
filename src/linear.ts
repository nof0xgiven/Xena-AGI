import { LinearClient } from "@linear/sdk";

export type Linear = LinearClient;

export function createLinearClient(apiKey: string): LinearClient {
  return new LinearClient({ apiKey });
}

export async function postComment(opts: {
  linear: LinearClient;
  issueId: string;
  body: string;
}): Promise<void> {
  await opts.linear.createComment({
    issueId: opts.issueId,
    body: opts.body,
  });
}

export function chunkComment(body: string, maxLen = 9000): string[] {
  if (body.length <= maxLen) return [body];
  const parts: string[] = [];
  let rest = body;

  while (rest.length > maxLen) {
    const window = rest.slice(0, maxLen + 1);
    // Prefer splitting on paragraph boundaries, then line boundaries.
    let cut = window.lastIndexOf("\n\n");
    if (cut < 0) cut = window.lastIndexOf("\n");

    // If we couldn't find a reasonable boundary, fall back to a hard cut.
    if (cut < 0 || cut < Math.floor(maxLen * 0.5)) cut = maxLen;

    const chunk = rest.slice(0, cut).trimEnd();
    parts.push(chunk);
    rest = rest.slice(cut).replace(/^\n+/, "");
  }

  if (rest.trim().length > 0) parts.push(rest);
  return parts;
}
