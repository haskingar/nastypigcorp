// Vercel Function entry point. Every non-static request is rewritten here (see
// vercel.json) and handed to the regular Paperclip HTTP server without binding
// a port. Vercel Cron calls VERCEL_CRON_PATH to drive the heartbeat scheduler,
// because a frozen function instance never fires the in-process interval.
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

const VERCEL_CRON_PATH = "/api/vercel/cron/scheduler";

// Every instance must agree on these. Without them the server would generate
// per-instance values on the ephemeral disk and sessions, stored secrets and
// signed decisions would break between invocations.
const REQUIRED_ENV = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "PAPERCLIP_SECRETS_MASTER_KEY",
  "PAPERCLIP_DECISION_SIGNING_SECRET",
] as const;

function applyVercelDefaults(env: NodeJS.ProcessEnv): void {
  env.PAPERCLIP_SERVERLESS = "true";
  env.NODE_ENV ??= "production";
  // Only /tmp is writable on Vercel; everything durable lives in Postgres/Blob.
  env.PAPERCLIP_HOME ??= "/tmp/paperclip";
  env.DATABASE_URL ??= env.POSTGRES_URL;
  env.PAPERCLIP_DEPLOYMENT_MODE ??= "authenticated";
  env.PAPERCLIP_DEPLOYMENT_EXPOSURE ??= "public";
  env.PAPERCLIP_AUTH_BASE_URL_MODE ??= "explicit";
  const productionHost = env.VERCEL_PROJECT_PRODUCTION_URL ?? env.VERCEL_URL;
  if (!env.PAPERCLIP_PUBLIC_URL && !env.PAPERCLIP_AUTH_PUBLIC_BASE_URL && productionHost) {
    env.PAPERCLIP_PUBLIC_URL = `https://${productionHost}`;
  }
  env.PAPERCLIP_API_URL ??= env.PAPERCLIP_PUBLIC_URL ?? env.PAPERCLIP_AUTH_PUBLIC_BASE_URL;
  if (!env.PAPERCLIP_ALLOWED_HOSTNAMES) {
    const hosts = [env.VERCEL_PROJECT_PRODUCTION_URL, env.VERCEL_BRANCH_URL, env.VERCEL_URL].filter(Boolean);
    if (hosts.length > 0) env.PAPERCLIP_ALLOWED_HOSTNAMES = hosts.join(",");
  }
  if (!env.PAPERCLIP_STORAGE_PROVIDER && env.BLOB_READ_WRITE_TOKEN) {
    env.PAPERCLIP_STORAGE_PROVIDER = "vercel_blob";
  }
  env.PAPERCLIP_MIGRATION_AUTO_APPLY ??= "true";
  env.PAPERCLIP_DB_BACKUP_ENABLED ??= "false";
  env.SERVE_UI ??= "true";
}

applyVercelDefaults(process.env);

type StartedServer = Awaited<ReturnType<typeof import("../../server/src/index.js").startServer>>;
let started: Promise<StartedServer> | null = null;

function startOnce(): Promise<StartedServer> {
  if (!started) {
    const missing = REQUIRED_ENV.filter((name) => !process.env[name]?.trim());
    if (missing.length > 0) {
      return Promise.reject(new Error(`Missing required Vercel environment variables: ${missing.join(", ")}`));
    }
    started = import("../../server/src/index.js").then(({ startServer }) => startServer());
    // A failed boot must not poison the warm instance; the next request retries.
    started.catch(() => {
      started = null;
    });
  }
  return started;
}

function isAuthorizedCron(req: IncomingMessage): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(req.headers.authorization ?? "");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let instance: StartedServer;
  try {
    instance = await startOnce();
  } catch (err) {
    console.error("Paperclip failed to start on Vercel", err);
    sendJson(res, 503, { error: err instanceof Error ? err.message : "Paperclip failed to start" });
    return;
  }

  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname === VERCEL_CRON_PATH) {
    if (!isAuthorizedCron(req)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    await instance.runSchedulerTick();
    sendJson(res, 200, { ok: true });
    return;
  }

  await new Promise<void>((resolve) => {
    res.once("finish", resolve);
    res.once("close", resolve);
    instance.server.emit("request", req, res);
  });
}
