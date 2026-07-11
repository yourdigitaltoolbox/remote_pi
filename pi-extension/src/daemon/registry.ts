import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { daemonIdForCwd } from "./id.js";
import { defaultAgentName, inspectLocalConfig, sanitizeSegment } from "../session/local_config.js";

/**
 * The global daemon registry: which working directories are promoted to
 * always-on daemons under the supervisor.
 *
 * The registry stores normalized `cwd`, presentation name, and a durable
 * generic `workspaceId`. It is protected like the cwd identity config: opened
 * no-follow reads, private ownership/modes, corruption fail-closed behavior,
 * revision/hash CAS under an exclusive writer lock, and atomic fsync+rename.
 * The daemon `id` remains derived from cwd via `daemonIdForCwd`, never persisted.
 *
 * Cwds are always normalized to an absolute realpath before storage. A user
 * typing `/remote-pi create ~/Movies` or `/remote-pi create .` therefore
 * resolves to the same entry as `/remote-pi create /Users/x/Movies`.
 */

function registryRoot(): string {
  return resolvePath(process.env["REMOTE_PI_HOME"] || homedir());
}

/** Resolved at call time so tests can override via `REMOTE_PI_HOME`. */
function registryPathInternal(): string {
  return join(registryRoot(), ".pi", "remote", "daemons.json");
}

export interface DaemonEntry {
  /** Absolute realpath of the cwd this daemon manages. */
  cwd: string;
  /** Durable generic workspace correlation injected into the daemon runtime. */
  workspaceId?: string;
  /** Presentation name injected through `REMOTE_PI_DIRECT_CONFIG`. */
  name?: string;
}

export interface DaemonRegistry {
  daemons: DaemonEntry[];
}

interface StoredDaemonRegistry {
  schema_version: 1;
  revision: number;
  daemons: Array<Required<Pick<DaemonEntry, "cwd" | "name" | "workspaceId">>>;
}

export interface DaemonRegistrySnapshot {
  registry: DaemonRegistry;
  state: "missing" | "legacy" | "loaded";
  revision: number;
  hash: string | null;
}

export interface SaveRegistryOptions {
  expectedRevision: number;
  expectedHash: string | null;
}

export class DaemonRegistrySecurityError extends Error {
  constructor(message: string) {
    super(`Daemon registry security error: ${message}`);
    this.name = "DaemonRegistrySecurityError";
  }
}

export class DaemonRegistryCorruptError extends Error {
  constructor(message: string) {
    super(`Daemon registry is corrupt: ${message}`);
    this.name = "DaemonRegistryCorruptError";
  }
}

export class DaemonRegistryConflictError extends Error {
  constructor(message: string) {
    super(`Daemon registry conflict: ${message}`);
    this.name = "DaemonRegistryConflictError";
  }
}

