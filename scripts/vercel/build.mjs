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
import { cp, lstat, mkdir, readdir, readFile, readlink, realpath, rm, symlink, writeFile, copyFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  // The server renders the branded SPA shell; assets are served statically.
  "ui/dist/index.html",
];

// Never needed on Vercel: Postgres is always external (DATABASE_URL), the
// runtime is glibc-based, and local agent CLI binaries cannot run inside a
// function. Keeps the function under the 250 MB size limit.
const TRACE_IGNORE = (path) =>
  /(^|\/)node_modules\/(@embedded-postgres\/|embedded-postgres\/|@img\/[^/]*linuxmusl|@github\/copilot-)/.test(path);

const SCHEDULER_CRON_PATH = "/api/vercel/cron/scheduler";

// Sandbox provider plugins shipped inside the function. The server
// auto-installs them from the bundled catalog (packages/plugins) on Vercel.
const BUNDLED_SANDBOX_PLUGINS = ["packages/plugins/sandbox-providers/vercel-sandbox"];

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

// The server loads the runner package through source shims that import its
// TypeScript by computed URL at runtime (the regular build swaps in a compiled
// dist instead). Here the shims become static re-exports so esbuild bundles
// the runner source like any other workspace package.
const RUNNER_SHIMS = new Map([
  [join(repoRoot, "server/src/vendor/paperclip-runner/index.ts"), join(repoRoot, "packages/paperclip-runner/src/index.ts")],
  [join(repoRoot, "server/src/vendor/paperclip-runner/live/index.ts"), join(repoRoot, "packages/paperclip-runner/src/live/index.ts")],
]);

const bundleRunnerSource = {
  name: "bundle-runner-source",
  setup(builder) {
    builder.onLoad({ filter: /[\\/]vendor[\\/]paperclip-runner[\\/]/ }, (args) => {
      const target = RUNNER_SHIMS.get(args.path);
      if (!target) return undefined;
      return { contents: `export * from ${JSON.stringify(target)};\n`, loader: "ts", resolveDir: dirname(target) };
    });
  },
};

// Real paths of every external third-party module the bundle imports. These,
// not the multi-megabyte bundle chunks, are what @vercel/nft traces.
const externalModuleFiles = new Set();
// Directories of the workspace modules esbuild inlined.
const inlinedModuleDirs = new Set();

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
      externalModuleFiles.add(real);
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
    plugins: [bundleRunnerSource, keepModuleLocations, externalizeThirdParty],
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.includes("node_modules/") && !input.includes(":")) inlinedModuleDirs.add(dirname(join(repoRoot, input)));
  }
  const chunks = Object.keys(result.metafile.outputs).filter((file) => file.endsWith(".mjs"));
  log(
    `bundled ${Object.keys(result.metafile.inputs).length} inputs into ${chunks.length} chunks ` +
      `with ${externalModuleFiles.size} external modules`,
  );
}

// Inlined modules locate sibling files (scripts, skills, migrations) with
// `new URL("<asset>", import.meta.url)`, which keepModuleLocations rewrote to
// `new URL("<asset>", new URL("<module>", import.meta.url))`. Collect every
// such asset that exists in the checkout so the function ships it.
async function discoverModuleAssets() {
  const pattern = /new URL\(\s*"([^"]+)",\s*new URL\("([^"]+)", import\.meta\.url\)/g;
  const assets = new Set();
  for (const file of await readdir(bundleDir)) {
    if (!file.endsWith(".mjs")) continue;
    const source = await readFile(join(bundleDir, file), "utf8");
    for (const [, asset, modulePath] of source.matchAll(pattern)) {
      const target = fileURLToPath(new URL(asset, pathToFileURL(join(bundleDir, modulePath))));
      if (!target.startsWith(repoRoot + sep) || !existsSync(target)) continue;
      if (/\.[cm]?tsx?$/.test(target)) continue;
      // Package roots and source trees are anchors for further path math, not
      // assets; the code under them is already in the bundle.
      if (statSync(target).isDirectory() && (basename(target) === "src" || existsSync(join(target, "package.json")))) {
        continue;
      }
      assets.add(toPosix(relative(repoRoot, target)));
    }
  }
  // Modules also read siblings by other means (readFileSync of a joined
  // path, spawn of a script): ship every non-code file next to them.
  for (const dir of inlinedModuleDirs) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || NON_ASSET_FILE.test(entry.name)) continue;
      assets.add(toPosix(relative(repoRoot, join(dir, entry.name))));
    }
  }
  return [...assets].filter((asset) => asset !== "" && !asset.startsWith("node_modules"));
}

