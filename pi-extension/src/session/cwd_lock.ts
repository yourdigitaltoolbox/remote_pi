import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Server } from "node:net";
import { roomIdFor, roomIdForIdentity } from "../rooms.js";
import { removeStaleSock, tryBind, tryConnect } from "./leader_election.js";
import { ipcAddress, usesNamedPipe } from "./ipc.js";

/**
 * Local singleton locks for remote-pi. Current runtimes lock immutable
 * workspaceId+agentId; legacy callers retain cwd/name-derived lock helpers.
 *
 * Why a UDS bind instead of a PID lock file:
 *   - The OS releases the socket handle the instant the process dies, even
 *     on `kill -9` or hard crash. No stale-lock cleanup needed.
 *   - The next Pi to try in the same cwd detects the dead socket via
 *     `ECONNREFUSED` on `tryConnect`, unlinks the leftover file, and
 *     binds successfully. Fully self-healing.
 *   - Kernel-enforced — there is no race window between "check if held"
 *     and "claim", which an explicit PID file would have.
 *
 * Lock sockets live in `<root>/.pi/remote/locks/<lockId>.sock`, outside the
 * cwd, where `<root>` is `$REMOTE_PI_HOME` or the home directory, to dodge:
 *   - The 104/108-char path-length limit on UDS sockets on macOS/Linux.
 *   - Symlinked cwds (realpath canonicalization happens in `roomIdFor`).
 *   - Read-only cwds (the home directory is always writable).
 *
 * Current callers use `acquireIdentityLock`; `acquireCwdLock` remains only for
 * peers that do not yet carry immutable runtime identity.
 */

/** Resolved at call time (not module load) so tests can redirect the lock
 *  dir away from the developer's real `~/.pi/remote/locks` via
 *  `REMOTE_PI_HOME` — same override the daemon registry honors. */
function locksDir(): string {
  const root = process.env["REMOTE_PI_HOME"] || homedir();
  return join(root, ".pi", "remote", "locks");
}

export interface AcquiredLock {
  ok: true;
  /** Manual release. Optional — process exit cleans up too. */
  release(): void;
}

export interface RefusedLock {
  ok: false;
  /** Where the live lock socket lives, in case the caller wants to log it. */
  lockPath: string;
}

export type CwdLockResult = AcquiredLock | RefusedLock;

/** Legacy cwd/name lock derivation for peers without runtime identity. */
function lockIdFor(cwd: string, name?: string): string {
  return roomIdFor(cwd, name);
}

/** Legacy cwd/name lock address. Current callers use lockPathForIdentity. */
function lockPathForId(id: string): string {
  return ipcAddress(`lock-${id}`, join(locksDir(), `${id}.sock`));
}

export function lockPathFor(cwd: string, name?: string): string {
  return lockPathForId(lockIdFor(cwd, name));
}

/** Canonical lock path for the immutable workspace/logical-agent identity. */
export function lockPathForIdentity(identity: { workspaceId: string; agentId: string }): string {
  return lockPathForId(roomIdForIdentity(identity));
}

/** Back-compat alias: the cwd-only lock path (no name component). */
export function lockPathForCwd(cwd: string): string {
  return lockPathFor(cwd);
}

/**
 * Attempts to acquire a legacy cwd/name lock. Resolves with either:
 *   - `{ ok: true, release }` when we own it (server bound + retained).
 *   - `{ ok: false, lockPath }` when a live Pi already holds the lock.
 *
 * Self-healing path: if the prior holder crashed, the leftover socket file
 * fails `tryConnect` (ECONNREFUSED). We unlink it and retry the bind — the
 * second attempt then succeeds.
 *
 * The server holds no actual listener logic; its only job is to keep the
 * UDS endpoint pinned by the OS. No incoming connection ever does anything
 * useful — the next-Pi-attempt's `tryConnect` succeeding is the entire
 * signal we care about.
 */
export async function acquireCwdLock(cwd: string, name?: string): Promise<CwdLockResult> {
  return acquireLockPath(lockPathFor(cwd, name));
}

/** Acquire the singleton lock for one immutable workspace/logical-agent ID. */
export async function acquireIdentityLock(identity: { workspaceId: string; agentId: string }): Promise<CwdLockResult> {
  return acquireLockPath(lockPathForIdentity(identity));
}

async function acquireLockPath(lockPath: string): Promise<CwdLockResult> {
  // POSIX: the lock socket is a file under locksDir → ensure the dir exists.
  // Windows: lockPath is a named pipe (`\\.\pipe\…`) — no parent dir to create.
  if (!usesNamedPipe()) mkdirSync(dirname(lockPath), { recursive: true });

  // First attempt: bind directly.
  let server: Server | null = await tryBind(lockPath);
  if (server) return _acquired(server, lockPath);

  // Bind failed — check whether the existing socket has a live listener.
  const probe = await tryConnect(lockPath);
  if (probe) {
    probe.destroy();
    return { ok: false, lockPath };
  }

  // POSIX: a leftover stale `.sock` file blocks the bind → clean it + retry.
  // Windows: a named pipe auto-disappears when its owner exits, so there is
  // never a stale pipe to remove.
  if (!usesNamedPipe()) removeStaleSock(lockPath);
  server = await tryBind(lockPath);
  if (server) return _acquired(server, lockPath);

  // Race: someone else bound between our unlink and retry. Treat as held.
  return { ok: false, lockPath };
}

function _acquired(server: Server, _lockPath: string): AcquiredLock {
  let released = false;
  // Don't keep the event loop alive just to hold the socket — the Pi
  // process has its own reasons to stay up (relay WS, broker, etc.).
  // When those are gone, the OS will tear the socket down with us.
  server.unref();
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      try { server.close(); } catch { /* ignored */ }
    },
  };
}
