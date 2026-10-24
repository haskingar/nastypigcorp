# Deploying Paperclip on Vercel

Paperclip can run entirely on Vercel services:

| Paperclip needs        | Vercel service                                   |
| ---------------------- | ------------------------------------------------ |
| API server + board UI  | One Vercel Function + static files (CDN)         |
| PostgreSQL             | Vercel Postgres / Neon (Vercel Marketplace)      |
| File + run-log storage | Vercel Blob (private store)                      |
| Heartbeat scheduler    | Vercel Cron (every minute)                       |
| Agent execution        | Vercel Sandbox (bundled sandbox provider plugin) |

The deployment always runs in `authenticated` + `public` mode.

## How it works

- `vercel.json` runs `node scripts/vercel/build.mjs`, which writes a
  [Build Output API](https://vercel.com/docs/build-output-api/v3) bundle to
  `.vercel/output`:
  - `static/`: the built board UI, served from the CDN.
  - `functions/api/server.func/`: the server, bundled from TypeScript source
    with esbuild. Third-party packages are traced in with `@vercel/nft`.
  - `config.json`: static files are served first, every other path goes to the
    function. It also registers the scheduler cron.
- `scripts/vercel/handler.ts` boots the regular Paperclip server once per
  function instance. It sets `PAPERCLIP_SERVERLESS=true` so the server does not
  bind a port, then hands each request to the HTTP server.
- The build bundles the Vercel Sandbox provider plugin
  (`packages/plugins/sandbox-providers/vercel-sandbox`) into the function,
  together with its dependencies. On Vercel the server auto-installs it from
  that bundled catalog and runs its worker next to the server.
- Vercel Cron calls `/api/vercel/cron/scheduler` with `CRON_SECRET`. That runs
  one heartbeat scheduler tick, because a frozen function never fires the
  in-process interval.

## Setup

1. Import the repository as a Vercel project. Keep the root directory at the
   repository root; `vercel.json` provides the install and build commands.
2. Add **Postgres** from the Vercel Marketplace (Neon). This sets
   `DATABASE_URL` (or `POSTGRES_URL`, which the handler also accepts).
3. Create a **Blob** store and connect it to the project. This sets
   `BLOB_READ_WRITE_TOKEN`. When that token is present, the handler switches
   storage to `vercel_blob` automatically.
4. Add these environment variables. Each value must be the same on every
   instance, so set them once and never let the server generate them:

   | Variable                            | Value                                           |
   | ----------------------------------- | ----------------------------------------------- |
   | `BETTER_AUTH_SECRET`                | `openssl rand -hex 32`                          |
   | `PAPERCLIP_SECRETS_MASTER_KEY`      | `openssl rand -base64 32` — back this up        |
   | `PAPERCLIP_DECISION_SIGNING_SECRET` | `openssl rand -hex 32`                          |
   | `CRON_SECRET`                       | `openssl rand -hex 32`                          |
   | `PAPERCLIP_BOOTSTRAP_SECRET`        | `openssl rand -hex 32` (remove after first login) |
   | `PAPERCLIP_PUBLIC_URL`              | Only with a custom domain, e.g. `https://paperclip.example.com` |
   | `VERCEL_TOKEN`                      | Vercel access token used to create sandboxes (optional; can also be set per environment) |
   | `VERCEL_TEAM_ID`                    | Team that owns the sandboxes (with `VERCEL_TOKEN`) |
   | `VERCEL_PROJECT_ID`                 | Project the sandboxes are billed to, usually this project (with `VERCEL_TOKEN`) |

   Without a custom domain, the public URL defaults to
   `https://$VERCEL_PROJECT_PRODUCTION_URL`.
5. Deploy. The first request applies the database migrations.
6. Create the first admin by opening this URL in the browser:

   ```
   https://<your-app>/api/vercel/bootstrap-ceo?secret=<PAPERCLIP_BOOTSTRAP_SECRET>
   ```

   It returns a one-time `inviteUrl`. Open that URL, sign up, and accept the
   invite. The endpoint returns `409` once an admin exists, and `404` while
   `PAPERCLIP_BOOTSTRAP_SECRET` is unset. Remove the variable after setup.
7. Set up agent execution. In `Instance Settings -> Environments`, create a
   sandbox environment with the provider **Vercel Sandbox**. Use **Test** to
   probe it, then run your agents in it. The default image,
   `vercel/sandbox/universal`, already ships Node.js 24 and common coding agent
   CLIs. See the plugin
   [README](../packages/plugins/sandbox-providers/vercel-sandbox/README.md)
   for every option.

## Limits

- **Plan:** Vercel Pro (or higher) is required. Hobby allows only daily cron
  jobs, and the scheduler needs to run every minute. Hobby also caps functions
  far below the 800 s this deployment uses.
- **Agents need a sandbox environment.** Local agent adapters (`claude_local`,
  `codex_local`, …) start CLI processes. A Vercel Function cannot do that on
  the server itself, so run them in a Vercel Sandbox environment (step 7).
  Cloud adapters such as `cursor_cloud` work without a sandbox.
- **Run length:** one function invocation lasts at most `maxDuration`
  (800 s). The orphaned-run reaper cleans up longer runs.
- **Live updates:** Vercel Functions cannot accept WebSocket upgrades. The board
  still works, but it does not push live events.
- **Database backups:** the built-in `pg_dump` backups are off. Use the
  Postgres provider's backups instead.
- **Cold start:** the first request on a new instance takes a few seconds while
  the server boots.

## Build locally

```sh
pnpm install
node scripts/vercel/build.mjs          # or --skip-ui to reuse ui/dist
```

To try the function, serve its handler with a plain Node HTTP server. It needs
`VERCEL=1`, the variables above, and a reachable `DATABASE_URL`:

```js
import http from "node:http";
const { default: handler } = await import(
  "./.vercel/output/functions/api/server.func/server/vercel-dist/handler.mjs"
);
http.createServer(handler).listen(4100);
```

Build tuning variables: `PAPERCLIP_VERCEL_MAX_DURATION` (seconds, default
800), `PAPERCLIP_VERCEL_MEMORY_MB` (default 3009), and
`PAPERCLIP_VERCEL_CRON_SCHEDULE` (default `* * * * *`).