const NON_ASSET_FILE = /(\.[cm]?tsx?|\.map|\.test\.[cm]?[jt]sx?|\.snap|^tsconfig.*\.json|^vitest\.config\..*)$/;

function nearestPackageDir(dir) {
  for (let current = dir; current.startsWith(repoRoot); current = dirname(current)) {
    if (existsSync(join(current, "package.json"))) return current;
  }
  return null;
}

// Inlined code also loads packages at runtime with createRequire() anchored at
// its source file (ws, ssh2, @opentelemetry/api, ...). Ship each inlined
// workspace package's node_modules links and trace their targets so those
// lookups resolve exactly as in the checkout.
async function collectWorkspaceDependencyLinks() {
  const packageDirs = new Set([...inlinedModuleDirs].map(nearestPackageDir).filter(Boolean));
  const links = [];
  for (const packageDir of packageDirs) {
    const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
    const requireFromPackage = createRequire(join(packageDir, "package.json"));
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      if (name.startsWith("@paperclipai/")) continue;
      const link = join(packageDir, "node_modules", name);
      if (!existsSync(link) || TRACE_IGNORE(toPosix(relative(repoRoot, link)))) continue;
      links.push(toPosix(relative(repoRoot, link)));
      const target = await realpath(link);
      if (existsSync(join(target, "package.json"))) externalModuleFiles.add(join(target, "package.json"));
      try {
        externalModuleFiles.add(await realpath(requireFromPackage.resolve(name)));
      } catch {
        // ESM-only or type-only packages: the bundle's own imports cover them.
      }
    }
  }
  return links;
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

async function buildFunction() {
  await rm(functionDir, { recursive: true, force: true });
  await mkdir(functionDir, { recursive: true });
  const dependencyLinks = await collectWorkspaceDependencyLinks();
  const { fileList, warnings } = await nodeFileTrace([...externalModuleFiles], {
    base: repoRoot,
    processCwd: repoRoot,
    ignore: TRACE_IGNORE,
  });
  // Unresolved optional/platform-specific dependencies (other OS binaries,
  // bun:*, pg-native, ...) are expected; list them with PAPERCLIP_VERCEL_TRACE_VERBOSE=1.
  const unresolved = [...warnings].filter((warning) => String(warning?.message ?? warning).includes("Failed to resolve dependency"));
  if (process.env.PAPERCLIP_VERCEL_TRACE_VERBOSE === "1") {
    for (const warning of unresolved) console.warn(`[vercel-build] trace warning: ${warning.message ?? warning}`);
  } else if (unresolved.length > 0) {
    log(`skipped ${unresolved.length} unresolvable optional dependencies`);
  }
  for (const file of [...fileList, ...dependencyLinks]) {
    if (!file.endsWith(".map")) await copyTracedFile(file);
  }
  const moduleAssets = await discoverModuleAssets();
  log(`copying ${moduleAssets.length} module-relative assets`);
  for (const dir of [toPosix(relative(repoRoot, bundleDir)), ...RUNTIME_ASSET_DIRS, ...moduleAssets]) {
    const source = join(repoRoot, dir);
    if (!existsSync(source)) continue;
    await cp(source, join(functionDir, dir), {
      recursive: true,
      verbatimSymlinks: true,
      filter: (path) =>
        !path.includes(`${sep}node_modules${sep}`) && !path.endsWith(`${sep}node_modules`) && !path.endsWith(".map"),
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

// Plugin workers are forked from <plugin>/dist/worker.js and loaded without
// npm install, so each one is bundled with all of its dependencies.
async function bundleSandboxPlugins() {
  for (const pluginDir of BUNDLED_SANDBOX_PLUGINS) {
    const sourceDir = join(repoRoot, pluginDir);
    const targetDir = join(functionDir, pluginDir);
    await build({
      entryPoints: { manifest: join(sourceDir, "src", "manifest.ts"), worker: join(sourceDir, "src", "worker.ts") },
      outdir: join(targetDir, "dist"),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node24",
      banner: { js: REQUIRE_SHIM },
      logLevel: "warning",
    });
    await copyFile(join(sourceDir, "package.json"), join(targetDir, "package.json"));
    log(`bundled plugin ${pluginDir}`);
  }
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
  await bundleServer();
  log("tracing server dependencies");
  await buildFunction();
  await bundleSandboxPlugins();
  await writeConfig();
  log(`done: ${toPosix(relative(repoRoot, outputDir))}`);
}

await main();
