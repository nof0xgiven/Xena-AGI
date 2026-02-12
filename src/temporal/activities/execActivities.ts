import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Context } from "@temporalio/activity";

export type ExecResult = {
  exitCode: number;
  tail: string;
  logPath: string;
  lastMessage?: string;
};

type ExecCliArgs = {
  name: string;
  cwd: string;
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  stdin?: string;
  // If provided, execCli will try to read this file after the command succeeds and
  // return its contents (sanitized) as lastMessage. Useful for CLIs that can write
  // their final/clean output separately from verbose logs.
  lastMessagePath?: string;
};

function tailAppend(current: string, chunk: string, max = 20000): string {
  const next = current + chunk;
  return next.length > max ? next.slice(next.length - max) : next;
}

function sanitizeForLinear(s: string): string {
  // Strip ANSI escape sequences and control characters that make Linear comments unreadable.
  // Keep newlines and tabs.
  const noAnsi = s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  // Drop box-drawing and spinner glyphs commonly produced by CLIs (teddy/codex),
  // which look like "AI noise" in Linear.
  const noBoxes = noAnsi.replace(/[\u2500-\u257F\u25C6]/g, "");
  const noSpinners = noBoxes.replace(/[\u25D0-\u25D3\u25D4-\u25D7]/g, "");
  return noSpinners.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

export async function execCli(opts: ExecCliArgs): Promise<ExecResult> {
  const ctx = Context.current();
  const runDir = path.resolve(process.cwd(), "runs", ctx.info.workflowExecution.workflowId);
  await fs.mkdir(runDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const logPath = path.join(runDir, `${opts.name}.${stamp}.log`);
  const fh = await fs.open(logPath, "a");

  let tail = "";
  if (opts.lastMessagePath) {
    // Best-effort cleanup so stale content doesn't get reused.
    try {
      await fs.rm(opts.lastMessagePath);
    } catch {
      // ignore
    }
  }
  const child = spawn(opts.cmd, opts.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: [opts.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
  });

  const heartbeat = setInterval(() => {
    try {
      ctx.heartbeat({ name: opts.name });
    } catch {
      // ignore
    }
  }, 10_000);

  const onData = (buf: Buffer) => {
    const s = buf.toString("utf8");
    // Keep raw output on disk for debugging, but return a sanitized tail for posting into Linear.
    tail = tailAppend(tail, sanitizeForLinear(s));
    void fh.appendFile(s);
  };

  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  if (opts.stdin != null) {
    child.stdin?.write(opts.stdin);
    child.stdin?.end();
  }

  const exitCode: number = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  clearInterval(heartbeat);
  await fh.close();

  if (exitCode !== 0) {
    throw new Error(
      `Command failed (${opts.name}): ${opts.cmd} ${opts.args.join(" ")} (exit ${exitCode}). Log: ${logPath}\n\nTail:\n${tail}`,
    );
  }

  let lastMessage: string | undefined;
  if (opts.lastMessagePath) {
    try {
      // Large outputs are still chunked at posting time; we just sanitize here.
      const raw = await fs.readFile(opts.lastMessagePath, "utf8");
      const cleaned = sanitizeForLinear(raw).trim();
      if (cleaned.length > 0) lastMessage = cleaned;
    } catch {
      // ignore
    }
  }

  return { exitCode, tail, logPath, lastMessage };
}
