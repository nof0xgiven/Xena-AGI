import { loadWorkerEnv } from "../../env.js";
import { execCli } from "./execActivities.js";

export type PrCheck = {
  name: string;
  conclusion: string; // e.g. SUCCESS | FAILURE | SKIPPED | ""
  status: string; // e.g. COMPLETED | IN_PROGRESS | ""
  detailsUrl: string;
};

function resolveGhToken(): string | undefined {
  const env = loadWorkerEnv();
  return env.GH_TOKEN ?? env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
}

function parseRepoSlugFromOrigin(originUrl: string): string | null {
  const u = originUrl.trim();
  // git@github.com:OWNER/REPO.git
  let m = u.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (m) return m[1];
  // https://github.com/OWNER/REPO.git
  m = u.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (m) return m[1];
  return null;
}

export async function gitGetOriginRepoSlug(opts: { repoPath: string }): Promise<string> {
  const out = await execCli({
    name: "git-origin",
    cwd: opts.repoPath,
    cmd: "git",
    args: ["remote", "get-url", "origin"],
  });
  const origin = out.tail.trim().split(/\s+/)[0] ?? "";
  const slug = parseRepoSlugFromOrigin(origin);
  if (!slug) {
    throw new Error(`Unable to parse GitHub repo slug from origin URL: ${origin}`);
  }
  return slug;
}

export async function gitGetDefaultBaseBranch(opts: { repoPath: string }): Promise<string> {
  try {
    const out = await execCli({
      name: "git-origin-head",
      cwd: opts.repoPath,
      cmd: "git",
      args: ["symbolic-ref", "refs/remotes/origin/HEAD"],
    });
    const ref = out.tail.trim();
    const m = ref.match(/^refs\/remotes\/origin\/(.+)$/);
    if (m) return m[1];
  } catch {
    // fall through
  }

  try {
    const out = await execCli({
      name: "git-remote-show",
      cwd: opts.repoPath,
      cmd: "git",
      args: ["remote", "show", "origin"],
    });
    const m = out.tail.match(/HEAD branch:\s*(\S+)/);
    if (m) return m[1];
  } catch {
    // fall through
  }

  // Last-resort default. We keep this deterministic and explicit.
  return "main";
}

export async function gitCommitIfNeeded(opts: {
  worktreePath: string;
  issueIdentifier: string;
  issueTitle: string;
}): Promise<{ committed: boolean }> {
  const status = await execCli({
    name: "git-status",
    cwd: opts.worktreePath,
    cmd: "git",
    args: ["status", "--porcelain"],
  });
  const dirty = status.tail.trim().length > 0;
  if (!dirty) return { committed: false };

  await execCli({
    name: "git-add",
    cwd: opts.worktreePath,
    cmd: "git",
    args: ["add", "-A"],
  });

  const msg = `${opts.issueIdentifier}: ${opts.issueTitle}`.trim();
  await execCli({
    name: "git-commit",
    cwd: opts.worktreePath,
    cmd: "git",
    args: ["-c", "core.editor=true", "commit", "-m", msg],
    env: {
      GIT_EDITOR: "true",
    },
  });

  return { committed: true };
}

export async function gitPushBranch(opts: { worktreePath: string; branchName: string }): Promise<void> {
  await execCli({
    name: "git-push",
    cwd: opts.worktreePath,
    cmd: "git",
    args: ["push", "-u", "origin", opts.branchName],
  });
}

