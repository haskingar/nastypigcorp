import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.vercel-sandbox-provider";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Vercel Sandbox Provider",
  description:
    "First-party sandbox provider plugin that provisions Vercel Sandbox microVMs as Paperclip execution environments.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  environmentDrivers: [
    {
      driverKey: "vercel-sandbox",
      kind: "sandbox_provider",
      displayName: "Vercel Sandbox",
      description:
        "Provisions Vercel Sandbox microVMs (Node.js 24 and common coding agents preinstalled) with configurable image, vCPUs, region, and timeouts.",
      configSchema: {
        type: "object",
        properties: {
          image: {
            type: "string",
            description:
              "Sandbox image. Defaults to vercel/sandbox/universal, which ships Node.js 24 and common coding agents. Use your own Vercel Container Registry image for custom tooling.",
            default: "vercel/sandbox/universal",
          },
          accessToken: {
            type: "string",
            format: "secret-ref",
            description:
              "Vercel access token. Paste a token or an existing Paperclip secret reference; saved environments store pasted values as company secrets. Falls back to VERCEL_TOKEN, then to Vercel OIDC (VERCEL_OIDC_TOKEN).",
          },
          teamId: {
            type: "string",
            description: "Vercel team ID that owns the sandboxes. Required with an access token; falls back to VERCEL_TEAM_ID.",
          },
          projectId: {
            type: "string",
            description: "Vercel project ID the sandboxes are billed to. Required with an access token; falls back to VERCEL_PROJECT_ID.",
          },
          vcpus: {
            type: "number",
            description: "vCPUs per sandbox (2 GB memory per vCPU).",
            default: 2,
          },
          region: {
            type: "string",
            description: "Vercel region for new sandboxes, e.g. iad1, fra1. Defaults to the Vercel Sandbox default region.",
          },
          timeoutMs: {
            type: "number",
            description:
              "Sandbox lifetime in milliseconds, extended before each command. Defaults to 45 minutes; the maximum depends on your Vercel plan.",
            default: 2700000,
          },
          reuseLease: {
            type: "boolean",
            description: "Whether to stop and later resume sandboxes (keeping their filesystem) across runs.",
            default: false,
          },
        },
      },
    },
  ],
};

export default manifest;
