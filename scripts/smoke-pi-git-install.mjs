#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const source = process.env.REMOTE_PI_GIT_SOURCE;
const sha = process.env.REMOTE_PI_GIT_SHA;
const pi = process.env.PI_BIN ?? "pi";
if (!source || !/^[0-9a-f]{40}$/i.test(sha ?? "")) {
  throw new Error("Set REMOTE_PI_GIT_SOURCE and REMOTE_PI_GIT_SHA (a full 40-character commit) for the disposable Git-install smoke.");
}

const home = mkdtempSync(join(tmpdir(), "remote-pi-git-install-"));
const config = join(home, "agent");
const env = {
  ...process.env,
  HOME: home,
  PI_CODING_AGENT_DIR: config,
  PI_CODING_AGENT_SESSION_DIR: join(home, "sessions"),
  GIT_TERMINAL_PROMPT: "0",
};
const spec = `git:${source}@${sha}`;

function run(args) {
  const result = spawnSync(pi, args, { cwd: home, env, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${pi} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout;
}

try {
  // Install twice: the second invocation makes the Git reconcile path prove it
  // can reset/build the same immutable source without duplicate registration.
  run(["install", spec]);
  run(["install", spec]);
  const listed = run(["list"]);
  if (!listed.includes(source) || !listed.includes(sha)) throw new Error("Pi list does not retain the exact Git source and commit.");

  const settings = JSON.parse(readFileSync(resolve(config, "settings.json"), "utf8"));
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  if (packages.filter((entry) => entry === spec).length !== 1) throw new Error("Pi settings did not retain exactly one Remote Pi package registration.");

  const clone = resolve(config, "git", "github.com", "yourdigitaltoolbox", "remote_pi");
  const manifest = JSON.parse(readFileSync(resolve(clone, "package.json"), "utf8"));
  if (!Array.isArray(manifest.pi?.extensions) || manifest.pi.extensions.length !== 1 || manifest.pi.extensions[0] !== "./pi-extension/dist") {
    throw new Error("Installed root package does not declare exactly one Remote Pi extension target.");
  }
  if (!existsSync(resolve(clone, "pi-extension", "dist", "index.js"))) {
    throw new Error("Pi Git install did not build the discoverable pi-extension/dist/index.js target.");
  }
  process.stdout.write(`Remote Pi Git-install smoke passed for ${sha}.\n`);
} finally {
  // The disposable profile prevents pairings, tokens, package registration, or
  // other test residue from reaching the operator's live Pi home.
  rmSync(home, { recursive: true, force: true });
}
