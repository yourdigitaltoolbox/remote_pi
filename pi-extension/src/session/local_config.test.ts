import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  LocalConfigConflictError,
  LocalConfigLockError,
  LocalConfigRepairRequiredError,
  LocalConfigSecurityError,
  inspectLocalConfig,
  loadLocalConfig,
  localConfigExists,
  saveLocalConfig,
} from "./local_config.js";

const ENV = "REMOTE_PI_DIRECT_CONFIG";

function makeCwd(): string {
  return mkdtempSync(join(tmpdir(), "rp-localcfg-"));
}

/** Write a config.json into <cwd>/.pi/remote-pi/. */
function writeFileConfig(cwd: string, obj: unknown): void {
  const dir = join(cwd, ".pi", "remote-pi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(obj));
}

describe("loadLocalConfig — file vs REMOTE_PI_DIRECT_CONFIG", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeCwd();
    delete process.env[ENV];
  });
  afterEach(() => {
    delete process.env[ENV];
    rmSync(cwd, { recursive: true, force: true });
  });

  test("reads the on-disk file when env is unset", () => {
    writeFileConfig(cwd, { agent_name: "fromfile", auto_start_relay: false });
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "fromfile", auto_start_relay: false });
  });

  test("empty config when neither env nor file present", () => {
    expect(loadLocalConfig(cwd)).toEqual({});
  });

  test("inline env takes precedence over the file", () => {
    writeFileConfig(cwd, { agent_name: "fromfile", auto_start_relay: false });
    process.env[ENV] = JSON.stringify({ agent_name: "fromenv", auto_start_relay: true });
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "fromenv", auto_start_relay: true });
  });

  test("inline env works with no file on disk", () => {
    process.env[ENV] = JSON.stringify({ agent_name: "envonly" });
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "envonly" });
  });

  test("malformed env JSON falls back to the file", () => {
    writeFileConfig(cwd, { agent_name: "fromfile" });
    process.env[ENV] = "{not valid json";
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "fromfile" });
  });

  test("empty/whitespace env falls back to the file", () => {
    writeFileConfig(cwd, { agent_name: "fromfile" });
    process.env[ENV] = "   ";
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "fromfile" });
  });

  test("only known fields are surfaced (unknown keys dropped)", () => {
    process.env[ENV] = JSON.stringify({ agent_name: "a", auto_start_relay: true, session_name: "x", junk: 1 });
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "a", auto_start_relay: true });
  });

  test("non-object env (array/number) falls back to the file", () => {
    writeFileConfig(cwd, { agent_name: "fromfile" });
    process.env[ENV] = "[1,2,3]";
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "fromfile" });
  });
});

describe("loadLocalConfig — workspace / worktree removed (plan 38)", () => {
  // The fields were dropped: the mesh identity is `(cwd, nome)`, with `cwd`
  // subsuming folder + worktree disambiguation. A stale key from an old config
  // (or one the Cockpit still injects) must be silently ignored on read.
  let cwd: string;

  beforeEach(() => {
    cwd = makeCwd();
    delete process.env[ENV];
  });
  afterEach(() => {
    delete process.env[ENV];
    rmSync(cwd, { recursive: true, force: true });
  });

  test("ignores a stale workspace/worktree key from the file", () => {
    writeFileConfig(cwd, { agent_name: "app", workspace: "acme", worktree: "feat-login" });
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "app" });
  });

  test("ignores a stale workspace/worktree key from the inline env", () => {
    process.env[ENV] = JSON.stringify({ agent_name: "app", workspace: "acme", worktree: "feat-login" });
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "app" });
  });
});

