import { Sandbox } from "@vercel/sandbox";
import { loadWorkerEnv } from "../../env.js";
import { logger } from "../../logger.js";

export type SandboxProvisionResult =
  | {
      ok: true;
      sandboxId: string;
      sandboxUrl: string;
      bootMode: "monorepo" | "generic";
    }
  | {
      ok: false;
      skipped?: boolean;
      reason: string;
    };

function getGitHubToken(): string | undefined {
  const env = loadWorkerEnv();
  return env.GH_TOKEN ?? env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
}

function vercelCredentials() {
  const env = loadWorkerEnv();
  const token = env.VERCEL_ACCESS_TOKEN;
  const projectId = env.VERCEL_PROJECT_ID;
  const teamId = env.VERCEL_TEAM_ID;
  return { token, projectId, teamId };
}

async function runChecked(
  sandbox: Sandbox,
  params: {
    cmd: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    sudo?: boolean;
  },
): Promise<void> {
  const res = await sandbox.runCommand({
    cmd: params.cmd,
    args: params.args,
    cwd: params.cwd,
    env: params.env,
    sudo: params.sudo,
  });

  if (res.exitCode === 0) return;
  const stdout = await res.stdout().catch(() => "");
  const stderr = await res.stderr().catch(() => "");
  const tail = `${stdout}\n${stderr}`.trim().slice(-8000);
  throw new Error(
    `Sandbox command failed: ${params.cmd} ${(params.args ?? []).join(" ")} (exit ${res.exitCode})\n${tail}`,
  );
}

export async function sandboxProvisionFromPr(opts: {
  repoFullName: string;
  branchName: string;
  prNumber: number;
}): Promise<SandboxProvisionResult> {
  const ghToken = getGitHubToken();
  const { token, projectId, teamId } = vercelCredentials();

  if (!ghToken) {
    return { ok: false, skipped: true, reason: "Missing GH_TOKEN/GITHUB_TOKEN for sandbox git clone." };
  }
  if (!token || !projectId) {
    return {
      ok: false,
      skipped: true,
      reason: "Missing VERCEL_ACCESS_TOKEN or VERCEL_PROJECT_ID for sandbox provisioning.",
    };
  }

  const createArgs: any = {
    runtime: "node22",
    source: {
      type: "git",
      url: `https://github.com/${opts.repoFullName}.git`,
      username: "x-access-token",
      password: ghToken,
      revision: opts.branchName,
      depth: 1,
    },
    ports: [3000, 3006],
    timeout: 30 * 60_000,
    token,
    projectId,
  };
  if (teamId) createArgs.teamId = teamId;

  let sandbox: Sandbox | undefined;
  try {
    sandbox = await Sandbox.create(createArgs);

    const sandboxBootPackages = (process.env.XENA_SANDBOX_BOOT_PACKAGES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (sandboxBootPackages.length > 0) {
      try {
        await runChecked(sandbox, {
          cmd: "npm",
          args: ["install", "-g", "pnpm@10.14.0"],
          sudo: true,
        });
        await runChecked(sandbox, {
          cmd: "pnpm",
          args: ["install"],
          cwd: "/vercel/sandbox",
        });

        for (const pkg of sandboxBootPackages) {
          await sandbox.runCommand({
            cmd: "pnpm",
            args: ["--filter", pkg, "dev"],
            cwd: "/vercel/sandbox",
            detached: true,
            env: { NODE_ENV: "development" },
          });
        }

        return {
          ok: true,
          sandboxId: sandbox.sandboxId,
          sandboxUrl: sandbox.domain(3000),
          bootMode: "monorepo",
        };
      } catch (monorepoErr: any) {
        logger.warn({ err: monorepoErr }, "Monorepo sandbox boot failed, falling back to generic boot");
      }
    }

    await runChecked(sandbox, {
      cmd: "npm",
      args: ["install"],
      cwd: "/vercel/sandbox",
    });
    await sandbox.runCommand({
      cmd: "npm",
      args: ["run", "dev", "--", "--host", "0.0.0.0", "--port", "3000"],
      cwd: "/vercel/sandbox",
      detached: true,
    });

    return {
      ok: true,
      sandboxId: sandbox.sandboxId,
      sandboxUrl: sandbox.domain(3000),
      bootMode: "generic",
    };
  } catch (err: any) {
    const msg = typeof err?.message === "string" ? err.message : String(err);
    logger.error({ err }, "Sandbox provisioning failed");
    try {
      await sandbox?.stop();
    } catch {
      // best effort
    }
    return { ok: false, reason: msg };
  }
}

export async function sandboxTeardown(opts: { sandboxId: string }): Promise<{ ok: boolean; reason?: string }> {
  const { token, projectId, teamId } = vercelCredentials();
  if (!token || !projectId) {
    return { ok: false, reason: "Missing VERCEL_ACCESS_TOKEN or VERCEL_PROJECT_ID for teardown." };
  }

  const getArgs: any = { sandboxId: opts.sandboxId, token, projectId };
  if (teamId) getArgs.teamId = teamId;

  try {
    const sandbox = await Sandbox.get(getArgs);
    await sandbox.stop();
    return { ok: true };
  } catch (err: any) {
    const msg = typeof err?.message === "string" ? err.message : String(err);
    logger.warn({ err, sandboxId: opts.sandboxId }, "Sandbox teardown failed");
    return { ok: false, reason: msg };
  }
}
