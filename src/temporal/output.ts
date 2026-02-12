export function extractCodexAnswer(raw: string): string {
  const t = raw.trim();
  if (!t) return t;

  // Codex often prints a lot of tooling/progress logs, then a final "codex" block
  // that contains the actual answer. Prefer the final block when present.
  const marker = "\ncodex\n";
  if (t.includes(marker)) {
    const parts = t.split(marker);
    return (parts[parts.length - 1] ?? "").trim();
  }
  if (t.startsWith("codex\n")) return t.slice("codex\n".length).trim();

  // Best-effort scrub for cases where the CLI didn't emit a structured "codex" block.
  // Keep content, drop obvious execution traces.
  const lines = t.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const l = line.trimEnd();
    if (/^thinking\s*$/i.test(l)) continue;
    if (/^exec\s*$/i.test(l)) continue;
    if (/^task interrupted\b/i.test(l)) continue;
    if (/^tokens used\b/i.test(l)) continue;
    if (/^\/bin\/zsh\b/.test(l)) continue;
    if (/\bsucceeded in \d+ms\b/i.test(l)) continue;
    if (/\bexited \d+ in \d+ms\b/i.test(l)) continue;
    kept.push(l);
  }

  return kept.join("\n").trim();
}

