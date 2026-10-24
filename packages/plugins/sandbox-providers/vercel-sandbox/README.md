# `@paperclipai/plugin-vercel-sandbox`

Vercel Sandbox provider plugin for Paperclip. It runs agent work in
[Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) microVMs.

The default image, `vercel/sandbox/universal`, ships Node.js 24 and common
coding agent CLIs, which meets [SANDBOX-REQUIREMENTS.md](../SANDBOX-REQUIREMENTS.md).

Like the other sandbox providers, this package lives in the monorepo but is
excluded from the root `pnpm` workspace and publishes as a standalone npm
package.

## Install

- **Paperclip on Vercel** (`doc/VERCEL.md`): nothing to do. The Vercel build
  bundles this plugin into the function, and the server auto-installs it.
- **Any other instance:** install `@paperclipai/plugin-vercel-sandbox` from the
  Plugins page.

## Configuration

Configure it from `Instance Settings -> Environments`: create a sandbox
environment with the provider **Vercel Sandbox**.

| Field         | Default                    | Notes |
| ------------- | -------------------------- | ----- |
| `accessToken` | —                          | Vercel access token. Pasted values are stored as company secrets. Falls back to `VERCEL_TOKEN`. |
| `teamId`      | —                          | Required with a token. Falls back to `VERCEL_TEAM_ID`. |
| `projectId`   | —                          | Project the sandboxes are billed to. Required with a token. Falls back to `VERCEL_PROJECT_ID`. |
| `image`       | `vercel/sandbox/universal` | Any Vercel Container Registry image. |
| `vcpus`       | `2`                        | 2 GB memory per vCPU. |
| `region`      | SDK default                | For example `iad1` or `fra1`. |
| `timeoutMs`   | 45 minutes                 | Sandbox lifetime. It is extended before each command, up to your plan's maximum. |
| `reuseLease`  | `false`                    | `true` creates persistent sandboxes. They stop on release and resume with their filesystem. |

Without an access token, the plugin uses Vercel OIDC through
`VERCEL_OIDC_TOKEN`, for example after `vercel env pull` in local development.

The host passes only `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, and
`VERCEL_OIDC_TOKEN` to this plugin's worker. It passes them only when the
plugin was installed from npm or from the bundled catalog.

## Behavior

- **Lease:** each lease is one sandbox. The provider lease ID is the sandbox
  name.
- **Workspace:** created under `<sandbox cwd>/paperclip-workspace`
  (`/vercel/sandbox/paperclip-workspace` on the default image).
- **Commands:** run as `sh -c 'exec env … <command> <args>'`. Stdin is staged
  as a temporary file and redirected in. Vercel Sandbox kills a command at its
  deadline with SIGKILL; the plugin reports that as `timedOut`.
- **Release:** deletes the sandbox, or stops it when `reuseLease` is on.
  Destroy always deletes it. A sandbox that no longer exists counts as already
  cleaned up.

## Local development

```bash
cd packages/plugins/sandbox-providers/vercel-sandbox
pnpm install --ignore-workspace --no-lockfile
pnpm build
pnpm test
pnpm typecheck
```
