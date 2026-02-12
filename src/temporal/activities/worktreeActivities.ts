import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type WorktreeInfo = {
  worktreePath: string;
  branchName: string;
};

function safeId(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

export async function createWorktree(opts: {
  repoPath: string;
  worktreesRoot: string;
  issueIdentifier: string;
}): Promise<WorktreeInfo> {
  await fs.mkdir(opts.worktreesRoot, { recursive: true });

  const base = safeId(opts.issueIdentifier);
  let worktreePath = path.resolve(opts.worktreesRoot, base);
  try {
    await fs.access(worktreePath);
    const suffix = crypto.randomBytes(3).toString("hex");
    worktreePath = path.resolve(opts.worktreesRoot, `${base}-${suffix}`);
  } catch {
    // ok
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const branchName = `xena/${base}-${ts}`;

  await execFileAsync("git", ["-C", opts.repoPath, "worktree", "add", "-b", branchName, worktreePath], {
    maxBuffer: 10 * 1024 * 1024,
  });

  return { worktreePath, branchName };
}

