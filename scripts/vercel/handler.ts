// Vercel Function entry point. Every non-static request is rewritten here (see
// vercel.json) and handed to the regular Paperclip HTTP server without binding
// a port. Vercel Cron calls VERCEL_CRON_PATH to drive the heartbeat scheduler,
// because a frozen function instance never fires the in-process interval.
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

const VERCEL_CRON_PATH = "/api/vercel/cron/scheduler";
const VERCEL_BOOTSTRAP_PATH = "/api/vercel/bootstrap-ceo";

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
      return Promise.reject(new MissingEnvError(`Missing required Vercel environment variables: ${missing.join(", ")}`));
    }
    started = import("../../server/src/index.js").then(({ startServer }) => startServer());
    // A failed boot must not poison the warm instance; the next request retries.
    started.catch(() => {
      started = null;
    });
  }
  return started;
}

class MissingEnvError extends Error {}

function secretMatches(secret: string | undefined, provided: string | null | undefined): boolean {
  if (!secret || !provided) return false;
  const expected = Buffer.from(secret);
  const actual = Buffer.from(provided);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function isAuthorizedCron(req: IncomingMessage): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  return secretMatches(secret && `Bearer ${secret}`, req.headers.authorization);
}

// Opened once from a browser, so the secret may come as ?secret=. The route
// only exists while PAPERCLIP_BOOTSTRAP_SECRET is set and no admin exists.
function isAuthorizedBootstrap(req: IncomingMessage, url: URL): boolean {
  const secret = process.env.PAPERCLIP_BOOTSTRAP_SECRET?.trim();
  if (!secret) return false;
  const header = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  return secretMatches(secret, header ?? url.searchParams.get("secret"));
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
    // Only configuration gaps are safe to show publicly; details are in the logs.
    const message = err instanceof MissingEnvError ? err.message : "Paperclip failed to start; see the function logs";
    sendJson(res, 503, { error: message });
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;
  if (pathname === VERCEL_CRON_PATH) {
    if (!isAuthorizedCron(req)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    await instance.runSchedulerTick();
    sendJson(res, 200, { ok: true });
    return;
  }
  if (pathname === VERCEL_BOOTSTRAP_PATH) {
    if (!isAuthorizedBootstrap(req, url)) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    const { createBootstrapCeoInvite } = await import("../../server/src/vercel-bootstrap-ceo.js");
    const baseUrl = process.env.PAPERCLIP_PUBLIC_URL ?? process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL ?? instance.apiUrl;
    const result = await createBootstrapCeoInvite(instance.databaseUrl, baseUrl);
    sendJson(res, result.status === "created" ? 200 : 409, result);
    return;
  }

  await new Promise<void>((resolve) => {
    res.once("finish", resolve);
    res.once("close", resolve);
    instance.server.emit("request", req, res);
  });
}
