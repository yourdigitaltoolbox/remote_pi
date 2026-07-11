import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const LOCAL_DIR = ".pi/remote-pi";
const LOCAL_FILE = "config.json";

/**
 * Escape hatch: when set, carries the WHOLE local config as inline JSON,
 * bypassing the on-disk `config.json`. For CI/ops/daemons that inject config
 * via env instead of writing a file — mirrors `REMOTE_PI_RELAY` for the relay
 * URL. Takes precedence over the file; an unset/empty/unparseable value falls
 * back to the file (never fatal).
 */
const DIRECT_CONFIG_ENV = "REMOTE_PI_DIRECT_CONFIG";

export interface LocalConfig {
  agent_name?: string;
  /**
   * If true (default), `/remote-pi` with no args auto-joins the local UDS
   * mesh and starts the relay on a fresh terminal. The field name is
   * historical (plano 21); the UX wording was reworked to "use the relay
   * on this terminal to connect to the remote mesh (mobile + PCs)". Legacy
   * configs without this field are treated as `true` for backward compat.
   */
  auto_start_relay?: boolean;
  // Historical `workspace?`/`worktree?` presentation fields were removed.
  // Current durable workspace identity is the protected `workspace_id`, while
  // cwd/name are compatibility metadata. Legacy inline projection still
  // surfaces only known LocalConfig fields.
}

export interface LocalConfigSnapshot {
  config: LocalConfig;
  schemaVersion: 1;
  revision: number;
  workspaceId: string;
}

export interface SaveLocalConfigOptions {
  expectedRevision?: number;
  /** Supervisor-injected identity to establish when no protected ID exists. */
  workspaceId?: string;
  /** Bind a reviewed inspection to the same state/hash under the writer lock. */
  expectedState?: LocalConfigInspection["state"];
  expectedHash?: string | null;
  repair?: boolean;
}

export type LocalConfigInspection =
  | { state: "missing"; config: LocalConfig; revision: 0; path: string }
  | { state: "legacy"; config: LocalConfig; revision: 0; path: string; hash: string }
  | { state: "loaded"; config: LocalConfig; schemaVersion: 1; revision: number; workspaceId: string; path: string; hash: string }
  | { state: "repair_required"; config: LocalConfig; revision: number; workspaceId?: string; path: string; hash?: string; diagnostic: string };

export class LocalConfigRepairRequiredError extends Error {
  constructor(diagnostic: string) {
    super(`Local config repair required: ${diagnostic}`);
    this.name = "LocalConfigRepairRequiredError";
  }
}

export class LocalConfigSecurityError extends Error {
  constructor(diagnostic: string) {
    super(`Local config security error: ${diagnostic}`);
    this.name = "LocalConfigSecurityError";
  }
}

export class LocalConfigLockError extends Error {
  constructor() {
    super("Local config writer lock is already held; stale locks require deliberate manual recovery.");
    this.name = "LocalConfigLockError";
  }
}

export class LocalConfigConflictError extends Error {
  constructor(expectedRevision: number, actualRevision: number, detail?: string) {
    super(`Local config revision conflict: expected ${expectedRevision}, found ${actualRevision}${detail ? ` (${detail})` : ""}.`);
    this.name = "LocalConfigConflictError";
  }
}

