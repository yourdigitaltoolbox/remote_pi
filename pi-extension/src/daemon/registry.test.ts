import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  addDaemon,
  DaemonRegistryConflictError,
  DaemonRegistryCorruptError,
  DaemonRegistryLockError,
  DaemonRegistrySecurityError,
  inspectRegistry,
  listDaemons,
  loadRegistry,
  migrateRegistryNames,
  normalizeCwd,
  registryPath,
  removeDaemon,
  saveRegistry,
} from "./registry.js";
import { daemonIdForCwd } from "./id.js";
import { defaultAgentName, inspectLocalConfig, saveLocalConfig } from "../session/local_config.js";

/** Each test runs against an isolated $HOME-like directory so the registry
 *  writes never touch the developer's real `~/.pi/remote/daemons.json`. */
let testHome: string;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "pi-regtest-"));
  process.env["REMOTE_PI_HOME"] = testHome;
});

afterEach(() => {
  delete process.env["REMOTE_PI_HOME"];
  try { rmSync(testHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function persistRegistry(registry: Parameters<typeof saveRegistry>[0]): number {
  const snapshot = inspectRegistry();
  return saveRegistry(registry, { expectedRevision: snapshot.revision, expectedHash: snapshot.hash });
}

function writeLegacyRegistry(registry: unknown): void {
  const dir = join(testHome, ".pi", "remote");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  writeFileSync(registryPath(), JSON.stringify(registry), { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(registryPath(), 0o600);
}

describe("registryPath", () => {
  test("honors REMOTE_PI_HOME env override", () => {
    expect(registryPath()).toBe(join(testHome, ".pi", "remote", "daemons.json"));
  });
});

describe("normalizeCwd", () => {
  test("expands ~/ relative to HOME", () => {
    // We can't easily test ~ expansion against the real homedir without
    // creating an actual subdir there. Instead, simulate by creating a
    // tmp folder and asking normalizeCwd to canonicalize it absolutely.
    const tmp = mkdtempSync(join(tmpdir(), "pi-norm-"));
    expect(normalizeCwd(tmp)).toBe(realpathSync(tmp));
  });

  test("resolves relative paths against process.cwd()", () => {
    // `.` resolves to the test runner's cwd (project root). Just verify
    // it's absolute and canonicalized.
    const got = normalizeCwd(".");
    expect(isAbsolute(got)).toBe(true); // `/...` POSIX, `C:\...` win32
    expect(got).toBe(realpathSync("."));
  });

  test("throws on empty input", () => {
    expect(() => normalizeCwd("")).toThrow(/required/i);
    expect(() => normalizeCwd("   ")).toThrow(/required/i);
  });

  test("throws on non-existent path (realpath ENOENT)", () => {
    expect(() => normalizeCwd("/no/such/path/anywhere/xyz-pi-test")).toThrow();
  });

  test("symlinks resolve to canonical realpath", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-symlink-"));
    const real = join(tmp, "real");
    mkdirSync(real);
    const link = join(tmp, "link");
    symlinkSync(real, link);
    expect(normalizeCwd(link)).toBe(normalizeCwd(real));
  });
});

describe("loadRegistry / saveRegistry", () => {
  test("empty when file absent", () => {
    expect(loadRegistry()).toEqual({ daemons: [] });
    expect(inspectRegistry()).toMatchObject({ state: "missing", revision: 0, hash: null });
  });

  test("round-trip: private versioned atomic save then load", () => {
    const registry = {
      daemons: [
        { cwd: "/tmp/a", name: "a", workspaceId: "11111111-1111-4111-8111-111111111111" },
        { cwd: "/tmp/b", name: "b", workspaceId: "22222222-2222-4222-8222-222222222222" },
      ],
    };
    expect(persistRegistry(registry)).toBe(1);
    expect(loadRegistry()).toEqual(registry);
    expect(inspectRegistry()).toMatchObject({ state: "loaded", revision: 1 });
    expect(statSync(join(testHome, ".pi", "remote")).mode & 0o777).toBe(process.platform === "win32" ? statSync(join(testHome, ".pi", "remote")).mode & 0o777 : 0o700);
    if (process.platform !== "win32") expect(statSync(registryPath()).mode & 0o777).toBe(0o600);
  });

  test("creates parent dirs on save", () => {
    persistRegistry({ daemons: [] });
    expect(existsSync(registryPath())).toBe(true);
  });

  test("malformed JSON fails closed instead of becoming an empty registry", () => {
    writeLegacyRegistry({ daemons: [] });
    writeFileSync(registryPath(), "{not-json");
    expect(() => loadRegistry()).toThrow(DaemonRegistryCorruptError);
  });

  test("unknown shape fails closed", () => {
    writeLegacyRegistry({ foo: "bar" });
    expect(() => loadRegistry()).toThrow(DaemonRegistryCorruptError);
  });

  test("rejects unsafe existing ancestors even when the registry file is missing", () => {
    if (process.platform === "win32") return;
    const dir = join(testHome, ".pi", "remote");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o777);
    expect(() => loadRegistry()).toThrow(DaemonRegistrySecurityError);
  });

  test("rejects duplicate cwd and workspace ownership in read or write APIs", () => {
    const base = { cwd: "/tmp/a", name: "a", workspaceId: "11111111-1111-4111-8111-111111111111" };
    const duplicateCwd = { daemons: [base, { ...base, name: "b", workspaceId: "22222222-2222-4222-8222-222222222222" }] };
    const duplicateWorkspace = { daemons: [base, { cwd: "/tmp/b", name: "b", workspaceId: base.workspaceId }] };

    expect(() => persistRegistry(duplicateCwd)).toThrow(DaemonRegistryCorruptError);
    expect(() => persistRegistry(duplicateWorkspace)).toThrow(DaemonRegistryCorruptError);

    writeLegacyRegistry({ schema_version: 1, revision: 1, ...duplicateCwd });
    expect(() => loadRegistry()).toThrow(DaemonRegistryCorruptError);
    writeLegacyRegistry({ schema_version: 1, revision: 1, ...duplicateWorkspace });
    expect(() => loadRegistry()).toThrow(DaemonRegistryCorruptError);
  });

  test("rejects unknown legacy entry fields", () => {
    writeLegacyRegistry({ daemons: [{ cwd: "/tmp/a", unexpected: true }] });
    expect(() => loadRegistry()).toThrow(DaemonRegistryCorruptError);
  });

  test("requires private modes before accepting workspaceId from legacy bytes", () => {
    if (process.platform === "win32") return;
    writeLegacyRegistry({
      daemons: [{
        cwd: "/tmp/a",
        name: "a",
        workspaceId: "11111111-1111-4111-8111-111111111111",
      }],
    });
    chmodSync(join(testHome, ".pi", "remote"), 0o755);
    chmodSync(registryPath(), 0o644);
    expect(() => loadRegistry()).toThrow(DaemonRegistrySecurityError);
  });

  test("rejects a symlinked registry without touching its target", () => {
    if (process.platform === "win32") return;
    const dir = join(testHome, ".pi", "remote");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const outsideDir = mkdtempSync(join(tmpdir(), "pi-reg-outside-"));
    const outside = join(outsideDir, "daemons.json");
    writeFileSync(outside, JSON.stringify({ daemons: [{ cwd: "/outside" }] }));
    symlinkSync(outside, registryPath());
    try {
      expect(() => loadRegistry()).toThrow(DaemonRegistrySecurityError);
      expect(() => persistRegistry({ daemons: [] })).toThrow(DaemonRegistrySecurityError);
      expect(JSON.parse(readFileSync(outside, "utf8"))).toEqual({ daemons: [{ cwd: "/outside" }] });
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("rejects stale revision/hash writers", () => {
    const first = inspectRegistry();
    saveRegistry({ daemons: [] }, { expectedRevision: first.revision, expectedHash: first.hash });
    expect(() => saveRegistry({ daemons: [] }, { expectedRevision: first.revision, expectedHash: first.hash }))
      .toThrow(DaemonRegistryConflictError);
  });

  test("preserves stale writer locks for deliberate manual recovery", () => {
    persistRegistry({ daemons: [] });
    const lockPath = join(testHome, ".pi", "remote", "daemons.lock");
    const stale = JSON.stringify({ pid: 2_147_483_647, acquiredAt: 1, nonce: "11111111-1111-4111-8111-111111111111" });
    writeFileSync(lockPath, stale, { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(lockPath, 0o600);
    const snapshot = inspectRegistry();
    expect(() => saveRegistry(snapshot.registry, { expectedRevision: snapshot.revision, expectedHash: snapshot.hash }))
      .toThrow(DaemonRegistryLockError);
    expect(readFileSync(lockPath, "utf8")).toBe(stale);
  });
});

describe("addDaemon", () => {
  test("registers a fresh cwd and returns derived id", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-add-"));
    const result = addDaemon(tmp);
    expect(result.id).toBe(daemonIdForCwd(realpathSync(tmp)));
    expect(result.cwd).toBe(realpathSync(tmp));
    expect(result.workspaceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(listDaemons().map((d) => d.cwd)).toEqual([realpathSync(tmp)]);
  });

  test("reuses an existing protected cwd workspace identity", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-add-configured-"));
    const configured = saveLocalConfig(tmp, { agent_name: "Configured" });
    const result = addDaemon(tmp);
    expect(result.workspaceId).toBe(configured.workspaceId);
    expect(listDaemons()[0]!.workspaceId).toBe(configured.workspaceId);
  });

  test("rejects duplicate cwd (same normalized path)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-dup-"));
    addDaemon(tmp);
    expect(() => addDaemon(tmp)).toThrow(/already registered/i);
  });

  test("relative path canonicalizes to same entry as absolute", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-relabs-"));
    addDaemon(tmp);
    // Trying to add via a symlink → same normalized path → duplicate.
    const link = join(tmpdir(), `pi-relabs-link-${Date.now()}`);
    symlinkSync(tmp, link);
    expect(() => addDaemon(link)).toThrow(/already registered/i);
  });

  test("on-disk file matches loadRegistry output", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-disk-"));
    addDaemon(tmp);
    const onDisk = JSON.parse(readFileSync(registryPath(), "utf8")) as { daemons: Array<{cwd: string}> };
    expect(onDisk.daemons).toHaveLength(1);
    expect(onDisk.daemons[0]!.cwd).toBe(realpathSync(tmp));
  });
});

describe("removeDaemon", () => {
  test("removes by id and returns the cwd", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-rm-"));
    const { id } = addDaemon(tmp);
    const result = removeDaemon(id);
    expect(result.removed).toBe(true);
    expect(result.cwd).toBe(realpathSync(tmp));
    expect(listDaemons()).toEqual([]);
  });

  test("unknown id is a no-op (removed=false)", () => {
    const result = removeDaemon("ffffffff");
    expect(result.removed).toBe(false);
    expect(result.cwd).toBeUndefined();
  });

  test("only removes the matching entry — others stay", () => {
    const a = mkdtempSync(join(tmpdir(), "pi-multi-a-"));
    const b = mkdtempSync(join(tmpdir(), "pi-multi-b-"));
    const { id: idA } = addDaemon(a);
    addDaemon(b);
    removeDaemon(idA);
    const remaining = listDaemons();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.cwd).toBe(realpathSync(b));
  });
});

describe("listDaemons", () => {
  test("returns derived ids alongside cwds, in insertion order", () => {
    const a = mkdtempSync(join(tmpdir(), "pi-list-a-"));
    const b = mkdtempSync(join(tmpdir(), "pi-list-b-"));
    const addedA = addDaemon(a);
    const addedB = addDaemon(b);
    const out = listDaemons();
    expect(out).toEqual([
      { id: daemonIdForCwd(realpathSync(a)), cwd: realpathSync(a), name: defaultAgentName(realpathSync(a)), workspaceId: addedA.workspaceId },
      { id: daemonIdForCwd(realpathSync(b)), cwd: realpathSync(b), name: defaultAgentName(realpathSync(b)), workspaceId: addedB.workspaceId },
    ]);
  });

  test("legacy entry without a name falls back to the folder-derived name", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-legacy-"));
    const cwd = realpathSync(dir);
    writeLegacyRegistry({ daemons: [{ cwd }] }); // pre-name-field shape
    const out = listDaemons();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: daemonIdForCwd(cwd), cwd, name: defaultAgentName(cwd) });
    expect(out[0]!.workspaceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(listDaemons()[0]!.workspaceId).toBe(out[0]!.workspaceId);
  });

  test("empty registry yields []", () => {
    expect(listDaemons()).toEqual([]);
  });
});

