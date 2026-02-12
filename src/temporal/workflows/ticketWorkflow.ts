import {
  condition,
  patched,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
} from "@temporalio/workflow";
import type * as activities from "../activities/index.js";
import type { LinearCommentSignal, TicketArgs, TicketWakeSignal } from "../shared.js";
import { discoverWorkflow } from "./discoverWorkflow.js";
import { planWorkflow } from "./planWorkflow.js";
import { codeWorkflow } from "./codeWorkflow.js";
import { QUERY_TICKET_STATUS, SIGNAL_LINEAR_COMMENT, SIGNAL_TICKET_WAKE } from "../signals.js";

type MetaActivities = Omit<typeof activities, "execCli" | "createWorktree">;
type LongActivities = Pick<typeof activities, "execCli" | "createWorktree">;
type QaActivities = Pick<typeof activities, "hyperbrowserSmoke">;

const meta = proxyActivities<MetaActivities>({
  startToCloseTimeout: "5 minutes",
  retry: {
    maximumAttempts: 5,
    initialInterval: "2 seconds",
    maximumInterval: "1 minute",
  },
});

const long = proxyActivities<LongActivities>({
  startToCloseTimeout: "72 hours",
  heartbeatTimeout: "60 seconds",
  retry: {
    maximumAttempts: 1,
  },
});

const qa = proxyActivities<QaActivities>({
  startToCloseTimeout: "30 minutes",
  heartbeatTimeout: "30 seconds",
  retry: {
    maximumAttempts: 1,
  },
});

type Stage =
  | "started"
  | "discovering"
  | "planning"
  | "coding"
  | "creating_pr"
  | "waiting_sandbox"
  | "waiting_smoke"
  | "handoff"
  | "blocked"
  | "failed"
  | "completed";

type TicketStatus = {
  issueId: string;
  stage: Stage;
  resumeStage?: Stage;
  reviewAttempts: number;
  smokeAttempts: number;
  prUrl?: string;
  sandboxUrl?: string;
  worktreePath?: string;
  branchName?: string;
  blockedReason?: string;
  lastError?: string;
};

const KNOWN_COMMANDS = new Set(["help", "status", "stop", "continue", "sandbox", "smoke"]);

function parseCommand(
  body: string,
  opts: { allowFriendlyMentions: boolean },
): { cmd: string; args: string; explicit: boolean } | null {
  const t = body.trim();
  const lower = t.toLowerCase();
  // Supported control prefixes:
  // - "/xena ..." (explicit command)
  // - "xena ..."  (teammate-style, less botty)
  // - "@xena ..." (if users naturally type it)
  let rest: string | null = null;
  let explicit = false;
  if (lower.startsWith("/xena")) {
    rest = t.slice("/xena".length).trim();
    explicit = true;
  } else if (lower.startsWith("@xena")) rest = t.slice("@xena".length).trim();
  else if (lower.startsWith("xena")) rest = t.slice("xena".length).trim();
  if (rest == null) return null;
  const m = rest.match(/^(\S+)(?:\s+(.*))?$/);
  if (!m) return { cmd: "help", args: "", explicit };

  const cmd = m[1].toLowerCase();
  const args = (m[2] ?? "").trim();

  // If someone writes "xena what's the progress?" we should treat it as a teammate question,
  // not an "unknown command", unless they used /xena.
  if (!explicit && opts.allowFriendlyMentions && !KNOWN_COMMANDS.has(cmd)) return null;

  return { cmd, args, explicit };
}

function extractFirstVercelUrl(text: string): string | null {
  const urls = text.match(/https?:\/\/[^\s)]+/g) ?? [];
  for (const u of urls) {
    if (/vercel\.(app|run)\b/i.test(u) || /vercel\.run\b/i.test(u)) return u;
  }
  return null;
}

function looksLikeSmokePass(text: string): boolean {
  return /\b(smoke|qa)\b/i.test(text) && /\b(pass|passed|success)\b/i.test(text);
}

