import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreate = vi.hoisted(() => vi.fn());
const mockGet = vi.hoisted(() => vi.fn());
const { MockAPIError } = vi.hoisted(() => {
  class MockAPIError extends Error {
    response: { status: number };
    constructor(status: number) {
      super(`api error ${status}`);
      this.response = { status };
    }
  }
  return { MockAPIError };
});

vi.mock("@vercel/sandbox", () => ({
  APIError: MockAPIError,
  Sandbox: {
    create: mockCreate,
    get: mockGet,
  },
}));

import plugin from "./plugin.js";

type CommandResult = { exitCode: number; stdout?: string; stderr?: string };

function commandFinished(result: CommandResult) {
  return {
    exitCode: result.exitCode,
    stdout: vi.fn().mockResolvedValue(result.stdout ?? ""),
    stderr: vi.fn().mockResolvedValue(result.stderr ?? ""),
  };
}

function createMockSandbox(overrides: {
  name?: string;
  cwd?: string;
  expiresInMs?: number;
  run?: (params: unknown, args?: string[]) => CommandResult | Promise<CommandResult>;
} = {}) {
  return {
    name: overrides.name ?? "sbx-123",
    cwd: overrides.cwd ?? "/vercel/sandbox",
    expiresAt: new Date(Date.now() + (overrides.expiresInMs ?? 60 * 60 * 1000)),
    runCommand: vi.fn(async (params: unknown, args?: string[]) =>
      commandFinished(await (overrides.run?.(params, args) ?? { exitCode: 0 }))),
    writeFiles: vi.fn().mockResolvedValue(undefined),
    extendTimeout: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

const credentials = { accessToken: "vercel-token", teamId: "team_1", projectId: "prj_1" };
const lease = { providerLeaseId: "sbx-123", metadata: { remoteCwd: "/vercel/sandbox/paperclip-workspace" } };

function driverParams(config: Record<string, unknown> = {}) {
  return { driverKey: "vercel-sandbox", companyId: "company-1", environmentId: "env-1", config: { ...credentials, ...config } };
}

describe("vercel sandbox provider plugin", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_OIDC_TOKEN;
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.VERCEL_PROJECT_ID;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("normalizes config and rejects tokens without team and project", async () => {
    await expect(plugin.definition.onEnvironmentValidateConfig?.({
      ...driverParams(),
      config: { accessToken: "token" },
    } as never)).resolves.toEqual({ ok: false, errors: ["An access token requires teamId and projectId."] });

    const valid = await plugin.definition.onEnvironmentValidateConfig?.(driverParams({ vcpus: 4 }) as never);
    expect(valid).toMatchObject({
      ok: true,
      normalizedConfig: { image: "vercel/sandbox/universal", vcpus: 4, timeoutMs: 45 * 60 * 1000, reuseLease: false },
    });
  });

  it("acquires a sandbox with explicit credentials and prepares the workspace", async () => {
    const sandbox = createMockSandbox();
    mockCreate.mockResolvedValue(sandbox);

    const result = await plugin.definition.onEnvironmentAcquireLease?.({
      ...driverParams({ region: "fra1", reuseLease: true }),
      runId: "run-1",
    } as never);

    expect(mockCreate).toHaveBeenCalledWith({
      token: "vercel-token",
      teamId: "team_1",
      projectId: "prj_1",
      image: "vercel/sandbox/universal",
      resources: { vcpus: 2 },
      timeout: 45 * 60 * 1000,
      persistent: true,
      region: "fra1",
      tags: { paperclipProvider: "vercel-sandbox" },
    });
    expect(sandbox.runCommand).toHaveBeenCalledWith("mkdir", ["-p", "/vercel/sandbox/paperclip-workspace"]);
    expect(result).toMatchObject({
      providerLeaseId: "sbx-123",
      metadata: { provider: "vercel-sandbox", sandboxName: "sbx-123", remoteCwd: "/vercel/sandbox/paperclip-workspace" },
    });
  });

  it("falls back to Vercel OIDC when no access token is configured", async () => {
    process.env.VERCEL_OIDC_TOKEN = "oidc";
    mockCreate.mockResolvedValue(createMockSandbox());

    await plugin.definition.onEnvironmentAcquireLease?.({
      driverKey: "vercel-sandbox",
      companyId: "company-1",
      environmentId: "env-1",
      config: {},
      runId: "run-1",
    } as never);

    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty("token");
  });

  it("fails clearly without any credentials", async () => {
    await expect(plugin.definition.onEnvironmentAcquireLease?.({
      driverKey: "vercel-sandbox",
      companyId: "company-1",
      environmentId: "env-1",
      config: {},
      runId: "run-1",
    } as never)).rejects.toThrow("require an access token");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("deletes the sandbox when workspace preparation fails during acquire", async () => {
    const sandbox = createMockSandbox({ run: () => ({ exitCode: 1, stderr: "read-only" }) });
    mockCreate.mockResolvedValue(sandbox);

    await expect(plugin.definition.onEnvironmentAcquireLease?.({ ...driverParams(), runId: "run-1" } as never))
      .rejects.toThrow("read-only");
    expect(sandbox.delete).toHaveBeenCalled();
  });

  it("executes commands through sh with quoted args, env, and staged stdin", async () => {
    const sandbox = createMockSandbox({ run: () => ({ exitCode: 0, stdout: "hello\n" }) });
    mockGet.mockResolvedValue(sandbox);

    const result = await plugin.definition.onEnvironmentExecute?.({
      ...driverParams(),
      lease,
      command: "claude",
      args: ["--print", "it's"],
      env: { API_KEY: "a b" },
      stdin: "prompt",
      cwd: "/vercel/sandbox/paperclip-workspace",
      timeoutMs: 30_000,
    } as never);

    expect(mockGet).toHaveBeenCalledWith(expect.objectContaining({ name: "sbx-123", resume: true }));
    const stdinPath = sandbox.writeFiles.mock.calls[0][0][0].path as string;
    expect(stdinPath).toMatch(/^\/tmp\/paperclip-stdin-/);
    expect(sandbox.runCommand).toHaveBeenCalledWith({
      cmd: "sh",
      args: ["-c", `exec env API_KEY='a b' 'claude' '--print' 'it'"'"'s' < '${stdinPath}'`],
      cwd: "/vercel/sandbox/paperclip-workspace",
      timeoutMs: 30_000,
    });
    expect(sandbox.runCommand).toHaveBeenCalledWith("rm", ["-f", stdinPath]);
    expect(result).toEqual({ exitCode: 0, timedOut: false, stdout: "hello\n", stderr: "" });
  });

  it("rejects invalid environment variable names", async () => {
    mockGet.mockResolvedValue(createMockSandbox());

    await expect(plugin.definition.onEnvironmentExecute?.({
      ...driverParams(),
      lease,
      command: "env",
      env: { "BAD-KEY": "x" },
    } as never)).rejects.toThrow("Invalid sandbox environment variable key: BAD-KEY");
  });

  it("reports a SIGKILL at the deadline as a timeout", async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const sandbox = createMockSandbox({
        run: () => {
          vi.setSystemTime(5_000);
          return { exitCode: 137, stdout: "partial", stderr: "" };
        },
      });
      mockGet.mockResolvedValue(sandbox);

      const result = await plugin.definition.onEnvironmentExecute?.({
        ...driverParams(),
        lease,
        command: "sleep",
        args: ["10"],
        timeoutMs: 5_000,
      } as never);

      expect(result).toEqual({ exitCode: null, timedOut: true, stdout: "partial", stderr: "Command timed out after 5 s.\n" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("extends the sandbox lifetime when the command budget exceeds what remains", async () => {
    const sandbox = createMockSandbox({ expiresInMs: 10_000 });
    mockGet.mockResolvedValue(sandbox);

    await plugin.definition.onEnvironmentExecute?.({
      ...driverParams(),
      lease,
      command: "true",
      commandTimeoutMs: 120_000,
    } as never);

    const extendedBy = sandbox.extendTimeout.mock.calls[0][0] as number;
    expect(extendedBy).toBeGreaterThanOrEqual(170_000);
    expect(extendedBy).toBeLessThanOrEqual(171_000);
  });

  it("reports the cause of network failures in the probe", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.vercel.com"), { code: "ENOTFOUND" });
    mockCreate.mockRejectedValue(new TypeError("fetch failed", { cause }));

    const result = await plugin.definition.onEnvironmentProbe?.(driverParams() as never);

    expect(result).toMatchObject({
      ok: false,
      metadata: { error: "fetch failed (ENOTFOUND: getaddrinfo ENOTFOUND api.vercel.com)" },
    });
  });

  it("marks a missing sandbox as expired on resume", async () => {
    mockGet.mockRejectedValue(new MockAPIError(404));

    await expect(plugin.definition.onEnvironmentResumeLease?.({
      ...driverParams(),
      providerLeaseId: "gone",
    } as never)).resolves.toEqual({ providerLeaseId: null, metadata: { expired: true } });
  });

  it("stops reusable sandboxes and deletes the rest on release", async () => {
    const reusable = createMockSandbox();
    mockGet.mockResolvedValueOnce(reusable);
    await plugin.definition.onEnvironmentReleaseLease?.({
      ...driverParams({ reuseLease: true }),
      providerLeaseId: "sbx-123",
    } as never);
    expect(reusable.stop).toHaveBeenCalled();
    expect(reusable.delete).not.toHaveBeenCalled();

    const disposable = createMockSandbox();
    mockGet.mockResolvedValueOnce(disposable);
    await plugin.definition.onEnvironmentReleaseLease?.({
      ...driverParams(),
      providerLeaseId: "sbx-123",
    } as never);
    expect(disposable.delete).toHaveBeenCalled();
  });

  it("treats an already-deleted sandbox as destroyed and rethrows other errors", async () => {
    mockGet.mockRejectedValueOnce(new MockAPIError(404));
    await expect(plugin.definition.onEnvironmentDestroyLease?.({
      ...driverParams(),
      providerLeaseId: "gone",
    } as never)).resolves.toBeUndefined();

    mockGet.mockRejectedValueOnce(new MockAPIError(500));
    await expect(plugin.definition.onEnvironmentDestroyLease?.({
      ...driverParams(),
      providerLeaseId: "sbx-123",
    } as never)).rejects.toThrow("api error 500");
  });
});