describe("migrateRegistryNames", () => {
  test("backfills folder names into legacy entries and persists", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-mig-"));
    const cwd = realpathSync(dir);
    writeLegacyRegistry({ daemons: [{ cwd }] }); // legacy: no name

    const changed = migrateRegistryNames();
    expect(changed).toBe(1);

    const onDisk = JSON.parse(readFileSync(registryPath(), "utf8")) as {
      daemons: Array<{ cwd: string; name?: string; workspaceId?: string }>;
    };
    expect(onDisk.daemons[0]!.name).toBe(defaultAgentName(cwd));
    expect(onDisk.daemons[0]!.workspaceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("legacy migration reuses an existing protected cwd workspace identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-mig-configured-"));
    const cwd = realpathSync(dir);
    const configured = saveLocalConfig(cwd, { agent_name: "Configured" });
    writeLegacyRegistry({ daemons: [{ cwd }] });

    expect(migrateRegistryNames()).toBe(1);
    expect(inspectRegistry().registry.daemons[0]!.workspaceId).toBe(configured.workspaceId);
    expect(inspectLocalConfig(cwd)).toMatchObject({ state: "loaded", workspaceId: configured.workspaceId });
  });

  test("migrates historical owned 0755/0644 cwd-only bytes into protected 0700/0600 storage", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "pi-mig-modes-"));
    const cwd = realpathSync(dir);
    writeLegacyRegistry({ daemons: [{ cwd }] });
    chmodSync(join(testHome, ".pi", "remote"), 0o755);
    chmodSync(registryPath(), 0o644);

    expect(migrateRegistryNames()).toBe(1);

    expect(statSync(join(testHome, ".pi", "remote")).mode & 0o777).toBe(0o700);
    expect(statSync(registryPath()).mode & 0o777).toBe(0o600);
    expect(inspectRegistry()).toMatchObject({ state: "loaded", revision: 1 });
  });

  test("versions a complete private legacy identity even when no fields need backfill", () => {
    writeLegacyRegistry({
      daemons: [{
        cwd: "/tmp/a",
        name: "a",
        workspaceId: "11111111-1111-4111-8111-111111111111",
      }],
    });
    expect(migrateRegistryNames()).toBe(0);
    expect(inspectRegistry()).toMatchObject({ state: "loaded", revision: 1 });
  });

  test("is idempotent — a second run changes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-mig2-"));
    addDaemon(dir); // already has a name
    expect(migrateRegistryNames()).toBe(0);
  });
});