function looksLikeSmokeFail(text: string): boolean {
  return /\b(smoke|qa)\b/i.test(text) && /\b(fail|failed|error)\b/i.test(text);
}

export async function ticketWorkflow(args: TicketArgs): Promise<void> {
  const status: TicketStatus = {
    issueId: args.issueId,
    stage: "started",
    reviewAttempts: 0,
    smokeAttempts: 0,
  };

  // Cached after PR creation so later stages can poll GitHub without re-deriving.
  let repoSlugForChecks: string | undefined;
  let prNumberForChecks: number | undefined;

  const seenDeliveries: string[] = [];
  const rememberDelivery = (id: string | undefined) => {
    if (!id) return;
    if (seenDeliveries.includes(id)) return;
    seenDeliveries.push(id);
    if (seenDeliveries.length > 200) seenDeliveries.splice(0, seenDeliveries.length - 200);
  };

  const wakeSignal = defineSignal<[TicketWakeSignal]>(SIGNAL_TICKET_WAKE);
  const commentSignal = defineSignal<[LinearCommentSignal]>(SIGNAL_LINEAR_COMMENT);
  const statusQuery = defineQuery<TicketStatus>(QUERY_TICKET_STATUS);

  let wakeSeq = 0;
  const comments: LinearCommentSignal[] = [];

  setHandler(wakeSignal, (p) => {
    rememberDelivery(p.deliveryId);
    wakeSeq += 1;
  });
  setHandler(commentSignal, (p) => {
    rememberDelivery(p.deliveryId);
    comments.push(p);
  });
  setHandler(statusQuery, () => ({ ...status }));

  const issue = await meta.linearGetIssue({ issueId: args.issueId });
  const ownerTag = await meta.getOwnerTag();

  // Keep the ticket in a "started" state while Xena is working.
  // Use a patch marker so existing workflow histories don't become nondeterministic.
  if (patched("linear-ensure-in-progress")) {
    try {
      await meta.linearEnsureInProgress({ issueId: args.issueId });
    } catch {
      // Non-fatal: orchestration should proceed even if status update fails.
    }
  }

  await meta.linearPostComment({
    issueId: args.issueId,
    body:
      `I’m on this.\n\n` +
      `Plan is: discovery → plan → implementation → review → PR → sandbox → smoke → handoff.`,
  });

  const formatStatus = () =>
    `Status\n` +
    `- Stage: \`${status.stage}\`\n` +
    `- PR: ${status.prUrl ?? "(none)"}\n` +
    `- Sandbox: ${status.sandboxUrl ?? "(none)"}\n` +
    `- Smoke attempts: ${status.smokeAttempts}\n` +
    `- Review attempts: ${status.reviewAttempts}\n` +
    (status.blockedReason ? `- Blocked: ${status.blockedReason}\n` : "");

  const drainComments = async (): Promise<void> => {
    // Avoid Temporal workflow-task "script execution timed out" failures if a burst of
    // non-command comments arrives (i.e. a tight loop with no awaits).
    let processed = 0;
    const yieldEvery = 25;
    while (comments.length > 0) {
      const c = comments.shift()!;
      processed += 1;
      if (!c.body) continue;

      const allowFriendlyMentions = patched("friendly-mentions");
      const cmd = parseCommand(c.body, { allowFriendlyMentions });
      if (cmd) {
        if (cmd.cmd === "help") {
          await meta.linearPostComment({
            issueId: args.issueId,
            body:
              `Controls:\n` +
              `- \`xena status\`\n` +
              `- \`xena stop\`\n` +
              `- \`xena continue\`\n` +
              `- \`xena sandbox https://...\`\n` +
              `- \`xena smoke pass\`\n` +
              `- \`xena smoke fail <details>\``,
          });
          continue;
        }

        if (cmd.cmd === "status") {
          await meta.linearPostComment({
            issueId: args.issueId,
            body: formatStatus(),
          });
          continue;
        }

        if (cmd.cmd === "stop") {
          status.stage = "blocked";
          status.blockedReason = "Stopped by operator (/xena stop).";
          status.resumeStage = "started";
          await meta.linearPostComment({
            issueId: args.issueId,
            body: `Paused. Reply “xena continue” to resume.`,
          });
          continue;
        }

        if (cmd.cmd === "continue") {
          if (status.stage === "blocked") {
            status.stage = status.resumeStage ?? "started";
            status.blockedReason = undefined;
            status.resumeStage = undefined;
            await meta.linearPostComment({
              issueId: args.issueId,
              body: `Continuing.`,
            });
          }
          if (patched("linear-ensure-in-progress-on-continue")) {
            try {
              await meta.linearEnsureInProgress({ issueId: args.issueId });
            } catch {
              // ignore
            }
          }
          wakeSeq += 1;
          continue;
        }

        if (cmd.cmd === "sandbox") {
          const url = cmd.args.split(/\s+/)[0] ?? "";
          if (!/^https?:\/\//i.test(url)) {
            await meta.linearPostComment({
              issueId: args.issueId,
              body: `That sandbox URL doesn’t look valid. Usage: \`/xena sandbox https://...\``,
            });
            continue;
          }
          status.sandboxUrl = url;
          await meta.linearPostComment({
            issueId: args.issueId,
            body: `Sandbox URL: ${url}`,
          });
          if (status.stage === "blocked" && status.resumeStage === "waiting_sandbox") {
            status.stage = "waiting_sandbox";
            status.blockedReason = undefined;
            status.resumeStage = undefined;
            wakeSeq += 1;
          }
          continue;
        }

        if (cmd.cmd === "smoke") {
          const arg = cmd.args.toLowerCase();
          if (arg.startsWith("pass")) {
            status.stage = "handoff";
            await meta.linearPostComment({
              issueId: args.issueId,
              body:
                `Smoke: pass.\n\n` +
                `${ownerTag}`,
            });
            continue;
          }
          if (arg.startsWith("fail")) {
            status.smokeAttempts += 1;
            const details = cmd.args.slice("fail".length).trim();
            await meta.linearPostLongComment({
              issueId: args.issueId,
              header: `Smoke failed`,
              body: details.length > 0 ? details : "No details provided.",
            });
            if (status.smokeAttempts >= 2) {
              status.stage = "blocked";
              status.blockedReason = `Smoke failed (attempt ${status.smokeAttempts}/2).`;
              status.resumeStage = "coding";
              await meta.linearPostLongComment({
                issueId: args.issueId,
                header: `Smoke blocked`,
                body:
                  `Smoke has failed ${status.smokeAttempts} times.\n\n` +
                  `Per scope: human review required.\n\n` +
                  `${ownerTag}`,
              });
            } else {
              await meta.linearPostComment({
                issueId: args.issueId,
                body: `Smoke failed. Looping back to code (attempt ${status.smokeAttempts}/2).`,
              });
              status.stage = "coding";
              status.blockedReason = undefined;
              status.resumeStage = undefined;
              status.sandboxUrl = undefined;
              wakeSeq += 1;
            }
            continue;
          }
        }

        await meta.linearPostComment({
          issueId: args.issueId,
          body:
            `Unknown command.\n` +
            `Reply \`xena help\` to see available controls.`,
        });
        continue;
      }

      // Teammate-style "what's the status/progress?" questions should not require a strict command format.
      if (patched("friendly-progress-questions")) {
        const trimmed = c.body.trim();
        if (/^(?:@?xena)\b/i.test(trimmed) && /\b(status|progress|update)\b/i.test(trimmed)) {
          await meta.linearPostComment({
            issueId: args.issueId,
            body: formatStatus(),
          });
          continue;
        }
      }

      // Non-command comment: best-effort answer if it looks like a question.
      if (/\?\s*$/.test(c.body.trim())) {
        const memory = await meta.mem0Search({
          projectKey: args.project.projectKey,
          issueIdentifier: issue.identifier,
          query: `${issue.identifier}: ${issue.title}`,
          appId: "xena",
          agentId: "workflow.ticket.legacy",
          runId: args.issueId,
        });
        const answer = await meta.openaiAnswerComment({
          issueIdentifier: issue.identifier,
          issueTitle: issue.title,
          issueDescription: issue.description,
          memory,
          stage: status.stage,
          commentBody: c.body,
        });
        await meta.linearPostComment({
          issueId: args.issueId,
          body: `${answer}`,
        });
        await meta.mem0Add({
          projectKey: args.project.projectKey,
          issueIdentifier: issue.identifier,
          content: `[qa]\nQ: ${c.body}\n\nA: ${answer}`,
          type: "qa_exchange",
          intent: "question_answer",
          stage: status.stage,
          outcome: "success",
          source: "workflow.ticket.legacy",
          runId: args.issueId,
          agentId: "workflow.ticket.legacy",
          appId: "xena",
          tags: ["qa", "answer", "legacy"],
        });
      }

      // If we're chewing through lots of comments without awaiting any activities,
      // yield periodically so the workflow task doesn't exceed the runtime limit.
      if (processed % yieldEvery === 0 && comments.length > 0) {
        await Promise.resolve();
        if (patched("drain-comments-yield")) {
          await sleep("1 millisecond");
        }
      }
    }
  };

  const blockAndWait = async (opts: {
    reason: string;
    resumeStage: Stage;
    header?: string;
    body?: string;
  }): Promise<void> => {
    status.stage = "blocked";
    status.blockedReason = opts.reason;
    status.resumeStage = opts.resumeStage;
    if (opts.header && opts.body) {
      await meta.linearPostLongComment({ issueId: args.issueId, header: opts.header, body: opts.body });
    } else {
      await meta.linearPostComment({
        issueId: args.issueId,
        body: `Blocked: ${opts.reason}\nReply “xena continue” to retry. Reply “xena help” for controls.`,
      });
    }

    while (status.stage === "blocked") {
      const start = wakeSeq;
      await condition(() => wakeSeq > start || comments.length > 0);
      await drainComments();
    }
  };

  try {
    // Stage selection based on what already exists in the ticket.
    // We keep retry/block behavior here so transient tool/service failures don't permanently fail the ticket.
    let existingPlan = await meta.linearFindLatestPlan({ issueId: args.issueId });
    let existingDiscovery = await meta.linearFindLatestDiscoveryOutput({ issueId: args.issueId });

    while (!existingPlan) {
      if (!existingDiscovery) {
        status.stage = "discovering";
        try {
          await discoverWorkflow({ issueId: args.issueId, project: args.project, playbookId: args.playbookId });
        } catch (err: any) {
          const msg = typeof err?.message === "string" ? err.message : String(err);
          await blockAndWait({
            reason: `Discover failed: ${msg}`,
            resumeStage: "discovering",
            header: `[xena][discover] Blocked`,
            body: `${msg}\n\n${ownerTag ? `Tagging ${ownerTag}` : ""}`,
          });
          continue;
        }
        existingDiscovery = await meta.linearFindLatestDiscoveryOutput({ issueId: args.issueId });
      }

      status.stage = "planning";
      try {
        await planWorkflow({ issueId: args.issueId, project: args.project, playbookId: args.playbookId });
      } catch (err: any) {
        const msg = typeof err?.message === "string" ? err.message : String(err);
        await blockAndWait({
          reason: `Plan failed: ${msg}`,
          resumeStage: "planning",
          header: `[xena][plan] Blocked`,
          body: `${msg}\n\n${ownerTag ? `Tagging ${ownerTag}` : ""}`,
        });
        continue;
      }

      existingPlan = await meta.linearFindLatestPlan({ issueId: args.issueId });
    }

    // Main loop: block/resume as needed until completion/handoff.
    // This keeps the workflow alive (Temporal is the source of truth for state).
    // Note: for very long-running tickets, consider continue-as-new to keep history bounded.
    while (status.stage !== "completed") {
      await drainComments();
      if (status.stage === "blocked") {
        const start = wakeSeq;
        await condition(() => wakeSeq > start || comments.length > 0);
        await drainComments();
        continue;
      }

      // CODE + REVIEW
      status.stage = "coding";
      let codeRes;
      try {
        codeRes = await codeWorkflow({ issueId: args.issueId, project: args.project, playbookId: args.playbookId });
      } catch (err: any) {
        const msg = typeof err?.message === "string" ? err.message : String(err);
        await blockAndWait({
          reason: `Code failed: ${msg}`,
          resumeStage: "coding",
          header: `[xena][code] Blocked`,
          body: `${msg}\n\n${ownerTag ? `Tagging ${ownerTag}` : ""}`,
        });
        continue;
      }
      status.reviewAttempts = codeRes.ok ? codeRes.reviewAttempts : codeRes.reviewAttempts ?? status.reviewAttempts;
      if (!codeRes.ok) {
        await blockAndWait({
          reason: codeRes.reason,
          resumeStage: "coding",
        });
        continue;
      }

      status.worktreePath = codeRes.worktreePath;
      status.branchName = codeRes.branchName;

      // PR
      status.stage = "creating_pr";
      try {
        const repoSlug = await meta.gitGetOriginRepoSlug({ repoPath: args.project.repoPath });
        repoSlugForChecks = repoSlug;
        const baseBranch = await meta.gitGetDefaultBaseBranch({ repoPath: args.project.repoPath });

        await meta.gitCommitIfNeeded({
          worktreePath: codeRes.worktreePath,
          issueIdentifier: codeRes.issueIdentifier,
          issueTitle: issue.title,
        });
        await meta.gitPushBranch({ worktreePath: codeRes.worktreePath, branchName: codeRes.branchName });

        const prSummary = await meta.gitGetLastCommitSummary({ worktreePath: codeRes.worktreePath, maxFiles: 10 });

        const prUrl = await meta.ghCreatePr({
          worktreePath: codeRes.worktreePath,
          repoSlug,
          baseBranch,
          headBranch: codeRes.branchName,
          title: `${codeRes.issueIdentifier}: ${issue.title}`,
          body: `Automated changes by Xena.\n\nSummary:\n${prSummary}\n\nTicket: ${codeRes.issueIdentifier}`,
        });

        status.prUrl = prUrl;
        const prNum = prUrl.match(/\/pull\/(\d+)/)?.[1];
        if (prNum) prNumberForChecks = Number.parseInt(prNum, 10);
        await meta.linearPostComment({
          issueId: args.issueId,
          body: `PR: ${prUrl}`,
        });
        await meta.mem0Add({
          projectKey: args.project.projectKey,
          issueIdentifier: codeRes.issueIdentifier,
          content: `[pr]\n${prUrl}`,
          type: "workflow_artifact",
          intent: "pr_created",
          stage: "creating_pr",
          outcome: "success",
          source: "workflow.ticket.legacy",
          runId: args.issueId,
          agentId: "workflow.ticket.legacy",
          appId: "xena",
          tags: ["pr", "legacy"],
        });
      } catch (err: any) {
        const msg = typeof err?.message === "string" ? err.message : String(err);
        await blockAndWait({
          reason: `PR creation failed: ${msg}`,
          resumeStage: "creating_pr",
          header: `[xena][pr] Blocked`,
          body: `${msg}\n\n${ownerTag ? `Tagging ${ownerTag}` : ""}`,
        });
        continue;
      }

      // SANDBOX URL
      status.sandboxUrl = undefined; // each PR run should wait for a fresh sandbox URL
      status.stage = "waiting_sandbox";

      // If CI indicates there is no sandbox deployment for this PR, skip the sandbox wait entirely.
      if (patched("gh-ci-checks") && repoSlugForChecks && prNumberForChecks && status.worktreePath) {
        try {
          const checks = await meta.ghGetPrChecks({
            worktreePath: status.worktreePath,
            repoSlug: repoSlugForChecks,
            prNumber: prNumberForChecks,
          });
          const deploy = checks.find((c) => /\bdeploy\b/i.test(c.name));
          if (deploy?.status === "COMPLETED" && deploy.conclusion === "SKIPPED") {
            status.stage = "waiting_smoke";
            await meta.linearPostComment({
              issueId: args.issueId,
              body:
                `No sandbox deployment detected for this PR (deploy was skipped).\n` +
                `Proceeding with CI smoke checks.\n` +
                `If you still have a sandbox URL, paste it and I’ll use that instead.`,
            });
          }
        } catch {
          // best-effort
        }
      }

      if (status.stage === "waiting_sandbox") {
        await meta.linearPostComment({
          issueId: args.issueId,
          body:
            `Waiting on a sandbox URL.\n` +
            `Paste the sandbox URL in a comment (a Vercel URL is fine).`,
        });
      }

      const sandboxDeadline = Date.now() + 60 * 60_000; // 60 min
      while (!status.sandboxUrl) {
        await drainComments();
        if (status.sandboxUrl) break;

        const recent = await meta.linearListRecentComments({ issueId: args.issueId, first: 50 });
        for (const c of recent) {
          const u = extractFirstVercelUrl(c.body);
          if (u) {
            status.sandboxUrl = u;
            break;
          }
        }
        if (status.sandboxUrl) break;

        if (Date.now() >= sandboxDeadline) {
          await blockAndWait({
            reason: "Timed out waiting for sandbox URL.",
            resumeStage: "waiting_sandbox",
            header: `Sandbox blocked`,
            body:
              `Timed out waiting for a sandbox URL.\n\n` +
              `Paste the sandbox URL in a comment once you have it.\n\n` +
              `${ownerTag}`,
          });
          status.stage = "waiting_sandbox";
          continue;
        }

        await sleep("30 seconds");
      }

      if (status.sandboxUrl) {
        await meta.linearPostComment({
          issueId: args.issueId,
          body: `Sandbox: ${status.sandboxUrl}`,
        });
      }

      // SMOKE RESULT
      status.stage = "waiting_smoke";
      if (patched("hyperbrowser-auto-smoke") && status.sandboxUrl) {
        const hb = await qa.hyperbrowserSmoke({ url: status.sandboxUrl, timeoutMs: 5 * 60_000 });
        if (hb.ok) {
          status.stage = "handoff";
        } else if (!hb.skipped) {
          status.smokeAttempts += 1;
          await meta.linearPostLongComment({
            issueId: args.issueId,
            header: `Smoke failed`,
            body: `Hyperbrowser smoke failed. Attempt ${status.smokeAttempts}/2.\n\n${hb.error ?? ""}`.trim(),
          });
          if (status.smokeAttempts < 2) {
            await meta.linearPostComment({
              issueId: args.issueId,
              body: `Smoke failed. Looping back to code (attempt ${status.smokeAttempts}/2).`,
            });
            status.stage = "coding";
            status.sandboxUrl = undefined;
          } else {
            // We'll hit the >=2 gate below to block and tag the owner.
            status.stage = "coding";
            status.sandboxUrl = undefined;
          }
        }
      }

      if (status.stage === "handoff") {
        await meta.linearPostComment({
          issueId: args.issueId,
          body:
            `Handoff.\n` +
            `- PR: ${status.prUrl ?? "(none)"}\n` +
            `- Sandbox: ${status.sandboxUrl ?? "(none)"}\n\n` +
            `${ownerTag}`,
        });
        status.stage = "completed";
        continue;
      }

      await meta.linearPostComment({
        issueId: args.issueId,
        body:
          `Waiting on smoke.\n` +
          `If you have a result, comment with “smoke pass” or “smoke fail”.\n` +
          `If automation posts results, include the words \"smoke\" or \"QA\" and \"pass\"/\"fail\".`,
      });

      const smokeDeadline = Date.now() + 60 * 60_000; // 60 min
      while (status.stage === "waiting_smoke") {
        await drainComments();
        if (status.stage !== "waiting_smoke") break;

        // Prefer CI smoke checks if available, so the workflow doesn't rely solely on manual comments.
        if (patched("gh-ci-checks") && repoSlugForChecks && prNumberForChecks && status.worktreePath) {
          try {
            const checks = await meta.ghGetPrChecks({
              worktreePath: status.worktreePath,
              repoSlug: repoSlugForChecks,
              prNumber: prNumberForChecks,
            });
            const smoke = checks.find((c) => /\bsmoke\b/i.test(c.name));
            if (smoke?.status === "COMPLETED") {
              const conc = smoke.conclusion.toUpperCase();
              if (conc === "SUCCESS") {
                status.stage = "handoff";
                break;
              }
              if (conc === "FAILURE") {
                status.smokeAttempts += 1;
                await meta.linearPostLongComment({
                  issueId: args.issueId,
                  header: `Smoke failed`,
                  body: `CI smoke check failed. Attempt ${status.smokeAttempts}/2.`,
                });
                if (status.smokeAttempts < 2) {
                  await meta.linearPostComment({
                    issueId: args.issueId,
                    body: `Smoke failed. Looping back to code (attempt ${status.smokeAttempts}/2).`,
                  });
                  status.stage = "coding";
                  status.sandboxUrl = undefined;
                } else {
                  // We'll hit the >=2 gate below to block and tag the owner.
                  status.stage = "coding";
                  status.sandboxUrl = undefined;
                }
                break;
              }
            }
          } catch {
            // best-effort
          }
        }

        const recent = await meta.linearListRecentComments({ issueId: args.issueId, first: 50 });
        for (const c of recent) {
          if (looksLikeSmokePass(c.body)) {
            status.stage = "handoff";
            break;
          }
          if (looksLikeSmokeFail(c.body)) {
            status.smokeAttempts += 1;
            await meta.linearPostLongComment({
              issueId: args.issueId,
              header: `Smoke failed`,
              body: `Detected smoke failure from comments. Attempt ${status.smokeAttempts}/2.`,
            });
            if (status.smokeAttempts < 2) {
              await meta.linearPostComment({
                issueId: args.issueId,
                body: `Smoke failed. Looping back to code (attempt ${status.smokeAttempts}/2).`,
              });
              status.stage = "coding";
              status.sandboxUrl = undefined;
            } else {
              // We'll hit the >=2 gate below to block and tag the owner.
              status.stage = "coding";
              status.sandboxUrl = undefined;
            }
            break;
          }
        }

        if (status.stage !== "waiting_smoke") break;

        if (Date.now() >= smokeDeadline) {
          await blockAndWait({
            reason: "Timed out waiting for smoke result.",
            resumeStage: "waiting_smoke",
            header: `Smoke blocked`,
            body:
              `Timed out waiting for smoke result.\n\n` +
              `Reply with “smoke pass” or “smoke fail <details>”.\n\n` +
              `${ownerTag}`,
          });
          status.stage = "waiting_smoke";
          continue;
        }

        await sleep("30 seconds");
      }

      if (status.smokeAttempts >= 2 && status.stage !== "handoff") {
        await blockAndWait({
          reason: `Smoke failed ${status.smokeAttempts} times (2 allowed). Human review required.`,
          resumeStage: "coding",
          header: `Smoke blocked`,
          body:
            `Smoke has failed ${status.smokeAttempts} times.\n\n` +
            `Per scope: human verification required.\n\n` +
            `${ownerTag}`,
        });
        continue;
      }

      if (status.stage === "handoff") {
        await meta.linearPostComment({
          issueId: args.issueId,
          body:
            `Handoff.\n` +
            `- PR: ${status.prUrl ?? "(none)"}\n` +
            `- Sandbox: ${status.sandboxUrl ?? "(none)"}\n\n` +
            `${ownerTag}`,
        });
        status.stage = "completed";
      }
    }
  } catch (err: any) {
    const msg = typeof err?.message === "string" ? err.message : String(err);
    status.stage = "failed";
    status.lastError = msg;
    await meta.linearPostLongComment({
      issueId: args.issueId,
      header: `Blocked`,
      body: msg,
    });
    throw err;
  }
}