describe("localConfigExists — honors env + file", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeCwd();
    delete process.env[ENV];
  });
  afterEach(() => {
    delete process.env[ENV];
    rmSync(cwd, { recursive: true, force: true });
  });

  test("false when neither env nor file present", () => {
    expect(localConfigExists(cwd)).toBe(false);
  });

  test("true when only the file exists", () => {
    writeFileConfig(cwd, { agent_name: "a" });
    expect(localConfigExists(cwd)).toBe(true);
  });

  test("true when only the inline env is set", () => {
    process.env[ENV] = JSON.stringify({ agent_name: "a" });
    expect(localConfigExists(cwd)).toBe(true);
  });

  test("false when env is set but malformed and no file", () => {
    process.env[ENV] = "nope";
    expect(localConfigExists(cwd)).toBe(false);
  });
});

describe("corrupt durable config", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeCwd();
    delete process.env[ENV];
  });
  afterEach(() => {
    delete process.env[ENV];
    rmSync(cwd, { recursive: true, force: true });
  });

  test("fails closed without overwriting malformed JSON", () => {
    const dir = join(cwd, ".pi", "remote-pi");
    const configPath = join(dir, "config.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, "{broken", "utf8");

    const inspected = inspectLocalConfig(cwd);
    expect(inspected).toMatchObject({ state: "repair_required", revision: 0 });
    expect(inspected.diagnostic).toMatch(/valid JSON/i);
    expect(loadLocalConfig(cwd)).toEqual({ auto_start_relay: false });
    expect(() => saveLocalConfig(cwd, { agent_name: "replacement" }))
      .toThrow(LocalConfigRepairRequiredError);
    expect(readFileSync(configPath, "utf8")).toBe("{broken");
  });

  test("does not auto-migrate a legacy config writable by other users", () => {
    if (process.platform === "win32") return;
    const dir = join(cwd, ".pi", "remote-pi");
    const configPath = join(dir, "config.json");
    mkdirSync(dir, { recursive: true, mode: 0o777 });
    writeFileSync(configPath, JSON.stringify({ agent_name: "legacy", auto_start_relay: true }), { mode: 0o666 });
    chmodSync(dir, 0o777);
    chmodSync(configPath, 0o666);

    expect(inspectLocalConfig(cwd)).toMatchObject({
      state: "repair_required",
      diagnostic: expect.stringMatching(/must not be group\/other writable/i),
    });
    expect(() => saveLocalConfig(cwd, {})).toThrow(LocalConfigRepairRequiredError);
  });

  test("requires operator repair for a suspicious legacy runtime name", () => {
    const dir = join(cwd, ".pi", "remote-pi");
    const configPath = join(dir, "config.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ agent_name: "worker#2", auto_start_relay: true }), "utf8");

    const inspected = inspectLocalConfig(cwd);
    expect(inspected.state).toBe("repair_required");
    expect(inspected.state === "repair_required" ? inspected.diagnostic : "").toMatch(/suspicious legacy agent_name/i);
    expect(loadLocalConfig(cwd)).toEqual({ auto_start_relay: false });
    expect(readFileSync(configPath, "utf8")).toContain("worker#2");
  });

  test("operator-confirmed suspicious-name repair preserves a valid workspace identity", () => {
    const first = saveLocalConfig(cwd, { agent_name: "worker" })!;
    const configPath = join(cwd, ".pi", "remote-pi", "config.json");
    const stored = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    stored["agent_name"] = "worker#2";
    writeFileSync(configPath, JSON.stringify(stored));

    const inspected = inspectLocalConfig(cwd);
    expect(inspected).toMatchObject({
      state: "repair_required",
      revision: 1,
      workspaceId: first.workspaceId,
    });
    expect(() => saveLocalConfig(cwd, {}, { repair: true }))
      .toThrow(/must supply an explicit agent_name/i);

    if (inspected.state !== "repair_required") throw new Error("expected repair state");
    const repaired = saveLocalConfig(cwd, { agent_name: "worker-confirmed" }, {
      repair: true,
      expectedRevision: inspected.revision,
      expectedState: inspected.state,
      expectedHash: inspected.hash ?? null,
    });
    expect(repaired).toMatchObject({ revision: 2, workspaceId: first.workspaceId });
    expect(inspectLocalConfig(cwd)).toMatchObject({ state: "loaded", workspaceId: first.workspaceId, revision: 2 });
  });

  test("repair CAS rejects changed corrupt bytes with the same revision", () => {
    const first = saveLocalConfig(cwd, { agent_name: "worker" });
    const configPath = join(cwd, ".pi", "remote-pi", "config.json");
    const stored = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    stored["agent_name"] = "worker#2";
    writeFileSync(configPath, JSON.stringify(stored));
    const reviewed = inspectLocalConfig(cwd);
    if (reviewed.state !== "repair_required") throw new Error("expected repair state");

    stored["auto_start_relay"] = false;
    writeFileSync(configPath, JSON.stringify(stored));
    expect(() => saveLocalConfig(cwd, { agent_name: "confirmed" }, {
      repair: true,
      expectedRevision: reviewed.revision,
      expectedState: reviewed.state,
      expectedHash: reviewed.hash ?? null,
    })).toThrow(LocalConfigConflictError);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
      revision: first.revision,
      agent_name: "worker#2",
      auto_start_relay: false,
    });
  });

  test("rejects structurally invalid or unknown versioned fields", () => {
    saveLocalConfig(cwd, { agent_name: "worker" });
    const configPath = join(cwd, ".pi", "remote-pi", "config.json");
    const stored = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    stored["auto_start_relay"] = "yes";
    expect(() => writeFileSync(configPath, JSON.stringify(stored))).not.toThrow();
    expect(inspectLocalConfig(cwd)).toMatchObject({ state: "repair_required", diagnostic: expect.stringMatching(/must be a boolean/i) });

    stored["auto_start_relay"] = true;
    stored["mystery"] = 1;
    writeFileSync(configPath, JSON.stringify(stored));
    expect(inspectLocalConfig(cwd)).toMatchObject({ state: "repair_required", diagnostic: expect.stringMatching(/unknown durable field/i) });
  });

  test("repair never creates directories through a symlinked workspace path", () => {
    if (process.platform === "win32") return;
    const outside = makeCwd();
    const piPath = join(cwd, ".pi");
    symlinkSync(outside, piPath);

    expect(() => saveLocalConfig(cwd, { agent_name: "replacement" }, {
      repair: true,
      expectedRevision: 0,
      expectedState: "repair_required",
      expectedHash: null,
    })).toThrow(LocalConfigSecurityError);
    expect(() => statSync(join(outside, "remote-pi"))).toThrow();
    rmSync(outside, { recursive: true, force: true });
  });

  test("rejects a symlinked workspace root without trusting or mutating its config", () => {
    if (process.platform === "win32") return;
    saveLocalConfig(cwd, { agent_name: "target" });
    const targetConfig = join(cwd, ".pi", "remote-pi", "config.json");
    const before = readFileSync(targetConfig, "utf8");
    const aliasParent = makeCwd();
    const alias = join(aliasParent, "workspace-alias");
    symlinkSync(cwd, alias);
    try {
      expect(inspectLocalConfig(alias)).toMatchObject({
        state: "repair_required",
        diagnostic: expect.stringMatching(/symlinked config path component/i),
      });
      expect(() => saveLocalConfig(alias, { agent_name: "replacement" }))
        .toThrow(LocalConfigSecurityError);
      expect(readFileSync(targetConfig, "utf8")).toBe(before);
    } finally {
      rmSync(aliasParent, { recursive: true, force: true });
    }
  });

  test("rejects a symlinked config path without touching its target", () => {
    const dir = join(cwd, ".pi", "remote-pi");
    const outside = join(makeCwd(), "outside.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(outside, JSON.stringify({ agent_name: "outside" }), "utf8");
    symlinkSync(outside, join(dir, "config.json"));

    const inspected = inspectLocalConfig(cwd);
    expect(inspected.state).toBe("repair_required");
    expect(inspected.state === "repair_required" ? inspected.diagnostic : "").toMatch(/symlink/i);
    expect(() => saveLocalConfig(cwd, { agent_name: "replacement" }))
      .toThrow(LocalConfigSecurityError);
    expect(JSON.parse(readFileSync(outside, "utf8"))).toEqual({ agent_name: "outside" });
    rmSync(dirname(outside), { recursive: true, force: true });
  });
});

