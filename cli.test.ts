import { afterEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { spawn as childSpawn } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INDEX_VERSION } from "./env";
import { syncSessions } from "./indexer";

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

describe("cxs cli", () => {
  test("help only shows current/sync/find/read-range/read-page/list/stats", async () => {
    const result = await runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("current");
    expect(result.stdout).toContain("sync");
    expect(result.stdout).toContain("find");
    expect(result.stdout).toContain("read-range");
    expect(result.stdout).toContain("read-page");
    expect(result.stdout).toContain("list");
    expect(result.stdout).toContain("stats");
    expect(result.stdout).not.toContain("window");
    expect(result.stdout).not.toContain("\n  session ");
  });

  test("current returns candidate sessions for cwd from state db", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-cli-current-"));
    tempDirs.push(base);
    const stateDbPath = join(base, "state.sqlite");
    const db = new Database(stateDbPath);
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        updated_at_ms INTEGER
      )
    `);
    const insertThread = db.prepare(
      "INSERT INTO threads (id, rollout_path, cwd, title, updated_at_ms) VALUES (?, ?, ?, ?, ?)",
    );
    insertThread.run("aaaa1111-1111-4111-8111-111111111111", "/tmp/one.jsonl", "/tmp/picc", "older", 100);
    insertThread.run("bbbb2222-2222-4222-8222-222222222222", "/tmp/two.jsonl", "/tmp/picc", "newer", 200);
    db.close();

    const result = await runCli([
      "current",
      "--cwd",
      "/tmp/picc",
      "--state-db",
      stateDbPath,
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      cwd: string;
      candidates: Array<{ sessionUuid: string; filePath: string }>;
    };
    expect(payload.cwd).toBe("/tmp/picc");
    expect(payload.candidates.map((candidate) => candidate.sessionUuid)).toEqual([
      "bbbb2222-2222-4222-8222-222222222222",
      "aaaa1111-1111-4111-8111-111111111111",
    ]);
    expect(payload.candidates[0]?.filePath).toBe("/tmp/two.jsonl");
  });

  test("current --json emits structured error when state db file is missing", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-cli-current-missing-"));
    tempDirs.push(base);
    const stateDbPath = join(base, "does-not-exist.sqlite");

    const result = await runCli(["current", "--state-db", stateDbPath, "--json"]);
    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout) as {
      error: { code: string; message: string };
    };
    expect(payload.error.code).toBe("state_db_unavailable");
    expect(payload.error.message).toContain(stateDbPath);
  });

  test("current --json emits structured error when state db schema is unexpected", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-cli-current-schema-"));
    tempDirs.push(base);
    const stateDbPath = join(base, "state.sqlite");
    const db = new Database(stateDbPath);
    db.exec("CREATE TABLE other (id INTEGER PRIMARY KEY)");
    db.close();

    const result = await runCli(["current", "--state-db", stateDbPath, "--json"]);
    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout) as {
      error: { code: string; message: string };
    };
    expect(payload.error.code).toBe("state_db_unavailable");
    expect(payload.error.message).toContain("threads");
  });

  test("current --json emits structured error when 'threads' is missing required columns", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-cli-current-cols-"));
    tempDirs.push(base);
    const stateDbPath = join(base, "state.sqlite");
    const db = new Database(stateDbPath);
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL
      )
    `);
    db.close();

    const result = await runCli(["current", "--state-db", stateDbPath, "--json"]);
    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout) as {
      error: { code: string; message: string };
    };
    expect(payload.error.code).toBe("state_db_unavailable");
    expect(payload.error.message).toContain("rollout_path");
    // Crucially, raw SQLite errors should never reach stdout — exit 1 with a
    // structured payload is the contract.
    expect(result.stdout).not.toContain("SQLiteError");
  });

  test("find text output points to read-range", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-cli-"));
    tempDirs.push(base);
    const sessionsRoot = join(base, "sessions", "2026", "04", "21");
    mkdirSync(sessionsRoot, { recursive: true });

    writeFileSync(
      join(sessionsRoot, "rollout-2026-04-21T10-00-00-44444444-4444-4444-8444-444444444444.jsonl"),
      [
        line("session_meta", { id: "44444444-4444-4444-8444-444444444444", cwd: "/tmp/project-d" }),
        line("turn_context", { model: "gpt-5.4" }),
        line("event_msg", { type: "user_message", message: "health check 一直失败" }),
        line("event_msg", { type: "agent_message", message: "先看 readback" }),
      ].join("\n"),
    );

    const dbPath = join(base, "index.sqlite");
    await syncSessions({ dbPath, rootDir: join(base, "sessions") });

    const result = await runCli(["find", "health check", "--db", dbPath]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("next: cxs read-range 44444444-4444-4444-8444-444444444444 --seq 0");
    expect(result.stdout).not.toContain("next: cxs window");
  });

  test("list filters by cwd substring and respects sort", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-cli-list-"));
    tempDirs.push(base);
    const sessionsRoot = join(base, "sessions", "2026", "04", "21");
    mkdirSync(sessionsRoot, { recursive: true });

    writeFileSync(
      join(sessionsRoot, "rollout-2026-04-21T10-00-00-55555555-5555-4555-8555-555555555555.jsonl"),
      [
        line("session_meta", { id: "55555555-5555-4555-8555-555555555555", cwd: "/tmp/alpha-proj" }),
        line("turn_context", { model: "gpt-5.4" }),
        line("event_msg", { type: "user_message", message: "alpha one" }),
      ].join("\n"),
    );

    writeFileSync(
      join(sessionsRoot, "rollout-2026-04-21T11-00-00-66666666-6666-4666-8666-666666666666.jsonl"),
      [
        line("session_meta", { id: "66666666-6666-4666-8666-666666666666", cwd: "/tmp/beta-proj" }),
        line("turn_context", { model: "gpt-5.4" }),
        line("event_msg", { type: "user_message", message: "beta one" }),
      ].join("\n"),
    );

    const dbPath = join(base, "index.sqlite");
    await syncSessions({ dbPath, rootDir: join(base, "sessions") });

    const listed = await runCli(["list", "--cwd", "alpha", "--json", "--db", dbPath]);
    expect(listed.exitCode).toBe(0);
    const payload = JSON.parse(listed.stdout) as { results: Array<{ sessionUuid: string }> };
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0]?.sessionUuid).toBe("55555555-5555-4555-8555-555555555555");
  });

  test("stats reports counts and index_version", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-cli-stats-"));
    tempDirs.push(base);
    const sessionsRoot = join(base, "sessions", "2026", "04", "21");
    mkdirSync(sessionsRoot, { recursive: true });

    writeFileSync(
      join(sessionsRoot, "rollout-2026-04-21T10-00-00-77777777-7777-4777-8777-777777777777.jsonl"),
      [
        line("session_meta", { id: "77777777-7777-4777-8777-777777777777", cwd: "/tmp/gamma" }),
        line("turn_context", { model: "gpt-5.4" }),
        line("event_msg", { type: "user_message", message: "gamma one" }),
        line("event_msg", { type: "agent_message", message: "gamma reply" }),
      ].join("\n"),
    );

    const dbPath = join(base, "index.sqlite");
    await syncSessions({ dbPath, rootDir: join(base, "sessions") });

    const stats = await runCli(["stats", "--json", "--db", dbPath]);
    expect(stats.exitCode).toBe(0);
    const payload = JSON.parse(stats.stdout) as {
      sessionCount: number;
      messageCount: number;
      indexVersion: string;
      topCwds: Array<{ cwd: string; count: number }>;
    };
    expect(payload.sessionCount).toBe(1);
    expect(payload.messageCount).toBe(2);
    expect(payload.indexVersion).toBe(INDEX_VERSION);
    expect(payload.topCwds[0]?.cwd).toBe("/tmp/gamma");
  });

  test("read-page JSON exposes totalCount and hasMore", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-cli-page-"));
    tempDirs.push(base);
    const sessionsRoot = join(base, "sessions", "2026", "04", "21");
    mkdirSync(sessionsRoot, { recursive: true });

    writeFileSync(
      join(sessionsRoot, "rollout-2026-04-21T10-00-00-88888888-8888-4888-8888-888888888888.jsonl"),
      [
        line("session_meta", { id: "88888888-8888-4888-8888-888888888888", cwd: "/tmp/pagecheck" }),
        line("turn_context", { model: "gpt-5.4" }),
        line("event_msg", { type: "user_message", message: "m1" }),
        line("event_msg", { type: "agent_message", message: "m2" }),
        line("event_msg", { type: "user_message", message: "m3" }),
        line("event_msg", { type: "agent_message", message: "m4" }),
      ].join("\n"),
    );

    const dbPath = join(base, "index.sqlite");
    await syncSessions({ dbPath, rootDir: join(base, "sessions") });

    const page1 = await runCli([
      "read-page",
      "88888888-8888-4888-8888-888888888888",
      "--offset",
      "0",
      "--limit",
      "2",
      "--json",
      "--db",
      dbPath,
    ]);
    expect(page1.exitCode).toBe(0);
    const payload1 = JSON.parse(page1.stdout) as { totalCount: number; hasMore: boolean };
    expect(payload1.totalCount).toBe(4);
    expect(payload1.hasMore).toBe(true);

    const page2 = await runCli([
      "read-page",
      "88888888-8888-4888-8888-888888888888",
      "--offset",
      "2",
      "--limit",
      "2",
      "--json",
      "--db",
      dbPath,
    ]);
    expect(page2.exitCode).toBe(0);
    const payload2 = JSON.parse(page2.stdout) as { totalCount: number; hasMore: boolean };
    expect(payload2.totalCount).toBe(4);
    expect(payload2.hasMore).toBe(false);
  });

  test("sync exits non-zero by default when per-file indexing fails", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-cli-sync-"));
    tempDirs.push(base);
    const sessionsRoot = join(base, "sessions", "2026", "04", "22");
    mkdirSync(sessionsRoot, { recursive: true });

    writeFileSync(
      join(sessionsRoot, "rollout-2026-04-22T12-00-00-99990000-9999-4999-8999-999999999999.jsonl"),
      [
        line("session_meta", { id: "99990000-9999-4999-8999-999999999999", cwd: "/tmp/good" }),
        line("turn_context", { model: "gpt-5.4" }),
        line("event_msg", { type: "user_message", message: "good session" }),
      ].join("\n"),
    );

    const badFilePath = join(
      sessionsRoot,
      "rollout-2026-04-22T13-00-00-88880000-8888-4888-8888-888888888888.jsonl",
    );
    writeFileSync(
      badFilePath,
      [
        line("session_meta", { id: "88880000-8888-4888-8888-888888888888", cwd: "/tmp/bad" }),
        line("turn_context", { model: "gpt-5.4" }),
        line("event_msg", { type: "user_message", message: "bad session" }),
      ].join("\n"),
    );
    chmodSync(badFilePath, 0o000);
    unreadableFiles.push(badFilePath);

    const result = await runCli([
      "sync",
      "--root",
      join(base, "sessions"),
      "--db",
      join(base, "index.sqlite"),
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("errors:   1");
    expect(result.stdout).toContain(badFilePath);
  });
});

function line(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: new Date("2026-04-21T00:00:00.000Z").toISOString(),
    type,
    payload,
  });
}

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // Spawn cli.ts via tsx so the test works under both Bun (via bunx) and
  // Node (via npx tsx) without requiring a build step. process.execPath
  // resolves to the runtime that's running vitest.
  return runExecutable(process.execPath, ["--import", "tsx", "cli.ts", ...args], import.meta.dirname);
}

async function runExecutable(
  executable: string,
  args: string[],
  cwd = import.meta.dirname,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = childSpawn(executable, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout!.setEncoding("utf8");
    proc.stderr!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => { stdout += chunk; });
    proc.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    proc.on("error", reject);
    proc.on("close", (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
}
