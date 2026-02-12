import { Hyperbrowser } from "@hyperbrowser/sdk";
import { chromium } from "playwright-core";
import { loadWorkerEnv } from "../../env.js";
import { logger } from "../../logger.js";

export type HyperbrowserSmokeResult = {
  ok: boolean;
  skipped?: boolean;
  title?: string;
  finalUrl?: string;
  error?: string;
};

export async function hyperbrowserSmoke(opts: {
  url: string;
  timeoutMs?: number;
}): Promise<HyperbrowserSmokeResult> {
  const env = loadWorkerEnv();
  const apiKey = env.HYPERBROWSER_API_KEY;
  if (!apiKey) {
    return { ok: false, skipped: true, error: "HYPERBROWSER_API_KEY not configured" };
  }

  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const client = new Hyperbrowser({ apiKey });
  const session = await client.sessions.create();

  let browser: any;
  try {
    browser = await chromium.connectOverCDP(session.wsEndpoint);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();

    await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    const title = (await page.title().catch(() => "")) ?? "";
    const finalUrl = page.url();

    return { ok: true, title, finalUrl };
  } catch (err: any) {
    const msg = typeof err?.message === "string" ? err.message : String(err);
    logger.warn({ err, url: opts.url }, "Hyperbrowser smoke failed");
    return { ok: false, error: msg };
  } finally {
    try {
      await browser?.close();
    } catch {
      // ignore
    }
    try {
      await client.sessions.stop(session.id);
    } catch {
      // ignore
    }
  }
}

export type HyperbrowserAgentResult = {
  ok: boolean;
  skipped?: boolean;
  status?: string;
  summary?: string;
  liveUrl?: string | null;
  error?: string;
};

export async function hyperbrowserRunQaTask(opts: {
  url: string;
  issueIdentifier: string;
  issueTitle: string;
  issueDescription: string | null;
}): Promise<HyperbrowserAgentResult> {
  const env = loadWorkerEnv();
  const apiKey = env.HYPERBROWSER_API_KEY;
  if (!apiKey) {
    return { ok: false, skipped: true, error: "HYPERBROWSER_API_KEY not configured" };
  }

  const client = new Hyperbrowser({ apiKey });
  const model = env.XENA_HYPERBROWSER_MODEL ?? "gpt-5.2";
  const task = [
    "Smoke test this frontend change and report whether it passes.",
    `App URL: ${opts.url}`,
    `Ticket: ${opts.issueIdentifier} - ${opts.issueTitle}`,
    "",
    "Ticket description:",
    opts.issueDescription ?? "(none provided)",
    "",
    "Output format:",
    "- verdict: pass | fail",
    "- key findings (max 5 bullets)",
    "- blocker details if failed",
  ].join("\n");

  try {
    const result = await client.agents.hyperAgent.startAndWait({
      task,
      llm: model as any,
      maxSteps: 30,
      sessionOptions: {
        enableWebRecording: true,
        disablePasswordManager: true,
      } as any,
    });

    const status = (result.status ?? "").toLowerCase();
    const summary = result.data?.finalResult?.trim() ?? "";
    if (status === "completed") {
      return {
        ok: true,
        status,
        summary,
        liveUrl: result.liveUrl,
      };
    }
    return {
      ok: false,
      status,
      summary,
      liveUrl: result.liveUrl,
      error: result.error ?? `Hyperbrowser returned non-completed status: ${result.status}`,
    };
  } catch (err: any) {
    const msg = typeof err?.message === "string" ? err.message : String(err);
    logger.warn({ err, url: opts.url }, "Hyperbrowser QA task failed");
    return { ok: false, error: msg };
  }
}
