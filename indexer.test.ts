import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { SyncError, syncSessions } from "./indexer";

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

    const db = openDb(dbPath);
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

    const db = openDb(dbPath);
    const row = db.query("SELECT COUNT(*) AS count FROM sessions").get() as { count: number };
    db.close();
    expect(row.count).toBe(1);
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
