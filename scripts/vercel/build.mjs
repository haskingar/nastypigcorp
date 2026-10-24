#!/usr/bin/env node
// Builds a Vercel Build Output API (v3) bundle in .vercel/output:
//   static/                 the board UI (ui/dist)
//   functions/api/server.func/  one Node.js function running the Paperclip server
//   config.json             routes (filesystem first, everything else -> function) and crons
//
// The server is bundled from TypeScript source with esbuild. Workspace
// packages (@paperclipai/*) are inlined; third-party packages stay external and
// are copied in with @vercel/nft, keeping their repo-relative layout so the
// function directory mirrors the checkout.
//
// Usage: node scripts/vercel/build.mjs [--skip-ui]

import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, readFile, readlink, realpath, rm, symlink, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { nodeFileTrace } from "@vercel/nft";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outputDir = join(repoRoot, ".vercel", "output");
const functionDir = join(outputDir, "functions", "api", "server.func");
const bundleDir = join(repoRoot, "server", "vercel-dist");
const skipUi = process.argv.includes("--skip-ui");

// Files the server reads from disk at runtime rather than importing.
const RUNTIME_ASSET_DIRS = [
  "packages/db/src/migrations",
  "server/src/onboarding-assets",
  "server/src/built-ins",
  "server/src/services/scripts",
  "skills",
  "packages/skills-catalog",
  "packages/teams-catalog",
  "ui/dist",
];

const SCHEDULER_CRON_PATH = "/api/vercel/cron/scheduler";

function log(message) {
  console.log(`[vercel-build] ${message}`);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}

function toPosix(path) {
  return path.split(sep).join("/");
}

const REQUIRE_SHIM =
  "import { createRequire as __paperclipCreateRequire } from 'node:module'; const require = __paperclipCreateRequire(import.meta.url);";

// Inlined modules keep the location they had in the checkout: import.meta.url
// is rewritten relative to the bundle, which is valid both here and inside the
// function directory because both mirror the repository layout.
const keepModuleLocations = {
  name: "keep-module-locations",
  setup(builder) {
    builder.onLoad({ filter: /\.(?:[cm]?js|[cm]?tsx?)$/ }, async (args) => {
      if (args.path.includes(`${sep}node_modules${sep}`)) return undefined;
      const source = await readFile(args.path, "utf8");
      if (!source.includes("import.meta")) return undefined;
      const rel = JSON.stringify(toPosix(relative(bundleDir, args.path)));
      const urlExpr = `new URL(${rel}, import.meta.url).href`;
      const contents = source
        .replace(/\bimport\.meta\.url\b/g, urlExpr)
        .replace(/\bimport\.meta\.dirname\b/g, `decodeURIComponent(new URL(".", ${urlExpr}).pathname).replace(/\\/$/, "")`)
        .replace(/\bimport\.meta\.filename\b/g, `decodeURIComponent(new URL(${urlExpr}).pathname)`);
      return {
        contents,
        loader: /\.[cm]?tsx?$/.test(args.path) ? (args.path.endsWith("x") ? "tsx" : "ts") : "js",
        resolveDir: dirname(args.path),
      };
    });
  },
};

// Third-party packages stay external. They are imported by a path relative to
// the bundle so packages only another workspace package depends on still
// resolve once the files are copied into the function.
const externalizeThirdParty = {
  name: "externalize-third-party",
  setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, async (args) => {
      if (args.pluginData?.externalizeThirdParty) return undefined;
      if (args.path.startsWith("@paperclipai/")) return undefined;
      if (args.path.startsWith("node:")) return { path: args.path, external: true };
      const resolved = await builder.resolve(args.path, {
        kind: args.kind,
        resolveDir: args.resolveDir,
        importer: args.importer,
        pluginData: { externalizeThirdParty: true },
      });
      if (resolved.errors.length > 0 || resolved.external || !resolved.path) {
        return { path: args.path, external: true };
      }
      if (!resolved.path.includes(`${sep}node_modules${sep}`)) return undefined;
      const real = await realpath(resolved.path);
      let rel = toPosix(relative(bundleDir, real));
      if (!rel.startsWith(".")) rel = `./${rel}`;
      return { path: rel, external: true };
    });
  },
};