describe("saveLocalConfig — unaffected by env (still writes the file)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeCwd();
    delete process.env[ENV];
  });
  afterEach(() => {
    delete process.env[ENV];
    rmSync(cwd, { recursive: true, force: true });
  });

  test("auto_start_relay defaults to true on save", () => {
    saveLocalConfig(cwd, { agent_name: "saved" });
    delete process.env[ENV]; // ensure we read the file back, not any env
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "saved", auto_start_relay: true });
  });

  test("never merges an ephemeral direct-config override into durable bytes", () => {
    saveLocalConfig(cwd, { agent_name: "disk", auto_start_relay: false });
    process.env[ENV] = JSON.stringify({ agent_name: "ephemeral", auto_start_relay: true });
    saveLocalConfig(cwd, { agent_name: "updated" });
    delete process.env[ENV];
    expect(loadLocalConfig(cwd)).toEqual({ agent_name: "updated", auto_start_relay: false });
  });

  test("creates versioned private workspace identity with an atomic first revision", () => {
    saveLocalConfig(cwd, { agent_name: "saved", auto_start_relay: false });

    const dir = join(cwd, ".pi", "remote-pi");
    const configPath = join(dir, "config.json");
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(raw).toMatchObject({
      schema_version: 1,
      revision: 1,
      agent_name: "saved",
      auto_start_relay: false,
    });
    expect(raw["workspace_id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(raw).not.toHaveProperty("agent_id");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["config.json"]);
  });

  test("can establish a supervisor-injected workspace identity without rotating it", () => {
    const workspaceId = "77777777-7777-4777-8777-777777777777";
    const first = saveLocalConfig(cwd, { agent_name: "daemon" }, { workspaceId });
    expect(first.workspaceId).toBe(workspaceId);
    const inspection = inspectLocalConfig(cwd);
    if (inspection.state !== "loaded") throw new Error("expected loaded config");
    const second = saveLocalConfig(cwd, { agent_name: "renamed" }, {
      workspaceId,
      expectedRevision: inspection.revision,
      expectedState: inspection.state,
      expectedHash: inspection.hash,
    });
    expect(second).toMatchObject({ workspaceId, revision: 2, config: { agent_name: "renamed" } });
  });

  test("rejects a supervisor workspace identity that conflicts with protected config", () => {
    const first = saveLocalConfig(cwd, { agent_name: "daemon" });
    const inspection = inspectLocalConfig(cwd);
    if (inspection.state !== "loaded") throw new Error("expected loaded config");
    expect(() => saveLocalConfig(cwd, { agent_name: "blocked" }, {
      workspaceId: "77777777-7777-4777-8777-777777777777",
      expectedRevision: inspection.revision,
      expectedState: inspection.state,
      expectedHash: inspection.hash,
    })).toThrow(LocalConfigConflictError);
    expect(inspectLocalConfig(cwd)).toMatchObject({ workspaceId: first.workspaceId, revision: 1 });
  });

  test("rejects secret, capability, or invalid typed material before creating durable bytes", () => {
    expect(() => saveLocalConfig(cwd, { relay_capability: "do-not-store" } as never))
      .toThrow(LocalConfigSecurityError);
    expect(() => saveLocalConfig(cwd, { auto_start_relay: "yes" } as never))
      .toThrow(LocalConfigSecurityError);
    expect(localConfigExists(cwd)).toBe(false);
  });

  test("rejects a symlinked writer lock without touching its target", () => {
    saveLocalConfig(cwd, { agent_name: "first" });
    const outside = join(makeCwd(), "outside.lock");
    writeFileSync(outside, "do-not-touch", "utf8");
    const lockPath = join(cwd, ".pi", "remote-pi", "config.lock");
    symlinkSync(outside, lockPath);

    expect(() => saveLocalConfig(cwd, { agent_name: "blocked" }, { expectedRevision: 1 }))
      .toThrow(LocalConfigSecurityError);
    expect(readFileSync(outside, "utf8")).toBe("do-not-touch");
    rmSync(dirname(outside), { recursive: true, force: true });
  });

  test("repairs private permissions without rotating workspace identity", () => {
    const first = saveLocalConfig(cwd, { agent_name: "first" })!;
    if (process.platform === "win32") return;
    const dir = join(cwd, ".pi", "remote-pi");
    const configPath = join(dir, "config.json");
    chmodSync(dir, 0o755);
    chmodSync(configPath, 0o644);

    expect(inspectLocalConfig(cwd)).toMatchObject({
      state: "repair_required",
      workspaceId: first.workspaceId,
      diagnostic: expect.stringMatching(/private directory mode/i),
    });
    const repairInspection = inspectLocalConfig(cwd);
    if (repairInspection.state !== "repair_required") throw new Error("expected repair state");
    const repaired = saveLocalConfig(cwd, { agent_name: "first" }, {
      repair: true,
      expectedRevision: repairInspection.revision,
      expectedState: repairInspection.state,
      expectedHash: repairInspection.hash ?? null,
    });
    expect(repaired).toMatchObject({ revision: 2, workspaceId: first.workspaceId });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  test("refuses a concurrent writer lock without changing the current revision", () => {
    const first = saveLocalConfig(cwd, { agent_name: "first" });
    expect(first).toBeDefined();
    const lockPath = join(cwd, ".pi", "remote-pi", "config.lock");
    writeFileSync(lockPath, "other-writer", { mode: 0o600 });

    expect(() => saveLocalConfig(cwd, { agent_name: "blocked" }, { expectedRevision: 1 }))
      .toThrow(LocalConfigLockError);
    rmSync(lockPath, { force: true });
    const raw = JSON.parse(readFileSync(join(cwd, ".pi", "remote-pi", "config.json"), "utf8")) as Record<string, unknown>;
    expect(raw).toMatchObject({ revision: 1, agent_name: "first" });
  });

  test("fails closed on a stale writer lock until deliberate manual recovery", () => {
    const first = saveLocalConfig(cwd, { agent_name: "first" });
    const lockPath = join(cwd, ".pi", "remote-pi", "config.lock");
    const staleBytes = JSON.stringify({
      pid: 2_147_483_647,
      processStartedAt: 1,
      acquiredAt: 1,
      nonce: "11111111-1111-4111-8111-111111111111",
    });
    writeFileSync(lockPath, staleBytes, { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(lockPath, 0o600);

    expect(() => saveLocalConfig(cwd, { agent_name: "blocked" }, { expectedRevision: first.revision }))
      .toThrow(LocalConfigLockError);
    expect(readFileSync(lockPath, "utf8")).toBe(staleBytes);
    expect(inspectLocalConfig(cwd)).toMatchObject({ state: "loaded", revision: first.revision, workspaceId: first.workspaceId });

    rmSync(lockPath);
    const recovered = saveLocalConfig(cwd, { agent_name: "after-manual-recovery" }, { expectedRevision: first.revision });
    expect(recovered).toMatchObject({ revision: 2, workspaceId: first.workspaceId, config: { agent_name: "after-manual-recovery" } });
  });

  test("preserves identity across revisions and rejects a stale writer", () => {
    const first = saveLocalConfig(cwd, { agent_name: "first" });
    expect(first).toBeDefined();
    const second = saveLocalConfig(cwd, { agent_name: "second" }, { expectedRevision: first!.revision });
    expect(second).toMatchObject({
      revision: 2,
      workspaceId: first!.workspaceId,
      config: { agent_name: "second" },
    });

    expect(() => saveLocalConfig(cwd, { agent_name: "stale" }, { expectedRevision: 1 }))
      .toThrow(LocalConfigConflictError);
    expect(loadLocalConfig(cwd).agent_name).toBe("second");
  });
});
