#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extension = resolve(root, "pi-extension");
const pnpm = process.platform === "win32" ? "npx.cmd" : "npx";
const pnpmVersion = "pnpm@10.26.1";

function run(args) {
  const result = spawnSync(pnpm, ["--yes", pnpmVersion, "--dir", extension, ...args], {
    cwd: root,
    stdio: "inherit",
    // Pi installs Git packages with `npm install --omit=dev`. The nested
    // extension build and its pinned Git lifecycle helper both require their
    // declared build-time toolchain, so scope the dev omission override to this
    // child only; it never changes the operator's npm/Pi configuration.
    env: {
      ...process.env,
      npm_config_omit: "",
      NPM_CONFIG_OMIT: "",
      npm_config_production: "false",
      NPM_CONFIG_PRODUCTION: "false",
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Pi installs a Git package with npm at its repository root. This small bridge
// intentionally invokes the nested, lockfile-owned package manager so the
// extension's dependency graph and compiled dist are deterministic.
run(["install", "--frozen-lockfile"]);
run(["build"]);

if (!existsSync(resolve(extension, "dist", "index.js"))) {
  throw new Error("Remote Pi extension build did not produce pi-extension/dist/index.js");
}
