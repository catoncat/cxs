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
  test("help only shows status/sync/find/read-range/read-page/list/stats", async () => {
    const result = await runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("status");
    expect(result.stdout).toContain("sync");
    expect(result.stdout).toContain("find");
    expect(result.stdout).toContain("read-range");
    expect(result.stdout).toContain("read-page");
    expect(result.stdout).toContain("list");
    expect(result.stdout).toContain("stats");
    expect(result.stdout).not.toContain("current");
    expect(result.stdout).not.toContain("window");
    expect(result.stdout).not.toContain("\n  session ");
  });

  test("status returns source inventory without an index", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-cli-status-"));
    tempDirs.push(base);
    const sessionsRoot = join(base, "sessions", "2026", "04", "20");
    mkdirSync(sessionsRoot, { recursive: true });
    writeFileSync(
      join(sessionsRoot, "rollout-2026-04-20T10-00-00-11111111-1111-4111-8111-111111111111.jsonl"),
      [
        line("session_meta", { id: "11111111-1111-4111-8111-111111111111", cwd: "/tmp/alpha" }),
        line("event_msg", { type: "user_message", message: "alpha private content must not be needed" }),
      ].join("\n"),
    );

    const result = await runCli([
      "status",
      "--root",
      join(base, "sessions"),
      "--db",
      join(base, "missing.sqlite"),
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      sourceInventory: {
        totalFiles: number;
        pathDateRange: { from: string | null; to: string | null };
        cwdGroups: Array<{ cwd: string; fileCount: number; pathDateRange: { from: string | null; to: string | null } }>;
      };
      index: { exists: boolean };
    };
    expect(payload.index.exists).toBe(false);
    expect(payload.sourceInventory.totalFiles).toBe(1);
    expect(payload.sourceInventory.pathDateRange).toEqual({ from: "2026-04-20", to: "2026-04-20" });
    expect(payload.sourceInventory.cwdGroups).toEqual([
      { cwd: "/tmp/alpha", fileCount: 1, pathDateRange: { from: "2026-04-20", to: "2026-04-20" } },
    ]);
  });

  test("status --selector reports requested coverage without writing index", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-cli-status-selector-"));
    tempDirs.push(base);
    const root = join(base, "sessions");
    const sessionsRoot = join(root, "2026", "04", "20");
    mkdirSync(sessionsRoot, { recursive: true });
    writeFileSync(
      join(sessionsRoot, "rollout-2026-04-20T10-00-00-10101010-1010-4010-8010-101010101010.jsonl"),
      [
        line("session_meta", { id: "10101010-1010-4010-8010-101010101010", cwd: "/tmp/selector-alpha" }),
        line("event_msg", { type: "user_message", message: "selector alpha" }),
      ].join("\n"),
    );

    const selector = JSON.stringify({ kind: "cwd", root, cwd: "/tmp/selector-alpha" });
    const result = await runCli(["status", "--root", root, "--selector", selector, "--db", join(base, "missing.sqlite"), "--json"]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      index: { exists: boolean };
      requestedCoverage: { complete: boolean; freshness: string; recommendedAction: string; sourceFileCount: number };
    };
    expect(payload.index.exists).toBe(false);
    expect(payload.requestedCoverage.complete).toBe(false);
    expect(payload.requestedCoverage.freshness).toBe("missing");
    expect(payload.requestedCoverage.recommendedAction).toBe("sync");
    expect(payload.requestedCoverage.sourceFileCount).toBe(1);
  });

  test("sync requires an explicit selector", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-cli-sync-selector-required-"));
    tempDirs.push(base);

    const result = await runCli(["sync", "--db", join(base, "index.sqlite"), "--json"]);
    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout) as {
      error: { code: string; message: string };
    };
    expect(payload.error.code).toBe("selector_required");
    expect(payload.error.message).toContain("--selector");
  });

  test("sync with cwd selector writes coverage and find stays scoped", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-cli-selector-"));
    tempDirs.push(base);
    const root = join(base, "sessions");
    const day = join(root, "2026", "04", "21");
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(day, "rollout-2026-04-21T10-00-00-22222222-2222-4222-8222-222222222222.jsonl"),
      [
        line("session_meta", { id: "22222222-2222-4222-8222-222222222222", cwd: "/tmp/alpha" }),
        line("event_msg", { type: "user_message", message: "shared needle alpha" }),
      ].join("\n"),
    );
    writeFileSync(
      join(day, "rollout-2026-04-21T11-00-00-33333333-3333-4333-8333-333333333333.jsonl"),
      [
        line("session_meta", { id: "33333333-3333-4333-8333-333333333333", cwd: "/tmp/beta" }),
        line("event_msg", { type: "user_message", message: "shared needle beta" }),
      ].join("\n"),
    );

    const dbPath = join(base, "index.sqlite");
    const selector = JSON.stringify({ kind: "cwd", root, cwd: "/tmp/alpha" });
    const synced = await runCli(["sync", "--selector", selector, "--db", dbPath, "--json"]);
    expect(synced.exitCode).toBe(0);
    const syncPayload = JSON.parse(synced.stdout) as { coverage: { written: boolean; selector: { kind: string; cwd?: string } } };
    expect(syncPayload.coverage.written).toBe(true);
    expect(syncPayload.coverage.selector).toMatchObject({ kind: "cwd", cwd: "/tmp/alpha" });

    const found = await runCli(["find", "shared needle", "--selector", selector, "--db", dbPath, "--json"]);
    expect(found.exitCode).toBe(0);
    const findPayload = JSON.parse(found.stdout) as {
      results: Array<{ sessionUuid: string; cwd: string }>;
      coverage: { complete: boolean; freshness: string };
    };
    expect(findPayload.coverage.complete).toBe(true);
    expect(findPayload.coverage.freshness).toBe("not_checked");
    expect(findPayload.results.map((result) => result.cwd)).toEqual(["/tmp/alpha"]);
  });

  test("status marks coverage stale when selected source files change", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-cli-coverage-stale-"));
    tempDirs.push(base);
    const root = join(base, "sessions");
    const day = join(root, "2026", "04", "21");
    mkdirSync(day, { recursive: true });
    const filePath = join(day, "rollout-2026-04-21T10-00-00-12121212-1212-4212-8212-121212121212.jsonl");
    writeFileSync(
      filePath,
      [
        line("session_meta", { id: "12121212-1212-4212-8212-121212121212", cwd: "/tmp/stale" }),
        line("event_msg", { type: "user_message", message: "stale before" }),
      ].join("\n"),
    );

    const dbPath = join(base, "index.sqlite");
    const selector = JSON.stringify({ kind: "cwd", root, cwd: "/tmp/stale" });
    const synced = await runCli(["sync", "--selector", selector, "--db", dbPath, "--json"]);
    expect(synced.exitCode).toBe(0);

    writeFileSync(
      filePath,
      [
        line("session_meta", { id: "12121212-1212-4212-8212-121212121212", cwd: "/tmp/stale" }),
        line("event_msg", { type: "user_message", message: "stale after" }),
      ].join("\n"),
    );

    const status = await runCli(["status", "--root", root, "--db", dbPath, "--json"]);
    expect(status.exitCode).toBe(0);
    const payload = JSON.parse(status.stdout) as { coverage: Array<{ freshness: string }> };
    expect(payload.coverage[0]?.freshness).toBe("stale");
  });

  test("status --selector treats fresh all coverage as covering a cwd selector", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-cli-coverage-all-covers-cwd-"));
    tempDirs.push(base);
    const root = join(base, "sessions");
    const day = join(root, "2026", "04", "21");
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(day, "rollout-2026-04-21T10-00-00-13131313-1313-4313-8313-131313131313.jsonl"),
      [
        line("session_meta", { id: "13131313-1313-4313-8313-131313131313", cwd: "/tmp/covered-by-all" }),
        line("event_msg", { type: "user_message", message: "covered by all" }),
      ].join("\n"),
    );

    const dbPath = join(base, "index.sqlite");
    await syncSessions({ dbPath, selector: { kind: "all", root } });

    const selector = JSON.stringify({ kind: "cwd", root, cwd: "/tmp/covered-by-all" });
    const status = await runCli(["status", "--root", root, "--selector", selector, "--db", dbPath, "--json"]);

    expect(status.exitCode).toBe(0);
    const payload = JSON.parse(status.stdout) as {
      requestedCoverage: {
        complete: boolean;
        freshness: string;
        recommendedAction: string;
        coveringSelectors: Array<{ selector: { kind: string } }>;
      };
    };
    expect(payload.requestedCoverage.complete).toBe(true);
    expect(payload.requestedCoverage.freshness).toBe("fresh");
    expect(payload.requestedCoverage.recommendedAction).toBe("query");
    expect(payload.requestedCoverage.coveringSelectors[0]?.selector.kind).toBe("all");
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

  test("find can sort by recent time and exclude the current session", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-cli-find-recent-"));
    tempDirs.push(base);
    const sessionsRoot = join(base, "sessions", "2026", "04", "21");
    mkdirSync(sessionsRoot, { recursive: true });

    writeFileSync(
      join(sessionsRoot, "rollout-2026-04-21T10-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl"),
      [
        lineAt("2026-04-21T10:00:00.000Z", "session_meta", { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", cwd: "/tmp/recent-keyword" }),
        lineAt("2026-04-21T10:01:00.000Z", "event_msg", { type: "user_message", message: "$xsearch older target" }),
      ].join("\n"),
    );
    writeFileSync(
      join(sessionsRoot, "rollout-2026-04-21T12-00-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl"),
      [
        lineAt("2026-04-21T12:00:00.000Z", "session_meta", { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", cwd: "/tmp/recent-keyword" }),
        lineAt("2026-04-21T12:01:00.000Z", "event_msg", { type: "user_message", message: "latest question mentions xsearch" }),
      ].join("\n"),
    );

    const dbPath = join(base, "index.sqlite");
    await syncSessions({ dbPath, rootDir: join(base, "sessions") });

    const newest = await runCli(["find", "xsearch", "--sort", "ended", "--db", dbPath, "--json"]);
    expect(newest.exitCode).toBe(0);
    const newestPayload = JSON.parse(newest.stdout) as { sort: string; results: Array<{ sessionUuid: string }> };
    expect(newestPayload.sort).toBe("ended");
    expect(newestPayload.results[0]?.sessionUuid).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

    const excluded = await runCli([
      "find",
      "xsearch",
      "--sort",
      "ended",
      "--exclude-session",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "--db",
      dbPath,
      "--json",
    ]);
    expect(excluded.exitCode).toBe(0);
    const excludedPayload = JSON.parse(excluded.stdout) as { excludedSessions: string[]; results: Array<{ sessionUuid: string }> };
    expect(excludedPayload.excludedSessions).toEqual(["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]);
    expect(excludedPayload.results[0]?.sessionUuid).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });

  test("find emits friendly guidance when index is missing", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-cli-missing-index-"));
    tempDirs.push(base);
    const dbPath = join(base, "index.sqlite");

    const result = await runCli(["find", "hi", "--db", dbPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`index not found: ${dbPath}`);
    expect(result.stderr).toContain("cxs sync");
    expect(result.stderr).toContain("No separate init command is needed");
    expect(result.stderr).not.toContain("Error:");
    expect(result.stderr).not.toContain("at openReadDb");
  });

  test("stats --json emits structured guidance when index is missing", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-cli-missing-index-json-"));
    tempDirs.push(base);
    const dbPath = join(base, "index.sqlite");

    const result = await runCli(["stats", "--json", "--db", dbPath]);

    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout) as {
      error: { code: string; message: string; dbPath: string; hint: string };
    };
    expect(payload.error.code).toBe("index_unavailable");
    expect(payload.error.message).toContain(dbPath);
    expect(payload.error.dbPath).toBe(dbPath);
    expect(payload.error.hint).toContain("cxs sync");
    expect(result.stderr).toBe("");
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
      "--selector",
      JSON.stringify({ kind: "all", root: join(base, "sessions") }),
      "--db",
      join(base, "index.sqlite"),
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("errors:   1");
    expect(result.stdout).toContain(badFilePath);
  });
});

function line(type: string, payload: Record<string, unknown>): string {
  return lineAt(new Date("2026-04-21T00:00:00.000Z").toISOString(), type, payload);
}

function lineAt(timestamp: string, type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp,
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