export class LocalConfigWriteError extends Error {
  constructor(configPath: string, cause: unknown) {
    super(`Could not persist local config ${configPath}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "LocalConfigWriteError";
  }
}

interface StoredLocalConfig extends LocalConfig {
  schema_version: 1;
  revision: number;
  workspace_id: string;
}

function pathFor(cwd: string): string {
  return join(resolve(cwd), LOCAL_DIR, LOCAL_FILE);
}

/**
 * Normalize a name segment to a mesh-safe token: trim, replace the addressing
 * separators (`/ : @ #`) and whitespace runs with `-`, collapse repeats, strip
 * edges. The `@` is included so a sanitized name can never contain the address
 * separator — the legacy `<cwd>@<name>` alias stays unambiguous. Returns
 * undefined for unusable/reserved values. Used for presentation names and
 * compatibility aliases, never to derive current runtime identity.
 */
export function sanitizeSegment(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const token = v.trim().replace(/[/:@#\s]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  if (!token) return undefined;
  if (token.toLowerCase() === "broadcast" || token.toLowerCase() === "broker") return undefined;
  return token;
}

/**
 * Project a legacy `agent_name` into the old leaf-name compatibility model.
 * This helper never writes durable bytes and is not the protected repair path.
 * `inspectLocalConfig` separately marks these suspicious shapes as
 * `repair_required`, so only an operator-confirmed replacement may persist.
 * Two historical shapes are normalized for read-only legacy projection:
 *
 *   - **`#N` collision suffix** — could only have come from a broker/lock
 *     assignment (the user can't type `#`: `sanitizeSegment` maps it to `-`), so
 *     a trailing `#<digits>` is stripped and the clean base re-derived.
 *   - **legacy `parent/folder`** — the old `defaultAgentName` shape; the `/`
 *     means it predates the leaf-only model, so we keep only the leaf segment.
 *
 * Returns the cleaned name, or undefined when nothing usable remains (so the
 * caller falls back to `defaultAgentName(cwd)`).
 */
export function migrateAgentName(raw: string): string | undefined {
  // Legacy `parent/folder` (or any path-ish value) → keep the trailing segment.
  const leaf = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  // Drop a runtime collision suffix a pre-fix build may have frozen into config.
  const clean = leaf.replace(/#\d+$/, "").trim();
  return clean.length > 0 ? clean : undefined;
}

/**
 * Parse a raw JSON string into a LocalConfig, surfacing only known fields.
 * Returns null when the input isn't a usable JSON object. Legacy `session_name`
 * from pre-refactor configs is silently dropped — the local UDS mesh is now
 * always a single fixed session, so the field has no meaning.
 */
function parseLocalConfig(raw: string): LocalConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const src = parsed as Record<string, unknown>;
  const cfg: LocalConfig = {};
  if (typeof src["agent_name"] === "string") {
    // Compatibility-only projection for legacy callers. Protected inspection
    // still rejects these shapes as repair_required; this does not authorize or
    // perform an automatic durable rewrite.
    const migrated = migrateAgentName(src["agent_name"]);
    if (migrated) cfg.agent_name = migrated;
  }
  if (typeof src["auto_start_relay"] === "boolean") cfg.auto_start_relay = src["auto_start_relay"];
  return cfg;
}

/** Inline config from `REMOTE_PI_DIRECT_CONFIG`, when set + parseable; else null. */
function directConfig(): LocalConfig | null {
  const raw = process.env[DIRECT_CONFIG_ENV];
  if (!raw || raw.trim().length === 0) return null;
  return parseLocalConfig(raw);
}

/**
 * True when a local config is available for this cwd — either inline via
 * `REMOTE_PI_DIRECT_CONFIG` or as `<cwd>/.pi/remote-pi/config.json` on disk.
 */
export function localConfigExists(cwd: string): boolean {
  return directConfig() !== null || existsSync(pathFor(cwd));
}

export function loadLocalConfig(cwd: string): LocalConfig {
  // Precedence: inline `REMOTE_PI_DIRECT_CONFIG` env wins over the file. An
  // unset/empty/malformed env falls through to the on-disk config.json.
  const direct = directConfig();
  if (direct) return direct;

  const inspected = inspectLocalConfig(cwd);
  if (inspected.state === "repair_required") {
    // Corruption/security failures are never treated as a missing config: the
    // safe compatibility projection explicitly disables relay auto-start.
    return { auto_start_relay: false };
  }
  return inspected.config;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Optional stable workspace correlation injected by the daemon supervisor.
 * It is runtime input only and is never merged into durable cwd config. */
export function loadDirectWorkspaceId(): string | undefined {
  const raw = process.env[DIRECT_CONFIG_ENV];
  if (!raw?.trim()) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const workspaceId = value?.["workspace_id"];
    return typeof workspaceId === "string" && UUID_PATTERN.test(workspaceId)
      ? workspaceId.toLowerCase()
      : undefined;
  } catch {
    return undefined;
  }
}

const FORBIDDEN_DURABLE_KEY = /(secret|token|capability|credential|password|nonce|lease)/i;

function hashRaw(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// Bind reads to opened objects and reject a symlink in the final component.
// Explicit checks cover existing ancestor symlinks. A process already executing
// as this same OS user remains outside the local config threat boundary; see
// README.md. Portable Node exposes neither openat2-style contained resolution
// nor unlinkat/flock, so it cannot close adversarial component-swap races.
function noFollowFlags(base: number): number {
  return base | fsConstants.O_NOFOLLOW;
}

interface OpenedConfigBytes {
  raw: string;
  dirStat: Stats;
  fileStat: Stats;
}

function pathStillNamesOpenedObject(filePath: string, opened: Pick<Stats, "dev" | "ino">): boolean {
  try {
    const current = lstatSync(filePath);
    return !current.isSymbolicLink() && current.dev === opened.dev && current.ino === opened.ino;
  } catch {
    return false;
  }
}

function requirePathStillNamesOpenedObject(filePath: string, opened: Pick<Stats, "dev" | "ino">, label: string): void {
  if (!pathStillNamesOpenedObject(filePath, opened)) {
    throw new LocalConfigSecurityError(`${label} changed during protected config access`);
  }
}

function readOpenedConfig(p: string): OpenedConfigBytes {
  let piFd: number | undefined;
  let dirFd: number | undefined;
  let fileFd: number | undefined;
  try {
    const piPath = dirname(dirname(p));
    piFd = openSync(piPath, noFollowFlags(fsConstants.O_RDONLY | fsConstants.O_DIRECTORY));
    const piStat = fstatSync(piFd);
    if (!piStat.isDirectory()) throw new LocalConfigSecurityError(".pi config ancestor must be a real directory");
    requirePathStillNamesOpenedObject(piPath, piStat, ".pi config ancestor");
    if (process.platform !== "win32") {
      const getuid = process.getuid;
      if ((piStat.mode & 0o022) !== 0 || (typeof getuid === "function" && piStat.uid !== getuid())) {
        throw new LocalConfigSecurityError(".pi config ancestor must be owned by the current user and not group/other writable");
      }
    }
    dirFd = openSync(dirname(p), noFollowFlags(fsConstants.O_RDONLY | fsConstants.O_DIRECTORY));
    const dirStat = fstatSync(dirFd);
    if (!dirStat.isDirectory()) throw new LocalConfigSecurityError("config parent must be a real directory");
    fileFd = openSync(p, noFollowFlags(fsConstants.O_RDONLY));
    const fileStat = fstatSync(fileFd);
    if (!fileStat.isFile()) throw new LocalConfigSecurityError("config must be a regular file");
    // The bytes and protection metadata come from the same opened object. A
    // later pathname replacement cannot redirect this read to different bytes.
    const raw = readFileSync(fileFd, "utf8");
    requirePathStillNamesOpenedObject(piPath, piStat, ".pi config ancestor");
    requirePathStillNamesOpenedObject(dirname(p), dirStat, "config parent directory");
    requirePathStillNamesOpenedObject(p, fileStat, "config file");
    return { raw, dirStat, fileStat };
  } finally {
    if (fileFd !== undefined) closeSync(fileFd);
    if (dirFd !== undefined) closeSync(dirFd);
    if (piFd !== undefined) closeSync(piFd);
  }
}

function configPathDiagnostic(cwd: string): string | undefined {
  const root = resolve(cwd);
  const p = pathFor(root);
  const rel = relative(root, p);
  if (rel.startsWith("..") || isAbsolute(rel)) return "config path escapes the workspace root";
  for (const candidate of [root, join(root, ".pi"), join(root, LOCAL_DIR), p]) {
    try {
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink()) return `symlinked config path component is not allowed: ${candidate}`;
      if (candidate === root && process.platform !== "win32") {
        const getuid = process.getuid;
        if (typeof getuid === "function" && stat.uid !== getuid()) return `workspace root must be owned by the current user: ${candidate}`;
        if ((stat.mode & 0o022) !== 0) return `workspace root must not be group/other writable: ${candidate}`;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return `config path component cannot be inspected: ${candidate}`;
      }
    }
  }
  return undefined;
}

interface OpenedConfigDir {
  path: string;
  fd: number;
  stat: Stats;
}

function ensurePrivateConfigDir(cwd: string): OpenedConfigDir {
  const root = resolve(cwd);
  const piDir = join(root, ".pi");
  const remoteDir = join(root, LOCAL_DIR);
  let retained: OpenedConfigDir | undefined;
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
        let stat = fstatSync(fd);
        if (!stat.isDirectory()) {
          throw new LocalConfigSecurityError(`config path component must be a real directory: ${candidate}`);
        }
        requirePathStillNamesOpenedObject(candidate, stat, "config path component");
        if (process.platform !== "win32") {
          const getuid = process.getuid;
          if (typeof getuid === "function" && stat.uid !== getuid()) {
            throw new LocalConfigSecurityError(`config path component must be owned by the current user: ${candidate}`);
          }
          if ((stat.mode & 0o022) !== 0) {
            throw new LocalConfigSecurityError(`config path component must not be group/other writable: ${candidate}`);
          }
        }
        if (candidate === remoteDir) {
          // Existing permission repair happens only after the writer lock and
          // reviewed state/hash CAS. A newly-created directory already has 0700.
          retained = { path: candidate, fd, stat };
          fd = undefined;
        }
      } catch (error) {
        if (error instanceof LocalConfigSecurityError) throw error;
        throw new LocalConfigSecurityError(`config path component must be a real directory: ${candidate}`);
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
    if (!retained) throw new LocalConfigSecurityError("config directory could not be opened safely");
    return retained;
  } catch (error) {
    if (retained) closeSync(retained.fd);
    throw error;
  }
}

export function inspectLocalConfig(cwd: string): LocalConfigInspection {
  const p = pathFor(cwd);
  const pathDiagnostic = configPathDiagnostic(cwd);
  if (pathDiagnostic) return { state: "repair_required", config: {}, revision: 0, path: p, diagnostic: pathDiagnostic };
  let opened: OpenedConfigBytes;
  try {
    opened = readOpenedConfig(p);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "missing", config: {}, revision: 0, path: p };
    }
    return {
      state: "repair_required",
      config: {},
      revision: 0,
      path: p,
      diagnostic: `config cannot be read safely: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const { raw, dirStat, fileStat } = opened;
  const hash = hashRaw(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { state: "repair_required", config: {}, revision: 0, path: p, hash, diagnostic: "config is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { state: "repair_required", config: {}, revision: 0, path: p, hash, diagnostic: "config must be a JSON object" };
  }
  const value = parsed as Record<string, unknown>;
  const forbidden = Object.keys(value).find((key) => FORBIDDEN_DURABLE_KEY.test(key));
  const revisionValue = value["revision"];
  const workspaceIdValue = value["workspace_id"];
  const validRevision = Number.isInteger(revisionValue) && (revisionValue as number) >= 1
    ? revisionValue as number
    : 0;
  const validWorkspaceId = typeof workspaceIdValue === "string" && UUID_PATTERN.test(workspaceIdValue)
    ? workspaceIdValue.toLowerCase()
    : undefined;
  const config = parseLocalConfig(raw) ?? {};
  const repair = (diagnostic: string): LocalConfigInspection => ({
    state: "repair_required",
    config,
    revision: validRevision,
    ...(validWorkspaceId ? { workspaceId: validWorkspaceId } : {}),
    path: p,
    hash,
    diagnostic,
  });

  if (forbidden) return repair(`config contains forbidden durable field '${forbidden}'`);
  if (value["agent_name"] !== undefined && typeof value["agent_name"] !== "string") {
    return repair("agent_name must be a string when present");
  }
  if (value["auto_start_relay"] !== undefined && typeof value["auto_start_relay"] !== "boolean") {
    return repair("auto_start_relay must be a boolean when present");
  }
  const rawAgentName = value["agent_name"];
  if (typeof rawAgentName === "string" && (!rawAgentName.trim()
    || /[\\/]/.test(rawAgentName)
    || /#\d+$/.test(rawAgentName)
    || /[\u0000-\u001f\u007f]/.test(rawAgentName))) {
    return repair("suspicious legacy agent_name requires operator-confirmed repair");
  }
  if (process.platform !== "win32") {
    const getuid = process.getuid;
    if (typeof getuid === "function" && (dirStat.uid !== getuid() || fileStat.uid !== getuid())) {
      return repair("config and directory must be owned by the current user");
    }
  }

  if (value["schema_version"] === undefined) {
    // Historical remote-pi wrote 0755/0644. Accept owned, non-writable-by-
    // others legacy bytes for one-time migration, then harden to 0700/0600.
    if (process.platform !== "win32" && (((dirStat.mode | fileStat.mode) & 0o022) !== 0)) {
      return repair("legacy config and directory must not be group/other writable");
    }
    return { state: "legacy", config, revision: 0, path: p, hash };
  }

  const allowedVersionedKeys = new Set(["schema_version", "revision", "workspace_id", "agent_name", "auto_start_relay"]);
  const unknown = Object.keys(value).find((key) => !allowedVersionedKeys.has(key));
  if (unknown) return repair(`versioned config contains unknown durable field '${unknown}'`);
  if (value["schema_version"] !== 1 || validRevision === 0 || !validWorkspaceId) {
    return repair("versioned config requires schema_version 1, a positive revision, and workspace_id UUID");
  }

  if (process.platform !== "win32" && ((dirStat.mode & 0o777) !== 0o700 || (fileStat.mode & 0o777) !== 0o600)) {
    return repair("versioned config requires private directory mode 0700 and file mode 0600");
  }

  return {
    state: "loaded",
    config,
    schemaVersion: 1,
    revision: validRevision,
    workspaceId: validWorkspaceId,
    path: p,
    hash,
  };
}

interface WriterLockMetadata {
  pid: number;
  processStartedAt: number;
  acquiredAt: number;
  nonce: string;
}

function parseWriterLock(raw: string): WriterLockMetadata | undefined {
  try {
    const value = JSON.parse(raw) as Partial<WriterLockMetadata>;
    if (!value || !Number.isInteger(value.pid) || value.pid! <= 0
      || typeof value.processStartedAt !== "number" || !Number.isFinite(value.processStartedAt)
      || typeof value.acquiredAt !== "number" || !Number.isFinite(value.acquiredAt)
      || typeof value.nonce !== "string" || !UUID_PATTERN.test(value.nonce)) return undefined;
    return value as WriterLockMetadata;
  } catch {
    return undefined;
  }
}

function readOpenedWriterLock(lockPath: string): { raw: string; stat: Stats } {
  let fd: number | undefined;
  try {
    fd = openSync(lockPath, noFollowFlags(fsConstants.O_RDONLY));
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new LocalConfigSecurityError("config writer lock must be a regular file");
    const raw = readFileSync(fd, "utf8");
    return { raw, stat };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new LocalConfigSecurityError("symlinked config writer lock is not allowed");
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function validateWriterLockProtection(stat: Stats): void {
  if (process.platform === "win32") return;
  const getuid = process.getuid;
  if ((stat.mode & 0o777) !== 0o600 || (typeof getuid === "function" && stat.uid !== getuid())) {
    throw new LocalConfigSecurityError("config writer lock must be private and owned by the current user");
  }
}

function removeOwnedWriterLock(lockPath: string, nonce: string, inode: { dev: number; ino: number }): void {
  try {
    const current = readOpenedWriterLock(lockPath);
    if (current.stat.dev !== inode.dev || current.stat.ino !== inode.ino) return;
    validateWriterLockProtection(current.stat);
    const metadata = parseWriterLock(current.raw);
    if (metadata?.nonce === nonce) rmSync(lockPath);
  } catch { /* best effort; an unknown replacement lock must not be removed */ }
}

export function saveLocalConfig(cwd: string, patch: Partial<LocalConfig>, options: SaveLocalConfigOptions = {}): LocalConfigSnapshot {
  const p = pathFor(cwd);
  const requestedWorkspaceId = options.workspaceId?.toLowerCase();
  if (requestedWorkspaceId !== undefined && !UUID_PATTERN.test(requestedWorkspaceId)) {
    throw new LocalConfigSecurityError("workspaceId option must be a UUID");
  }
  const patchKeys = Object.keys(patch as Record<string, unknown>);
  const unsafePatchKey = patchKeys.find((key) => FORBIDDEN_DURABLE_KEY.test(key));
  if (unsafePatchKey) throw new LocalConfigSecurityError(`forbidden durable field '${unsafePatchKey}'`);
  const unknownPatchKey = patchKeys.find((key) => key !== "agent_name" && key !== "auto_start_relay");
  if (unknownPatchKey) throw new LocalConfigSecurityError(`unknown durable field '${unknownPatchKey}'`);
  if (patch.agent_name !== undefined && (typeof patch.agent_name !== "string" || !sanitizeSegment(patch.agent_name))) {
    throw new LocalConfigSecurityError("agent_name must be a non-empty safe string");
  }
  if (patch.auto_start_relay !== undefined && typeof patch.auto_start_relay !== "boolean") {
    throw new LocalConfigSecurityError("auto_start_relay must be a boolean");
  }

  // Path/symlink failures are security failures, never repairable content.
  // Check before mkdir so `repair:true` cannot create directories through a
  // workspace symlink, then recheck after directory creation for races.
  const initialPathDiagnostic = configPathDiagnostic(cwd);
  if (initialPathDiagnostic) throw new LocalConfigSecurityError(initialPathDiagnostic);
  const initial = inspectLocalConfig(cwd);
  if (initial.state === "repair_required" && !options.repair) {
    throw new LocalConfigRepairRequiredError(initial.diagnostic);
  }
  if (initial.state === "repair_required"
    && /suspicious legacy agent_name/i.test(initial.diagnostic)
    && patch.agent_name === undefined) {
    throw new LocalConfigRepairRequiredError("operator-confirmed name repair must supply an explicit agent_name");
  }
  if (options.repair && (options.expectedState === undefined || options.expectedHash === undefined)) {
    throw new LocalConfigConflictError(initial.revision, initial.revision, "repair requires expectedState and expectedHash");
  }

  const dir = dirname(p);
  const lockPath = join(dir, "config.lock");
  const tempPath = join(dir, `.config.json.${process.pid}.${randomUUID()}.tmp`);
  const lockNonce = randomUUID();
  let lockFd: number | undefined;
  let lockInode: { dev: number; ino: number } | undefined;
  let lockMetadataWritten = false;
  let tempFd: number | undefined;
  let configDir: OpenedConfigDir | undefined;
  try {
    configDir = ensurePrivateConfigDir(cwd);
    requirePathStillNamesOpenedObject(dir, configDir.stat, "config directory");
    const pathDiagnostic = configPathDiagnostic(cwd);
    if (pathDiagnostic) throw new LocalConfigSecurityError(pathDiagnostic);
    requirePathStillNamesOpenedObject(dir, configDir.stat, "config directory");
    try {
      lockFd = openSync(lockPath, noFollowFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL), 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        // Diagnose static symlink/non-file/unsafe lock entries without ever
        // auto-unlinking them. A valid existing entry is simply held/stale.
        const existing = readOpenedWriterLock(lockPath);
        validateWriterLockProtection(existing.stat);
        throw new LocalConfigLockError();
      }
      throw error;
    }
    const acquiredLockStat = fstatSync(lockFd);
    lockInode = { dev: acquiredLockStat.dev, ino: acquiredLockStat.ino };
    const lockMetadata: WriterLockMetadata = {
      pid: process.pid,
      processStartedAt: Date.now() - Math.round(process.uptime() * 1000),
      acquiredAt: Date.now(),
      nonce: lockNonce,
    };
    writeFileSync(lockFd, JSON.stringify(lockMetadata), "utf8");
    fsyncSync(lockFd);
    lockMetadataWritten = true;

    // Reload only after the exclusive writer lock is held. This turns the
    // revision/hash/state check into a real compare-and-swap rather than a
    // stale preflight over bytes the operator did not review.
    const inspected = inspectLocalConfig(cwd);
    if (inspected.state === "repair_required" && !options.repair) {
      throw new LocalConfigRepairRequiredError(inspected.diagnostic);
    }
    const actualRevision = inspected.revision;
    if (options.expectedRevision !== undefined && options.expectedRevision !== actualRevision) {
      throw new LocalConfigConflictError(options.expectedRevision, actualRevision);
    }
    if (options.expectedState !== undefined && options.expectedState !== inspected.state) {
      throw new LocalConfigConflictError(options.expectedRevision ?? initial.revision, actualRevision, `expected state ${options.expectedState}, found ${inspected.state}`);
    }
    const actualHash = "hash" in inspected ? inspected.hash ?? null : null;
    if (options.expectedHash !== undefined && options.expectedHash !== actualHash) {
      throw new LocalConfigConflictError(options.expectedRevision ?? initial.revision, actualRevision, "config bytes changed since inspection");
    }
    if (requestedWorkspaceId && inspected.state === "loaded" && inspected.workspaceId.toLowerCase() !== requestedWorkspaceId) {
      throw new LocalConfigConflictError(options.expectedRevision ?? initial.revision, actualRevision, "protected workspace identity does not match requested supervisor identity");
    }
    // Permission repair is a mutation and therefore belongs inside the same
    // cooperative writer critical section, after the reviewed CAS succeeds.
    fchmodSync(configDir.fd, 0o700);
    configDir.stat = fstatSync(configDir.fd);
    requirePathStillNamesOpenedObject(dir, configDir.stat, "config directory");
    const next: StoredLocalConfig = {
      schema_version: 1,
      revision: actualRevision + 1,
      workspace_id: inspected.state === "loaded"
        ? inspected.workspaceId
        : inspected.state === "repair_required" && inspected.workspaceId
          ? inspected.workspaceId
          : requestedWorkspaceId ?? randomUUID(),
      // Durable writes merge only the validated on-disk projection. The inline
      // direct config is an ephemeral runtime override and never a write base.
      ...inspected.config,
      ...patch,
    };
    if (typeof next.auto_start_relay !== "boolean") next.auto_start_relay = true;

    requirePathStillNamesOpenedObject(dir, configDir.stat, "config directory");
    tempFd = openSync(tempPath, noFollowFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL), 0o600);
    writeFileSync(tempFd, JSON.stringify(next, null, 2), "utf8");
    fsyncSync(tempFd);
    closeSync(tempFd);
    tempFd = undefined;
    // The exclusive temp file was created 0600; rename preserves that mode.
    // Do not chmod the destination pathname after rename, because a same-user
    // replacement could redirect a pathname chmod to an unrelated file.
    requirePathStillNamesOpenedObject(dir, configDir.stat, "config directory");
    renameSync(tempPath, p);
    requirePathStillNamesOpenedObject(dir, configDir.stat, "config directory");
    fsyncSync(configDir.fd);
    return {
      config: parseLocalConfig(JSON.stringify(next)) ?? {},
      schemaVersion: 1,
      revision: next.revision,
      workspaceId: next.workspace_id,
    };
  } catch (error) {
    if (error instanceof LocalConfigLockError
      || error instanceof LocalConfigConflictError
      || error instanceof LocalConfigRepairRequiredError
      || error instanceof LocalConfigSecurityError
      || error instanceof LocalConfigWriteError) throw error;
    throw new LocalConfigWriteError(p, error);
  } finally {
    if (tempFd !== undefined) {
      try { closeSync(tempFd); } catch { /* best effort */ }
    }
    if (lockFd !== undefined) {
      try { closeSync(lockFd); } catch { /* best effort */ }
    }
    const directoryStillOwned = configDir !== undefined && pathStillNamesOpenedObject(dir, configDir.stat);
    if (directoryStillOwned) {
      try { rmSync(tempPath, { force: true }); } catch { /* best effort */ }
      // If metadata was never durably written, leave the unknown lock behind
      // and fail closed rather than deleting a pathname we cannot prove we own.
      if (lockFd !== undefined && lockInode && lockMetadataWritten) removeOwnedWriterLock(lockPath, lockNonce, lockInode);
    }
    if (configDir !== undefined) {
      try { closeSync(configDir.fd); } catch { /* best effort */ }
    }
  }
}

/** Default presentation leaf. It never defines current runtime identity. */
export function defaultAgentName(cwd: string): string {
  return basename(cwd) || "agent";
}

/** Resolves auto_start_relay with backward-compat (undefined → true). */
export function effectiveAutoStartRelay(cfg: LocalConfig): boolean {
  return cfg.auto_start_relay !== false;
}