async function bundleServer() {
  await rm(bundleDir, { recursive: true, force: true });
  const result = await build({
    entryPoints: { handler: join(repoRoot, "scripts", "vercel", "handler.ts") },
    outdir: bundleDir,
    outExtension: { ".js": ".mjs" },
    chunkNames: "chunk-[hash]",
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node24",
    mainFields: ["main"],
    conditions: ["node"],
    banner: { js: REQUIRE_SHIM },
    sourcemap: "linked",
    metafile: true,
    logLevel: "warning",
    plugins: [keepModuleLocations, externalizeThirdParty],
  });
  const chunks = Object.keys(result.metafile.outputs).filter((file) => file.endsWith(".mjs"));
  log(`bundled ${Object.keys(result.metafile.inputs).length} inputs into ${chunks.length} chunks`);
  return chunks.map((file) => join(repoRoot, file));
}

async function copyTracedFile(file) {
  const source = join(repoRoot, file);
  const target = join(functionDir, file);
  const stat = await lstat(source);
  await mkdir(dirname(target), { recursive: true });
  if (stat.isSymbolicLink()) {
    if (!existsSync(target)) await symlink(await readlink(source), target);
    return;
  }
  if (stat.isDirectory()) return;
  await copyFile(source, target);
}

async function buildFunction(entryFiles) {
  await rm(functionDir, { recursive: true, force: true });
  await mkdir(functionDir, { recursive: true });
  const { fileList, warnings } = await nodeFileTrace(entryFiles, {
    base: repoRoot,
    processCwd: repoRoot,
  });
  for (const warning of warnings) {
    if (!String(warning?.message ?? warning).includes("Failed to resolve dependency")) continue;
    console.warn(`[vercel-build] trace warning: ${warning.message ?? warning}`);
  }
  for (const file of fileList) await copyTracedFile(file);
  for (const dir of RUNTIME_ASSET_DIRS) {
    const source = join(repoRoot, dir);
    if (!existsSync(source)) continue;
    await cp(source, join(functionDir, dir), {
      recursive: true,
      verbatimSymlinks: true,
      filter: (path) => !path.includes(`${sep}node_modules${sep}`) && !path.endsWith(`${sep}node_modules`),
    });
  }
  await writeFile(
    join(functionDir, ".vc-config.json"),
    `${JSON.stringify(
      {
        runtime: "nodejs24.x",
        handler: toPosix(relative(repoRoot, join(bundleDir, "handler.mjs"))),
        launcherType: "Nodejs",
        shouldAddHelpers: false,
        supportsResponseStreaming: true,
        maxDuration: Number(process.env.PAPERCLIP_VERCEL_MAX_DURATION) || 800,
        memory: Number(process.env.PAPERCLIP_VERCEL_MEMORY_MB) || 3009,
      },
      null,
      2,
    )}\n`,
  );
  // The function root must not inherit the repo's "type": "module" ambiguity.
  await writeFile(join(functionDir, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  log(`function contains ${fileList.size} traced files`);
}

async function writeConfig() {
  const config = {
    version: 3,
    routes: [
      { handle: "filesystem" },
      { src: "/(.*)", dest: "/api/server" },
    ],
    crons: [{ path: SCHEDULER_CRON_PATH, schedule: process.env.PAPERCLIP_VERCEL_CRON_SCHEDULE || "* * * * *" }],
  };
  await writeFile(join(outputDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

async function main() {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  if (!skipUi) {
    log("building UI");
    run("pnpm", ["--filter", "@paperclipai/ui", "build"]);
  }
  if (!existsSync(join(repoRoot, "ui", "dist", "index.html"))) {
    throw new Error("ui/dist/index.html is missing; build the UI first");
  }
  await cp(join(repoRoot, "ui", "dist"), join(outputDir, "static"), { recursive: true });
  // index.html is served by the server so it can apply instance branding.
  await rm(join(outputDir, "static", "index.html"), { force: true });

  // The plugin SDK is the one workspace package consumed from its dist build.
  log("building plugin SDK");
  run("pnpm", ["--filter", "@paperclipai/plugin-sdk", "build"]);

  log("bundling server");
  const entryFiles = await bundleServer();
  log("tracing server dependencies");
  await buildFunction(entryFiles);
  await writeConfig();
  log(`done: ${toPosix(relative(repoRoot, outputDir))}`);
}

await main();
