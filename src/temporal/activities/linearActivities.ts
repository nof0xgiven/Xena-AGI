import { createLinearClient, chunkComment } from "../../linear.js";
import { loadWorkerEnv } from "../../env.js";
import { logger } from "../../logger.js";

export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  teamKey: string;
  labels: string[];
};

function linear() {
  const env = loadWorkerEnv();
  return createLinearClient(env.LINEAR_API_KEY);
}

export async function linearGetIssue(opts: { issueId: string }): Promise<LinearIssue> {
  const lc = linear();
  const issue = await lc.issue(opts.issueId);
  if (!issue) throw new Error(`Linear issue not found: ${opts.issueId}`);
  const team = await issue.team;
  if (!team) throw new Error(`Linear issue missing team: ${opts.issueId}`);
  const labelsConn = await (issue as any).labels({ first: 50 });
  const labels =
    ((labelsConn?.nodes as any[]) ?? [])
      .map((l) => (typeof l?.name === "string" ? l.name.trim() : ""))
      .filter(Boolean) ?? [];
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? null,
    teamKey: team.key,
    labels,
  };
}

export async function linearEnsureInProgress(opts: { issueId: string }): Promise<{ changed: boolean }> {
  const lc = linear();
  const issue = await lc.issue(opts.issueId);
  if (!issue) throw new Error(`Linear issue not found: ${opts.issueId}`);

  const state = await (issue as any).state;
  const stateType = state?.type as string | undefined; // "unstarted" | "started" | "completed" | "canceled"
  const stateName = (state?.name as string | undefined) ?? "";

  if (stateType === "completed" || stateType === "canceled") return { changed: false };
  if (stateType === "started") return { changed: false };
  if (/in progress|in development/i.test(stateName)) return { changed: false };

  const team = await issue.team;
  if (!team) throw new Error(`Linear issue missing team: ${opts.issueId}`);

  const statesConn = await (team as any).states({ first: 50 });
  const states = (statesConn?.nodes as any[]) ?? [];
  const started = states.filter((s) => s?.type === "started");

  const preferred =
    started.find((s) => typeof s?.name === "string" && /in progress/i.test(s.name)) ??
    started.find((s) => typeof s?.name === "string" && /in development/i.test(s.name)) ??
    started[0];

  if (!preferred?.id) {
    logger.warn({ issueId: opts.issueId }, "No started state found; cannot move issue to in progress");
    return { changed: false };
  }

  await lc.updateIssue(issue.id, { stateId: preferred.id });
  return { changed: true };
}

export async function linearPostComment(opts: { issueId: string; body: string }): Promise<void> {
  const lc = linear();
  await lc.createComment({ issueId: opts.issueId, body: opts.body });
}

export async function linearPostLongComment(opts: {
  issueId: string;
  header: string;
  body: string;
}): Promise<void> {
  const lc = linear();
  const chunks = chunkComment(opts.body);
  for (let i = 0; i < chunks.length; i++) {
    const suffix = chunks.length > 1 ? ` (part ${i + 1}/${chunks.length})` : "";
    await lc.createComment({
      issueId: opts.issueId,
      body: `${opts.header}${suffix}\n\n${chunks[i]}`,
    });
  }
}

export async function linearFindLatestPlan(opts: { issueId: string }): Promise<string | null> {
  const lc = linear();
  const issue = await lc.issue(opts.issueId);
  if (!issue) throw new Error(`Linear issue not found: ${opts.issueId}`);
  const commentsConn = await issue.comments({ first: 50 });
  const nodes = commentsConn.nodes ?? [];
  for (const c of nodes.slice().reverse()) {
    const body = c.body ?? "";
    // Preferred marker (hidden in Linear UI).
    const marker = "<!--xena:plan-->";
    if (body.includes(marker)) {
      const after = body.split(marker, 2)[1] ?? "";
      return after.trim();
    }
    // Back-compat with older visible headers.
    if (body.startsWith("[xena][plan] Plan")) {
      const idx = body.indexOf("\n\n");
      return idx >= 0 ? body.slice(idx + 2).trim() : body.trim();
    }
    if (body.startsWith("# Task:")) return body;
  }
  logger.warn({ issueId: opts.issueId }, "No plan found in recent comments");
  return null;
}

export type LinearComment = {
  id: string;
  body: string;
  createdAt: string;
  userId: string | null;
};

export async function linearListRecentComments(opts: {
  issueId: string;
  first?: number;
}): Promise<LinearComment[]> {
  const lc = linear();
  const issue = await lc.issue(opts.issueId);
  if (!issue) throw new Error(`Linear issue not found: ${opts.issueId}`);
  const commentsConn = await issue.comments({ first: opts.first ?? 50 });
  const nodes = commentsConn.nodes ?? [];
  return nodes
    .map((c) => ({
      id: c.id,
      body: c.body ?? "",
      createdAt:
        c.createdAt instanceof Date
          ? c.createdAt.toISOString()
          : typeof (c as any).createdAt === "string"
            ? (c as any).createdAt
            : new Date().toISOString(),
      userId: (c.user as any)?.id ?? null,
    }))
    .filter((c) => c.id && c.body != null);
}

export async function linearFindLatestDiscoveryOutput(opts: { issueId: string }): Promise<string | null> {
  const lc = linear();
  const issue = await lc.issue(opts.issueId);
  if (!issue) throw new Error(`Linear issue not found: ${opts.issueId}`);
  const commentsConn = await issue.comments({ first: 50 });
  const nodes = commentsConn.nodes ?? [];
  for (const c of nodes.slice().reverse()) {
    const body = c.body ?? "";
    const marker = "<!--xena:discover-->";
    if (body.includes(marker)) {
      const after = body.split(marker, 2)[1] ?? "";
      return after.trim();
    }
    if (body.startsWith("[xena][discover] Output")) {
      const idx = body.indexOf("\n\n");
      return idx >= 0 ? body.slice(idx + 2).trim() : body.trim();
    }
  }
  return null;
}