export class DaemonRegistryLockError extends Error {
  constructor() {
    super("Daemon registry writer lock is already held; stale locks require deliberate manual recovery.");
    this.name = "DaemonRegistryLockError";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORBIDDEN_KEY = /(secret|token|capability|credential|password|nonce|lease)/i;

function hashRaw(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function noFollowFlags(base: number): number {
  return base | fsConstants.O_NOFOLLOW;
}

function pathStillNames(filePath: string, opened: Pick<Stats, "dev" | "ino">): boolean {
  try {
    const current = lstatSync(filePath);
    return !current.isSymbolicLink() && current.dev === opened.dev && current.ino === opened.ino;
  } catch {
    return false;
  }
}

function requirePathStillNames(filePath: string, opened: Pick<Stats, "dev" | "ino">, label: string): void {
  if (!pathStillNames(filePath, opened)) {
    throw new DaemonRegistrySecurityError(`${label} changed during protected registry access`);
  }
}

function validateOwnedDirectory(stat: Stats, label: string, exactPrivate = false): void {
  if (!stat.isDirectory()) throw new DaemonRegistrySecurityError(`${label} must be a real directory`);
  if (process.platform === "win32") return;
  const getuid = process.getuid;
  if (typeof getuid === "function" && stat.uid !== getuid()) {
    throw new DaemonRegistrySecurityError(`${label} must be owned by the current user`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new DaemonRegistrySecurityError(`${label} must not be group/other writable`);
  }
  if (exactPrivate && (stat.mode & 0o777) !== 0o700) {
    throw new DaemonRegistrySecurityError(`${label} must have mode 0700`);
  }
}

function validateOwnedFile(stat: Stats, label: string, exactPrivate = false): void {
  if (!stat.isFile()) throw new DaemonRegistrySecurityError(`${label} must be a regular file`);
  if (process.platform === "win32") return;
  const getuid = process.getuid;
  if (typeof getuid === "function" && stat.uid !== getuid()) {
    throw new DaemonRegistrySecurityError(`${label} must be owned by the current user`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new DaemonRegistrySecurityError(`${label} must not be group/other writable`);
  }
  if (exactPrivate && (stat.mode & 0o777) !== 0o600) {
    throw new DaemonRegistrySecurityError(`${label} must have mode 0600`);
  }
}

function registryPathDiagnostic(): string | undefined {
  const root = registryRoot();
  const filePath = registryPathInternal();
  const rel = relative(root, filePath);
  if (rel.startsWith("..") || isAbsolute(rel)) return "registry path escapes its configured root";
  for (const candidate of [root, join(root, ".pi"), join(root, ".pi", "remote"), filePath]) {
    try {
      if (lstatSync(candidate).isSymbolicLink()) return `symlinked registry path component is not allowed: ${candidate}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return `registry path component cannot be inspected: ${candidate}`;
    }
  }
  return undefined;
}

interface OpenedRegistryBytes {
  raw: string;
  dirStat: Stats;
  fileStat: Stats;
}

function readOpenedRegistry(filePath: string): OpenedRegistryBytes {
  const root = registryRoot();
  const piPath = join(root, ".pi");
  const registryDir = dirname(filePath);
  let rootFd: number | undefined;
  let piFd: number | undefined;
  let dirFd: number | undefined;
  let fileFd: number | undefined;
  try {
    rootFd = openSync(root, noFollowFlags(fsConstants.O_RDONLY | fsConstants.O_DIRECTORY));
    const rootStat = fstatSync(rootFd);
    validateOwnedDirectory(rootStat, "registry root");
    piFd = openSync(piPath, noFollowFlags(fsConstants.O_RDONLY | fsConstants.O_DIRECTORY));
    const piStat = fstatSync(piFd);
    validateOwnedDirectory(piStat, ".pi registry ancestor");
    dirFd = openSync(registryDir, noFollowFlags(fsConstants.O_RDONLY | fsConstants.O_DIRECTORY));
    const dirStat = fstatSync(dirFd);
    validateOwnedDirectory(dirStat, "registry directory");
    fileFd = openSync(filePath, noFollowFlags(fsConstants.O_RDONLY));
    const fileStat = fstatSync(fileFd);
    validateOwnedFile(fileStat, "daemon registry");
    const raw = readFileSync(fileFd, "utf8");
    requirePathStillNames(root, rootStat, "registry root");
    requirePathStillNames(piPath, piStat, ".pi registry ancestor");
    requirePathStillNames(registryDir, dirStat, "registry directory");
    requirePathStillNames(filePath, fileStat, "daemon registry");
    return { raw, dirStat, fileStat };
  } finally {
    if (fileFd !== undefined) closeSync(fileFd);
    if (dirFd !== undefined) closeSync(dirFd);
    if (piFd !== undefined) closeSync(piFd);
    if (rootFd !== undefined) closeSync(rootFd);
  }
}

function legacyWorkspaceId(cwd: string): string {
  const bytes = createHash("sha256").update("remote-pi-daemon-workspace-v1\0").update(cwd).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseEntries(value: unknown, versioned: boolean): DaemonEntry[] {
  if (!Array.isArray(value)) throw new DaemonRegistryCorruptError("daemons must be an array");
  const daemons: DaemonEntry[] = [];
  const seenCwds = new Set<string>();
  const seenWorkspaceIds = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new DaemonRegistryCorruptError(`daemon entry ${index} must be an object`);
    }
    const record = item as Record<string, unknown>;
    const forbidden = Object.keys(record).find((key) => FORBIDDEN_KEY.test(key));
    if (forbidden) throw new DaemonRegistryCorruptError(`daemon entry ${index} contains forbidden field '${forbidden}'`);
    const unknown = Object.keys(record).find((key) => key !== "cwd" && key !== "name" && key !== "workspaceId");
    if (unknown) throw new DaemonRegistryCorruptError(`daemon entry ${index} contains unknown field '${unknown}'`);
    const cwd = record["cwd"];
    if (typeof cwd !== "string" || !cwd || !isAbsolute(cwd)) {
      throw new DaemonRegistryCorruptError(`daemon entry ${index} requires an absolute cwd`);
    }
    const entry: DaemonEntry = { cwd };
    const name = record["name"];
    if (name !== undefined) {
      if (typeof name !== "string" || !sanitizeSegment(name)) {
        throw new DaemonRegistryCorruptError(`daemon entry ${index} has an invalid name`);
      }
      entry.name = name;
    }
    const workspaceId = record["workspaceId"];
    if (workspaceId !== undefined) {
      if (typeof workspaceId !== "string" || !UUID_PATTERN.test(workspaceId)) {
        throw new DaemonRegistryCorruptError(`daemon entry ${index} has an invalid workspaceId`);
      }
      entry.workspaceId = workspaceId.toLowerCase();
    }
    if (versioned && (!entry.name || !entry.workspaceId)) {
      throw new DaemonRegistryCorruptError(`versioned daemon entry ${index} requires name and workspaceId`);
    }
    if (seenCwds.has(entry.cwd)) {
      throw new DaemonRegistryCorruptError(`daemon entry ${index} duplicates cwd ownership`);
    }
    seenCwds.add(entry.cwd);
    if (entry.workspaceId) {
      if (seenWorkspaceIds.has(entry.workspaceId)) {
        throw new DaemonRegistryCorruptError(`daemon entry ${index} duplicates workspaceId ownership`);
      }
      seenWorkspaceIds.add(entry.workspaceId);
    }
    daemons.push(entry);
  }
  return daemons;
}

export function inspectRegistry(): DaemonRegistrySnapshot {
  const diagnostic = registryPathDiagnostic();
  if (diagnostic) throw new DaemonRegistrySecurityError(diagnostic);
  const filePath = registryPathInternal();
  let opened: OpenedRegistryBytes;
  try {
    opened = readOpenedRegistry(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { registry: { daemons: [] }, state: "missing", revision: 0, hash: null };
    }
    if (error instanceof DaemonRegistrySecurityError) throw error;
    throw new DaemonRegistrySecurityError(`registry cannot be read safely: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { raw, dirStat, fileStat } = opened;
  const hash = hashRaw(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new DaemonRegistryCorruptError("file is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DaemonRegistryCorruptError("top-level value must be an object");
  }
  const record = parsed as Record<string, unknown>;
  const forbidden = Object.keys(record).find((key) => FORBIDDEN_KEY.test(key));
  if (forbidden) throw new DaemonRegistryCorruptError(`top-level contains forbidden field '${forbidden}'`);

  if (record["schema_version"] === undefined) {
    const unknown = Object.keys(record).find((key) => key !== "daemons");
    if (unknown) throw new DaemonRegistryCorruptError(`legacy registry contains unknown field '${unknown}'`);
    const daemons = parseEntries(record["daemons"], false);
    if (process.platform !== "win32" && (((dirStat.mode | fileStat.mode) & 0o022) !== 0)) {
      throw new DaemonRegistrySecurityError("legacy registry and directory must not be group/other writable");
    }
    // Historical cwd/name-only registries were commonly 0755/0644 and are
    // accepted for one-time migration. A persisted workspaceId is already
    // authoritative identity and is accepted only from fully private bytes.
    if (process.platform !== "win32"
      && daemons.some((entry) => entry.workspaceId)
      && ((dirStat.mode & 0o777) !== 0o700 || (fileStat.mode & 0o777) !== 0o600)) {
      throw new DaemonRegistrySecurityError("legacy registry containing workspaceId requires modes 0700/0600");
    }
    return {
      registry: { daemons },
      state: "legacy",
      revision: 0,
      hash,
    };
  }

  const allowedKeys = new Set(["schema_version", "revision", "daemons"]);
  const unknown = Object.keys(record).find((key) => !allowedKeys.has(key));
  if (unknown) throw new DaemonRegistryCorruptError(`versioned registry contains unknown field '${unknown}'`);
  const revision = record["revision"];
  if (record["schema_version"] !== 1 || !Number.isInteger(revision) || (revision as number) < 1) {
    throw new DaemonRegistryCorruptError("versioned registry requires schema_version 1 and a positive revision");
  }
  validateOwnedDirectory(dirStat, "versioned registry directory", true);
  validateOwnedFile(fileStat, "versioned daemon registry", true);
  return {
    registry: { daemons: parseEntries(record["daemons"], true) },
    state: "loaded",
    revision: revision as number,
    hash,
  };
}

/** Reads the registry. Missing is empty; corruption/security errors fail closed. */
export function loadRegistry(): DaemonRegistry {
  return inspectRegistry().registry;
}

interface OpenedRegistryDir {
  path: string;
  fd: number;
  stat: Stats;
}

function ensureRegistryDir(): OpenedRegistryDir {
  const root = registryRoot();
  const piDir = join(root, ".pi");
  const remoteDir = join(piDir, "remote");
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink()) throw new DaemonRegistrySecurityError("registry root must not be a symlink");
  validateOwnedDirectory(rootStat, "registry root");
  let retained: OpenedRegistryDir | undefined;
  try {
    for (const candidate of [piDir, remoteDir]) {
      try {
        mkdirSync(candidate, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      let fd: number | undefined;
      try {
        fd = openSync(candidate, noFollowFlags(fsConstants.O_RDONLY | fsConstants.O_DIRECTORY));
        const stat = fstatSync(fd);
        validateOwnedDirectory(stat, candidate);
        requirePathStillNames(candidate, stat, "registry path component");
        if (candidate === remoteDir) {
          retained = { path: candidate, fd, stat };
          fd = undefined;
        }
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
    if (!retained) throw new DaemonRegistrySecurityError("registry directory could not be opened safely");
    return retained;
  } catch (error) {
    if (retained) closeSync(retained.fd);
    throw error;
  }
}

function validateRegistryForWrite(reg: DaemonRegistry): StoredDaemonRegistry["daemons"] {
  const seenCwds = new Set<string>();
  const seenWorkspaceIds = new Set<string>();
  return reg.daemons.map((entry, index) => {
    if (!isAbsolute(entry.cwd) || !entry.cwd) throw new DaemonRegistryCorruptError(`daemon entry ${index} requires an absolute cwd`);
    if (!entry.name || !sanitizeSegment(entry.name)) throw new DaemonRegistryCorruptError(`daemon entry ${index} requires a safe name`);
    if (!entry.workspaceId || !UUID_PATTERN.test(entry.workspaceId)) throw new DaemonRegistryCorruptError(`daemon entry ${index} requires workspaceId UUID`);
    const workspaceId = entry.workspaceId.toLowerCase();
    if (seenCwds.has(entry.cwd)) throw new DaemonRegistryCorruptError(`daemon entry ${index} duplicates cwd ownership`);
    if (seenWorkspaceIds.has(workspaceId)) throw new DaemonRegistryCorruptError(`daemon entry ${index} duplicates workspaceId ownership`);
    seenCwds.add(entry.cwd);
    seenWorkspaceIds.add(workspaceId);
    return { cwd: entry.cwd, name: entry.name, workspaceId };
  });
}

function readOpenedLock(lockPath: string): { stat: Stats; raw: string } {
  let fd: number | undefined;
  try {
    fd = openSync(lockPath, noFollowFlags(fsConstants.O_RDONLY));
    const stat = fstatSync(fd);
    validateOwnedFile(stat, "daemon registry writer lock", true);
    return { stat, raw: readFileSync(fd, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new DaemonRegistrySecurityError("symlinked daemon registry writer lock is not allowed");
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function removeOwnedLock(lockPath: string, inode: Pick<Stats, "dev" | "ino">, nonce: string): void {
  try {
    const current = readOpenedLock(lockPath);
    if (current.stat.dev !== inode.dev || current.stat.ino !== inode.ino) return;
    const metadata = JSON.parse(current.raw) as { nonce?: unknown };
    if (metadata.nonce === nonce) rmSync(lockPath);
  } catch { /* fail closed: never remove an unknown replacement */ }
}

export function saveRegistry(reg: DaemonRegistry, options: SaveRegistryOptions): number {
  const daemons = validateRegistryForWrite(reg);
  const filePath = registryPathInternal();
  const dirPath = dirname(filePath);
  const lockPath = join(dirPath, "daemons.lock");
  const tempPath = join(dirPath, `.daemons.json.${process.pid}.${randomUUID()}.tmp`);
  const nonce = randomUUID();
  let registryDir: OpenedRegistryDir | undefined;
  let lockFd: number | undefined;
  let lockStat: Stats | undefined;
  let lockMetadataWritten = false;
  let tempFd: number | undefined;
  try {
    registryDir = ensureRegistryDir();
    requirePathStillNames(dirPath, registryDir.stat, "registry directory");
    try {
      lockFd = openSync(lockPath, noFollowFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL), 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        readOpenedLock(lockPath); // diagnose unsafe static entries without deleting
        throw new DaemonRegistryLockError();
      }
      throw error;
    }
    lockStat = fstatSync(lockFd);
    writeFileSync(lockFd, JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), nonce }), "utf8");
    fsyncSync(lockFd);
    lockMetadataWritten = true;

    const current = inspectRegistry();
    if (current.revision !== options.expectedRevision) {
      throw new DaemonRegistryConflictError(`expected revision ${options.expectedRevision}, found ${current.revision}`);
    }
    if (current.hash !== options.expectedHash) {
      throw new DaemonRegistryConflictError("registry bytes changed since inspection");
    }

    fchmodSync(registryDir.fd, 0o700);
    registryDir.stat = fstatSync(registryDir.fd);
    requirePathStillNames(dirPath, registryDir.stat, "registry directory");
    const stored: StoredDaemonRegistry = {
      schema_version: 1,
      revision: current.revision + 1,
      daemons,
    };
    tempFd = openSync(tempPath, noFollowFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL), 0o600);
    writeFileSync(tempFd, JSON.stringify(stored, null, 2) + "\n", "utf8");
    fsyncSync(tempFd);
    closeSync(tempFd);
    tempFd = undefined;
    requirePathStillNames(dirPath, registryDir.stat, "registry directory");
    renameSync(tempPath, filePath);
    requirePathStillNames(dirPath, registryDir.stat, "registry directory");
    fsyncSync(registryDir.fd);
    return stored.revision;
  } finally {
    if (tempFd !== undefined) {
      try { closeSync(tempFd); } catch { /* best effort */ }
    }
    if (lockFd !== undefined) {
      try { closeSync(lockFd); } catch { /* best effort */ }
    }
    const directoryStillOwned = registryDir !== undefined && pathStillNames(dirPath, registryDir.stat);
    if (directoryStillOwned) {
      try { rmSync(tempPath, { force: true }); } catch { /* best effort */ }
      if (lockStat && lockMetadataWritten) removeOwnedLock(lockPath, lockStat, nonce);
    }
    if (registryDir !== undefined) {
      try { closeSync(registryDir.fd); } catch { /* best effort */ }
    }
  }
}

/**
 * Normalizes a user-provided path: expands `~`, resolves relative components,
 * and runs `realpath` to canonicalize symlinks. Throws if it does not exist.
 */
export function normalizeCwd(input: string): string {
  if (!input || !input.trim()) throw new Error("cwd is required");
  let p = input.trim();
  if (p === "~") p = homedir();
  else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  if (!isAbsolute(p)) p = resolvePath(process.cwd(), p);
  return realpathSync(p);
}

function snapshotForMutation(): DaemonRegistrySnapshot {
  return inspectRegistry();
}

function protectedWorkspaceIdForCwd(cwd: string): string | undefined {
  const inspected = inspectLocalConfig(cwd);
  if (inspected.state === "repair_required") {
    throw new DaemonRegistrySecurityError(`cwd config for ${cwd} requires repair before daemon registration: ${inspected.diagnostic}`);
  }
  return inspected.state === "loaded" ? inspected.workspaceId.toLowerCase() : undefined;
}

export function addDaemon(rawCwd: string, name?: string): { id: string; cwd: string; name: string; workspaceId: string } {
  const cwd = normalizeCwd(rawCwd);
  const snapshot = snapshotForMutation();
  if (snapshot.registry.daemons.some((d) => d.cwd === cwd)) {
    throw new Error(`Daemon already registered for cwd: ${cwd}`);
  }
  const resolvedName = sanitizeSegment(name?.trim() || defaultAgentName(cwd)) ?? defaultAgentName(cwd);
  // A protected cwd identity already owns workspace correlation. Reuse it so
  // supervisor injection cannot disagree with the same cwd's authoritative
  // config. Missing/legacy cwd config is established later from this registry
  // identity when an eligible daemon persistence action occurs.
  const workspaceId = protectedWorkspaceIdForCwd(cwd) ?? randomUUID();
  snapshot.registry.daemons.push({ cwd, name: resolvedName, workspaceId });
  saveRegistry(snapshot.registry, { expectedRevision: snapshot.revision, expectedHash: snapshot.hash });
  return { id: daemonIdForCwd(cwd), cwd, name: resolvedName, workspaceId };
}

export function removeDaemon(id: string): { removed: boolean; cwd?: string } {
  const snapshot = snapshotForMutation();
  const idx = snapshot.registry.daemons.findIndex((d) => daemonIdForCwd(d.cwd) === id);
  if (idx === -1) return { removed: false };
  const [removed] = snapshot.registry.daemons.splice(idx, 1);
  saveRegistry(snapshot.registry, { expectedRevision: snapshot.revision, expectedHash: snapshot.hash });
  return { removed: true, cwd: removed!.cwd };
}

export function listDaemons(): Array<{ id: string; cwd: string; name: string; workspaceId: string }> {
  return loadRegistry().daemons.map((d) => ({
    id: daemonIdForCwd(d.cwd),
    cwd: d.cwd,
    name: d.name ?? defaultAgentName(d.cwd),
    workspaceId: d.workspaceId ?? legacyWorkspaceId(d.cwd),
  }));
}

/** Backfills legacy name/workspace identity under registry revision/hash CAS. */
export function migrateRegistryNames(): number {
  const snapshot = snapshotForMutation();
  let changed = 0;
  for (const d of snapshot.registry.daemons) {
    let entryChanged = false;
    const configuredWorkspaceId = protectedWorkspaceIdForCwd(d.cwd);
    if (d.workspaceId && configuredWorkspaceId && d.workspaceId.toLowerCase() !== configuredWorkspaceId) {
      throw new DaemonRegistryConflictError(`registry workspaceId for ${d.cwd} does not match protected cwd config`);
    }
    if (!d.name) {
      d.name = defaultAgentName(d.cwd);
      entryChanged = true;
    }
    if (!d.workspaceId) {
      d.workspaceId = configuredWorkspaceId ?? legacyWorkspaceId(d.cwd);
      entryChanged = true;
    }
    if (entryChanged) changed++;
  }
  // A missing registry is materialized as an empty private versioned file so
  // supervisor startup establishes and validates authoritative storage before
  // creating any adjacent socket/log infrastructure.
  if (changed > 0 || snapshot.state !== "loaded") {
    saveRegistry(snapshot.registry, { expectedRevision: snapshot.revision, expectedHash: snapshot.hash });
  }
  return changed;
}

export function registryPath(): string {
  return registryPathInternal();
}
