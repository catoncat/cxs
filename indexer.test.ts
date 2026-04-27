import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { openReadDb } from "./db";
import { SyncError, syncSessions } from "./indexer";
import { syncLockPath } from "./sync-lock";

const tempDirs: string[] = [];
const unreadableFiles: string[] = [];

afterEach(() => {
  for (const filePath of unreadableFiles.splice(0)) {
    try {
      chmodSync(filePath, 0o644);
    } catch {
      // ignore cleanup failures for files that already disappeared
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("syncSessions", () => {
  test("fails loudly with per-file diagnostics and leaves no partial index by default", async () => {
    const { base, dbPath, sessionsRoot, badFilePath } = createFixture();

    const failure = await syncSessions({ dbPath, rootDir: sessionsRoot }).catch((error) => error);
    expect(failure).toBeInstanceOf(SyncError);
    expect(failure.summary.errors).toBe(1);
    expect(failure.summary.errorDetails).toHaveLength(1);
    expect(failure.summary.errorDetails[0]?.filePath).toBe(badFilePath);
    expect(failure.summary.errorDetails[0]?.message.length).toBeGreaterThan(0);

    const db = openReadDb(dbPath);
    const row = db.query("SELECT COUNT(*) AS count FROM sessions").get() as { count: number };
    db.close();
    expect(row.count).toBe(0);

    chmodSync(badFilePath, 0o644);
    unreadableFiles.splice(unreadableFiles.indexOf(badFilePath), 1);
    rmSync(base, { recursive: true, force: true });
  });

  test("can opt into best-effort sync and still returns failure diagnostics", async () => {
    const { dbPath, sessionsRoot, badFilePath } = createFixture();

    const summary = await syncSessions({ dbPath, rootDir: sessionsRoot, bestEffort: true });
    expect(summary.added).toBe(1);
    expect(summary.errors).toBe(1);
    expect(summary.errorDetails).toHaveLength(1);
    expect(summary.errorDetails[0]?.filePath).toBe(badFilePath);

    const db = openReadDb(dbPath);
    const row = db.query("SELECT COUNT(*) AS count FROM sessions").get() as { count: number };
    db.close();
    expect(row.count).toBe(1);
  });

  test("waits for an existing sync writer lock before opening the database", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-indexer-lock-"));
    tempDirs.push(base);
    const sessionsRoot = join(base, "sessions", "2026", "04", "22");
    mkdirSync(sessionsRoot, { recursive: true });

    writeFileSync(
      join(sessionsRoot, "rollout-2026-04-22T12-00-00-dddddddd-dddd-4ddd-8ddd-dddddddddddd.jsonl"),
      [
        line("session_meta", { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", cwd: "/tmp/locked" }),
        line("turn_context", { model: "gpt-5.4" }),
        line("event_msg", { type: "user_message", message: "writer lock test" }),
      ].join("\n"),
    );

    const dbPath = join(base, "index.sqlite");
    const blocker = await holdSyncLock(syncLockPath(dbPath), 350);
    const startedAt = Date.now();
    const summary = await syncSessions({ dbPath, rootDir: join(base, "sessions") });
    const elapsedMs = Date.now() - startedAt;
    await blocker.done;

    expect(summary.added).toBe(1);
    expect(elapsedMs).toBeGreaterThanOrEqual(250);
  });

  test("removes stale sync writer locks from dead pids before proceeding", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-indexer-stale-lock-"));
    tempDirs.push(base);
    const sessionsRoot = join(base, "sessions", "2026", "04", "22");
    mkdirSync(sessionsRoot, { recursive: true });

    writeFileSync(
      join(sessionsRoot, "rollout-2026-04-22T14-00-00-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.jsonl"),
      [
        line("session_meta", { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", cwd: "/tmp/stale-lock" }),
        line("turn_context", { model: "gpt-5.4" }),
        line("event_msg", { type: "user_message", message: "stale writer lock test" }),
      ].join("\n"),
    );

    const dbPath = join(base, "index.sqlite");
    const lockPath = syncLockPath(dbPath);
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999_999, createdAt: new Date("2026-04-22T00:00:00.000Z").toISOString() }),
    );

    const summary = await syncSessions({ dbPath, rootDir: join(base, "sessions") });

    expect(summary.added).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
  });
});

function createFixture(): {
  base: string;
  dbPath: string;
  sessionsRoot: string;
  badFilePath: string;
} {
  const base = mkdtempSync(join(tmpdir(), "cxs-indexer-"));
  tempDirs.push(base);
  const sessionsRoot = join(base, "sessions", "2026", "04", "22");
  mkdirSync(sessionsRoot, { recursive: true });

  writeFileSync(
    join(sessionsRoot, "rollout-2026-04-22T12-00-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl"),
    [
      line("session_meta", { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", cwd: "/tmp/good" }),
      line("turn_context", { model: "gpt-5.4" }),
      line("event_msg", { type: "user_message", message: "good session" }),
    ].join("\n"),
  );

  const badFilePath = join(
    sessionsRoot,
    "rollout-2026-04-22T13-00-00-cccccccc-cccc-4ccc-8ccc-cccccccccccc.jsonl",
  );
  writeFileSync(
    badFilePath,
    [
      line("session_meta", { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", cwd: "/tmp/bad" }),
      line("turn_context", { model: "gpt-5.4" }),
      line("event_msg", { type: "user_message", message: "unreadable session" }),
    ].join("\n"),
  );
  chmodSync(badFilePath, 0o000);
  unreadableFiles.push(badFilePath);

  return {
    base,
    dbPath: join(base, "index.sqlite"),
    sessionsRoot: join(base, "sessions"),
    badFilePath,
  };
}

function line(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: new Date("2026-04-22T00:00:00.000Z").toISOString(),
    type,
    payload,
  });
}

function holdSyncLock(
  lockPath: string,
  holdMs: number,
): Promise<{ done: Promise<number | null> }> {
  return new Promise((resolve, reject) => {
    const script = `
      import { writeFileSync, unlinkSync } from "node:fs";
      const [lockPath, holdMs] = process.argv.slice(1);
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
        { flag: "wx" },
      );
      console.log("locked");
      setTimeout(() => {
        unlinkSync(lockPath);
      }, Number(holdMs));
    `;
    const child = spawn(
      process.execPath,
      ["--eval", script, lockPath, String(holdMs)],
      { cwd: import.meta.dir, stdio: ["ignore", "pipe", "pipe"] },
    );

    let settled = false;
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (!settled && code !== 0) {
        settled = true;
        reject(new Error(stderr || `lock holder exited with code ${code}`));
      }
    });
    child.stdout.on("data", (chunk) => {
      if (settled || !chunk.includes("locked")) return;
      settled = true;
      resolve({
        done: new Promise((doneResolve, doneReject) => {
          child.on("error", doneReject);
          child.on("close", (code) => {
            if (code === 0) {
              doneResolve(code);
              return;
            }
            doneReject(new Error(stderr || `lock holder exited with code ${code}`));
          });
        }),
      });
    });
  });
}
