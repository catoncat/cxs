import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryRemoveStaleLock } from "./sync-lock";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("tryRemoveStaleLock", () => {
  test("removes the lock when it still matches the expected pid+createdAt", () => {
    const lockPath = makeLockPath();
    const expected = { pid: 4242, createdAt: "2026-04-27T00:00:00.000Z" };
    writeFileSync(lockPath, JSON.stringify(expected));

    const removed = tryRemoveStaleLock(lockPath, expected);

    expect(removed).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("returns true when the lock file is already gone", () => {
    const lockPath = makeLockPath();
    const expected = { pid: 4242, createdAt: "2026-04-27T00:00:00.000Z" };
    // Lock never existed (cleaned up by another process between our reads).

    const removed = tryRemoveStaleLock(lockPath, expected);

    expect(removed).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("leaves a freshly written lock alone when pid changed", () => {
    const lockPath = makeLockPath();
    const expected = { pid: 4242, createdAt: "2026-04-27T00:00:00.000Z" };
    const fresh = { pid: 9999, createdAt: "2026-04-27T01:00:00.000Z" };
    writeFileSync(lockPath, JSON.stringify(fresh));

    const removed = tryRemoveStaleLock(lockPath, expected);

    expect(removed).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(lockPath, "utf8")) as typeof fresh;
    expect(onDisk).toEqual(fresh);
  });

  test("leaves a lock alone when only createdAt differs (same-pid retry)", () => {
    const lockPath = makeLockPath();
    const expected = { pid: 4242, createdAt: "2026-04-27T00:00:00.000Z" };
    const refreshed = { pid: 4242, createdAt: "2026-04-27T00:00:05.000Z" };
    writeFileSync(lockPath, JSON.stringify(refreshed));

    const removed = tryRemoveStaleLock(lockPath, expected);

    expect(removed).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
  });
});

function makeLockPath(): string {
  const base = mkdtempSync(join(tmpdir(), "cxs-lock-"));
  tempDirs.push(base);
  return join(base, "index.sqlite.sync.lock");
}
