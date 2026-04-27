import { readFileSync, rmSync, writeFileSync } from "node:fs";

const LOCK_SUFFIX = ".sync.lock";
const LOCK_WAIT_TIMEOUT_MS = 10_000;
const LOCK_POLL_INTERVAL_MS = 100;

interface SyncLockInfo {
  pid: number;
  createdAt: string;
}

export class SyncLockTimeoutError extends Error {
  constructor(lockPath: string, info: SyncLockInfo | null) {
    const owner = info ? `pid ${info.pid} since ${info.createdAt}` : "unknown owner";
    super(`sync already running: ${owner} (${lockPath})`);
    this.name = "SyncLockTimeoutError";
  }
}

export function syncLockPath(dbPath: string): string {
  return `${dbPath}${LOCK_SUFFIX}`;
}

export async function withSyncLock<T>(dbPath: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireSyncLock(syncLockPath(dbPath));
  try {
    return await fn();
  } finally {
    release();
  }
}

async function acquireSyncLock(lockPath: string): Promise<() => void> {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  const lockInfo: SyncLockInfo = {
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };

  while (true) {
    try {
      writeFileSync(lockPath, JSON.stringify(lockInfo), { flag: "wx" });
      return () => releaseSyncLock(lockPath, lockInfo);
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
    }

    const existing = readLockInfo(lockPath);
    if (existing && !isProcessAlive(existing.pid)) {
      // If tryRemoveStaleLock returns false, another process took over the
      // lock between our read and our cleanup attempt — fall through to the
      // poll/timeout branch instead of clobbering its lock file.
      if (tryRemoveStaleLock(lockPath, existing)) continue;
    }

    if (Date.now() >= deadline) {
      throw new SyncLockTimeoutError(lockPath, existing);
    }

    await sleep(LOCK_POLL_INTERVAL_MS);
  }
}

function releaseSyncLock(lockPath: string, lockInfo: SyncLockInfo): void {
  const existing = readLockInfo(lockPath);
  if (!existing) return;
  if (existing.pid !== lockInfo.pid || existing.createdAt !== lockInfo.createdAt) return;
  removeLockIfPresent(lockPath);
}

// Why: avoid TOCTOU when clearing a stale lock. Between our `existing` read
// and the actual `rmSync` call, another sync process can re-create the lock.
// Re-read and compare pid+createdAt: only delete the lock file if it's still
// the same one we judged dead. Exported for unit tests.
export function tryRemoveStaleLock(lockPath: string, expected: SyncLockInfo): boolean {
  const reChecked = readLockInfo(lockPath);
  if (!reChecked) return true;
  if (reChecked.pid !== expected.pid || reChecked.createdAt !== expected.createdAt) {
    return false;
  }
  removeLockIfPresent(lockPath);
  return true;
}

function readLockInfo(lockPath: string): SyncLockInfo | null {
  try {
    const raw = readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<SyncLockInfo>;
    if (typeof parsed.pid !== "number" || typeof parsed.createdAt !== "string") return null;
    return { pid: parsed.pid, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removeLockIfPresent(lockPath: string): void {
  try {
    rmSync(lockPath);
  } catch {
    // Ignore already-removed locks and let callers retry.
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
