import path from "node:path";
import { randomUUID } from "node:crypto";
import { APIError, Sandbox } from "@vercel/sandbox";
import { definePlugin } from "@paperclipai/plugin-sdk";
import type {
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
} from "@paperclipai/plugin-sdk";

const DEFAULT_IMAGE = "vercel/sandbox/universal";
const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_VCPUS = 2;
// Extend the sandbox lifetime when less than this remains before a command.
const EXTEND_MARGIN_MS = 60 * 1000;
// Exit status of a process killed with SIGKILL, which is how Vercel Sandbox
// enforces a command's timeoutMs.
const SIGKILL_EXIT_CODE = 137;

interface VercelSandboxDriverConfig {
  image: string;
  accessToken: string | null;
  teamId: string | null;
  projectId: string | null;
  vcpus: number;
  region: string | null;
  timeoutMs: number;
  reuseLease: boolean;
}

type Credentials = { token: string; teamId: string; projectId: string };

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseDriverConfig(raw: Record<string, unknown>): VercelSandboxDriverConfig {
  const timeoutMs = Number(raw.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const vcpus = Number(raw.vcpus ?? DEFAULT_VCPUS);
  return {
    image: readString(raw.image) ?? DEFAULT_IMAGE,
    accessToken: readString(raw.accessToken),
    teamId: readString(raw.teamId),
    projectId: readString(raw.projectId),
    vcpus: Number.isFinite(vcpus) ? Math.trunc(vcpus) : DEFAULT_VCPUS,
    region: readString(raw.region),
    timeoutMs: Number.isFinite(timeoutMs) ? Math.trunc(timeoutMs) : DEFAULT_TIMEOUT_MS,
    reuseLease: raw.reuseLease === true,
  };
}

/**
 * Explicit access-token credentials, or `undefined` to let the SDK use Vercel
 * OIDC (VERCEL_OIDC_TOKEN) from the environment.
 */
function resolveCredentials(config: VercelSandboxDriverConfig): Credentials | undefined {
  const token = config.accessToken ?? readString(process.env.VERCEL_TOKEN);
  if (!token) {
    if (readString(process.env.VERCEL_OIDC_TOKEN)) return undefined;
    throw new Error(
      "Vercel Sandbox environments require an access token (config or VERCEL_TOKEN) or a VERCEL_OIDC_TOKEN.",
    );
  }
  const teamId = config.teamId ?? readString(process.env.VERCEL_TEAM_ID);
  const projectId = config.projectId ?? readString(process.env.VERCEL_PROJECT_ID);
  if (!teamId || !projectId) {
    throw new Error("Vercel Sandbox access tokens require a teamId and projectId (config or VERCEL_TEAM_ID/VERCEL_PROJECT_ID).");
  }
  return { token, teamId, projectId };
}

async function createSandbox(config: VercelSandboxDriverConfig): Promise<Sandbox> {
  return await Sandbox.create({
    ...resolveCredentials(config),
    image: config.image,
    resources: { vcpus: config.vcpus },
    timeout: config.timeoutMs,
    persistent: config.reuseLease,
    ...(config.region ? { region: config.region } : {}),
    tags: { paperclipProvider: "vercel-sandbox" },
  });
}

async function getSandbox(
  config: VercelSandboxDriverConfig,
  name: string,
  options: { resume: boolean },
): Promise<Sandbox> {
  return await Sandbox.get({ ...resolveCredentials(config), name, resume: options.resume });
}

function isNotFound(error: unknown): boolean {
  return error instanceof APIError && error.response?.status === 404;
}

async function getSandboxForCleanup(config: VercelSandboxDriverConfig, name: string): Promise<Sandbox | null> {
  try {
    return await getSandbox(config, name, { resume: false });
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function formatErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // Network failures surface as a bare "fetch failed"; the cause says why.
  const cause = (error as { cause?: unknown }).cause;
  const causeMessage = cause instanceof Error
    ? [(cause as { code?: string }).code, cause.message].filter(Boolean).join(": ")
    : null;
  return causeMessage && !error.message.includes(causeMessage) ? `${error.message} (${causeMessage})` : error.message;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function isValidShellEnvKey(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

// The sandbox image supplies a ready PATH (see SANDBOX-REQUIREMENTS.md), so
// the command runs under `sh -c` without sourcing any profile.
function buildShellScript(input: {
  command: string;
  args: string[];
  env?: Record<string, string>;
  stdinPath?: string | null;
}): string {
  const env = input.env ?? {};
  for (const key of Object.keys(env)) {
    if (!isValidShellEnvKey(key)) {
      throw new Error(`Invalid sandbox environment variable key: ${key}`);
    }
  }
  const envArgs = Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  const commandParts = [shellQuote(input.command), ...input.args.map(shellQuote)].join(" ");
  const execLine = envArgs.length > 0
    ? `exec env ${envArgs.join(" ")} ${commandParts}`
    : `exec ${commandParts}`;
  return input.stdinPath ? `${execLine} < ${shellQuote(input.stdinPath)}` : execLine;
}

async function ensureSandboxWorkspace(sandbox: Sandbox, remoteCwd: string): Promise<void> {
  const result = await sandbox.runCommand("mkdir", ["-p", remoteCwd]);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create sandbox workspace ${remoteCwd}: ${await result.stderr()}`);
  }
}

async function resolveSandboxWorkingDirectory(sandbox: Sandbox): Promise<string> {
  const base = sandbox.cwd && sandbox.cwd.length > 0 ? sandbox.cwd : "/vercel/sandbox";
  const remoteCwd = path.posix.join(base, "paperclip-workspace");
  await ensureSandboxWorkspace(sandbox, remoteCwd);
  return remoteCwd;
}

/**
 * Vercel Sandbox extends lifetime relatively. Top it up so at least the next
 * command's budget remains. Best effort: the plan maximum may refuse it, and
 * the existing lifetime still stands.
 */
async function ensureLifetime(sandbox: Sandbox, neededMs: number): Promise<void> {
  const expiresAt = sandbox.expiresAt?.getTime();
  if (expiresAt === undefined) return;
  const remaining = expiresAt - Date.now();
  const wanted = neededMs + EXTEND_MARGIN_MS;
  if (remaining >= wanted) return;
  try {
    await sandbox.extendTimeout(wanted - Math.max(remaining, 0));
  } catch {
    // keep going with the existing sandbox lifetime
  }
}

function leaseMetadata(input: {
  config: VercelSandboxDriverConfig;
  sandbox: Sandbox;
  remoteCwd: string;
  resumedLease: boolean;
}) {
  return {
    provider: "vercel-sandbox",
    shellCommand: "sh",
    image: input.config.image,
    vcpus: input.config.vcpus,
    region: input.config.region,
    timeoutMs: input.config.timeoutMs,
    reuseLease: input.config.reuseLease,
    sandboxName: input.sandbox.name,
    remoteCwd: input.remoteCwd,
    resumedLease: input.resumedLease,
  };
}

async function deleteSandboxBestEffort(sandbox: Sandbox, reason: string): Promise<void> {
  await sandbox.delete().catch(async (error) => {
    console.warn(`Failed to delete Vercel sandbox during ${reason}: ${formatErrorMessage(error)}. Stopping it instead.`);
    await sandbox.stop().catch(() => undefined);
  });
}

async function releaseSandboxBestEffort(sandbox: Sandbox, reuseLease: boolean): Promise<void> {
  if (!reuseLease) {
    await deleteSandboxBestEffort(sandbox, "lease release");
    return;
  }
  try {
    // A persistent sandbox keeps its filesystem across stop/resume.
    await sandbox.stop();
  } catch (error) {
    console.warn(
      `Failed to stop Vercel sandbox during lease release: ${formatErrorMessage(error)}. Deleting it instead.`,
    );
    await deleteSandboxBestEffort(sandbox, "lease release fallback cleanup");
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Vercel Sandbox provider plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "Vercel Sandbox provider plugin healthy" };
  },

  async onEnvironmentValidateConfig(
    params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult> {
    const config = parseDriverConfig(params.config);
    const errors: string[] = [];

    if (typeof params.config.image === "string" && params.config.image.trim().length === 0) {
      errors.push("Vercel Sandbox environments require an image.");
    }
    if (config.timeoutMs < 1 || config.timeoutMs > MAX_TIMEOUT_MS) {
      errors.push(`timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}.`);
    }
    if (config.vcpus < 1 || config.vcpus > 32) {
      errors.push("vcpus must be between 1 and 32.");
    }
    if (config.accessToken && (!config.teamId || !config.projectId)) {
      errors.push("An access token requires teamId and projectId.");
    }

    if (errors.length > 0) {
      return { ok: false, errors };
    }

    return {
      ok: true,
      normalizedConfig: { ...config },
    };
  },

  async onEnvironmentProbe(
    params: PluginEnvironmentProbeParams,
  ): Promise<PluginEnvironmentProbeResult> {
    const config = parseDriverConfig(params.config);
    const baseMetadata = {
      provider: "vercel-sandbox",
      image: config.image,
      vcpus: config.vcpus,
      region: config.region,
      timeoutMs: config.timeoutMs,
      reuseLease: config.reuseLease,
    };
    try {
      const sandbox = await createSandbox(config);
      try {
        const remoteCwd = await resolveSandboxWorkingDirectory(sandbox);
        return {
          ok: true,
          summary: `Connected to Vercel Sandbox image ${config.image}.`,
          metadata: { ...baseMetadata, sandboxName: sandbox.name, remoteCwd },
        };
      } finally {
        await sandbox.delete().catch(() => undefined);
      }
    } catch (error) {
      return {
        ok: false,
        summary: `Vercel Sandbox probe failed for image ${config.image}.`,
        metadata: { ...baseMetadata, error: formatErrorMessage(error) },
      };
    }
  },

  async onEnvironmentAcquireLease(
    params: PluginEnvironmentAcquireLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    const sandbox = await createSandbox(config);
    try {
      const remoteCwd = await resolveSandboxWorkingDirectory(sandbox);
      return {
        providerLeaseId: sandbox.name,
        metadata: leaseMetadata({ config, sandbox, remoteCwd, resumedLease: false }),
      };
    } catch (error) {
      await sandbox.delete().catch(() => undefined);
      throw error;
    }
  },

  async onEnvironmentResumeLease(
    params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    let sandbox: Sandbox;
    try {
      sandbox = await getSandbox(config, params.providerLeaseId, { resume: true });
    } catch (error) {
      if (isNotFound(error)) {
        return { providerLeaseId: null, metadata: { expired: true } };
      }
      throw error;
    }
    try {
      const remoteCwd = await resolveSandboxWorkingDirectory(sandbox);
      return {
        providerLeaseId: sandbox.name,
        metadata: leaseMetadata({ config, sandbox, remoteCwd, resumedLease: true }),
      };
    } catch (error) {
      await sandbox.delete().catch(() => undefined);
      throw error;
    }
  },

  async onEnvironmentReleaseLease(
    params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    const sandbox = await getSandboxForCleanup(config, params.providerLeaseId);
    if (!sandbox) return;
    await releaseSandboxBestEffort(sandbox, config.reuseLease);
  },

  async onEnvironmentDestroyLease(
    params: PluginEnvironmentDestroyLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    const sandbox = await getSandboxForCleanup(config, params.providerLeaseId);
    if (!sandbox) return;
    await deleteSandboxBestEffort(sandbox, "lease destroy");
  },

  async onEnvironmentRealizeWorkspace(
    params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    const config = parseDriverConfig(params.config);
    const remoteCwd =
      typeof params.lease.metadata?.remoteCwd === "string" &&
      params.lease.metadata.remoteCwd.trim().length > 0
        ? params.lease.metadata.remoteCwd.trim()
        : params.workspace.remotePath ?? params.workspace.localPath ?? "/vercel/sandbox/paperclip-workspace";

    if (params.lease.providerLeaseId) {
      const sandbox = await getSandbox(config, params.lease.providerLeaseId, { resume: true });
      await ensureSandboxWorkspace(sandbox, remoteCwd);
    }

    return {
      cwd: remoteCwd,
      metadata: {
        provider: "vercel-sandbox",
        remoteCwd,
      },
    };
  },

  async onEnvironmentExecute(
    params: PluginEnvironmentExecuteParams,
  ): Promise<PluginEnvironmentExecuteResult> {
    if (!params.lease.providerLeaseId) {
      return {
        exitCode: 1,
        timedOut: false,
        stdout: "",
        stderr: "No provider lease ID available for execution.",
      };
    }

    const config = parseDriverConfig(params.config);
    const sandbox = await getSandbox(config, params.lease.providerLeaseId, { resume: true });
    const timeoutMs = params.commandTimeoutMs && params.commandTimeoutMs > 0
      ? params.commandTimeoutMs
      : params.timeoutMs ?? config.timeoutMs;
    await ensureLifetime(sandbox, timeoutMs);

    // Stage stdin as a file and redirect it, so delivery never races a
    // command that exits before reading.
    let stagedStdinPath: string | null = null;
    if (params.stdin != null) {
      stagedStdinPath = `/tmp/paperclip-stdin-${randomUUID()}`;
      await sandbox.writeFiles([{ path: stagedStdinPath, content: params.stdin }]);
    }

    const script = buildShellScript({
      command: params.command,
      args: params.args ?? [],
      env: params.env,
      stdinPath: stagedStdinPath,
    });

    const startedAt = Date.now();
    try {
      const result = await sandbox.runCommand({
        cmd: "sh",
        args: ["-c", script],
        cwd: params.cwd,
        timeoutMs,
      });
      const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
      const timedOut = result.exitCode === SIGKILL_EXIT_CODE && Date.now() - startedAt >= timeoutMs;
      if (timedOut) {
        const message = `Command timed out after ${Math.round(timeoutMs / 1000)} s.\n`;
        return { exitCode: null, timedOut: true, stdout, stderr: `${stderr}${stderr.endsWith("\n") || !stderr ? "" : "\n"}${message}` };
      }
      return { exitCode: result.exitCode, timedOut: false, stdout, stderr };
    } finally {
      if (stagedStdinPath) {
        await sandbox.runCommand("rm", ["-f", stagedStdinPath]).catch(() => undefined);
      }
    }
  },
});

export default plugin;