export async function gitGetLastCommitSummary(opts: { worktreePath: string; maxFiles?: number }): Promise<string> {
  const out = await execCli({
    name: "git-show-summary",
    cwd: opts.worktreePath,
    cmd: "git",
    args: ["show", "--name-status", "--no-color", "--pretty=format:%s", "HEAD"],
  });

  const lines = out.tail.split("\n").map((l) => l.trim()).filter(Boolean);
  const subject = lines[0] ?? "Changes";
  const files = lines.slice(1);

  const maxFiles = opts.maxFiles ?? 10;
  const bullets: string[] = [];
  for (const l of files.slice(0, maxFiles)) {
    const m = l.match(/^([A-Z])\s+(.+)$/);
    if (!m) continue;
    const code = m[1];
    const p = m[2];
    const label =
      code === "A" ? "Added" : code === "M" ? "Modified" : code === "D" ? "Deleted" : "Changed";
    bullets.push(`- ${label}: \`${p}\``);
  }
  if (files.length > maxFiles) bullets.push(`- (+${files.length - maxFiles} more files)`);

  return [`- ${subject}`, ...bullets].join("\n");
}

export async function ghFindPrUrlForBranch(opts: {
  worktreePath: string;
  repoSlug: string;
  branchName: string;
}): Promise<string | null> {
  const token = resolveGhToken();
  try {
    const out = await execCli({
      name: "gh-pr-view",
      cwd: opts.worktreePath,
      cmd: "gh",
      args: ["pr", "view", "--repo", opts.repoSlug, "--head", opts.branchName, "--json", "url"],
      env: token ? { GH_TOKEN: token } : undefined,
    });
    const m = out.tail.match(/"url"\s*:\s*"([^"]+)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export async function ghCreatePr(opts: {
  worktreePath: string;
  repoSlug: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
}): Promise<string> {
  const token = resolveGhToken();

  const existing = await ghFindPrUrlForBranch({
    worktreePath: opts.worktreePath,
    repoSlug: opts.repoSlug,
    branchName: opts.headBranch,
  });
  if (existing) return existing;

  const out = await execCli({
    name: "gh-pr-create",
    cwd: opts.worktreePath,
    cmd: "gh",
    args: [
      "pr",
      "create",
      "--repo",
      opts.repoSlug,
      "--base",
      opts.baseBranch,
      "--head",
      opts.headBranch,
      "--title",
      opts.title,
      "--body",
      opts.body,
    ],
    // If GH_TOKEN isn't provided, fall back to `gh auth login` credentials on disk.
    env: token ? { GH_TOKEN: token } : undefined,
  });

  const m = out.tail.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
  if (!m) {
    throw new Error(`Unable to extract PR URL from gh output.\n\nTail:\n${out.tail}`);
  }
  return m[0];
}

export async function ghGetPrChecks(opts: {
  worktreePath: string;
  repoSlug: string;
  prNumber: number;
}): Promise<PrCheck[]> {
  const token = resolveGhToken();
  const out = await execCli({
    name: "gh-pr-checks",
    cwd: opts.worktreePath,
    cmd: "gh",
    args: [
      "pr",
      "view",
      String(opts.prNumber),
      "--repo",
      opts.repoSlug,
      "--json",
      "statusCheckRollup",
      "--jq",
      '.statusCheckRollup[] | [.name, (.conclusion // \"\"), (.status // \"\"), (.detailsUrl // \"\")] | @tsv',
    ],
    env: token ? { GH_TOKEN: token } : undefined,
  });

  const lines = out.tail
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean);

  const checks: PrCheck[] = [];
  for (const l of lines) {
    const [name, conclusion, status, detailsUrl] = l.split("\t");
    if (!name) continue;
    checks.push({
      name: name.trim(),
      conclusion: (conclusion ?? "").trim(),
      status: (status ?? "").trim(),
      detailsUrl: (detailsUrl ?? "").trim(),
    });
  }
  return checks;
}

export async function ghListPrFiles(opts: {
  worktreePath: string;
  repoSlug: string;
  prNumber: number;
}): Promise<string[]> {
  const token = resolveGhToken();
  const out = await execCli({
    name: "gh-pr-files",
    cwd: opts.worktreePath,
    cmd: "gh",
    args: [
      "pr",
      "view",
      String(opts.prNumber),
      "--repo",
      opts.repoSlug,
      "--json",
      "files",
      "--jq",
      ".files[].path",
    ],
    env: token ? { GH_TOKEN: token } : undefined,
  });

  return out.tail
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
