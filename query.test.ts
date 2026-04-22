import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { syncSessions } from "./indexer";
import { classifyQueryProfile, findSessions, getMessagePage, getMessageRange } from "./query";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("cxs retrieval flow", () => {
  test("sync -> find -> read-range -> read-page works on fixture sessions", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-test-"));
    tempDirs.push(base);
    const sessionsRoot = join(base, "sessions", "2026", "04", "21");
    mkdirSync(sessionsRoot, { recursive: true });

    writeFileSync(
      join(sessionsRoot, "rollout-2026-04-21T10-00-00-11111111-1111-4111-8111-111111111111.jsonl"),
      [
        line("session_meta", { id: "11111111-1111-4111-8111-111111111111", cwd: "/tmp/project-a" }),
        line("turn_context", { model: "gpt-5.4" }),
        line("event_msg", { type: "user_message", message: "排查 fly deploy 失败" }),
        line("event_msg", { type: "agent_message", message: "先看 health check 和 readback" }),
        line("event_msg", { type: "user_message", message: "health check 还是 500" }),
        line("event_msg", { type: "agent_message", message: "继续检查 secrets readback" }),
      ].join("\n"),
    );

    writeFileSync(
      join(sessionsRoot, "rollout-2026-04-21T11-00-00-22222222-2222-4222-8222-222222222222.jsonl"),
      [
        line("session_meta", { id: "22222222-2222-4222-8222-222222222222", cwd: "/tmp/project-b" }),
        line("turn_context", { model: "gpt-5.4" }),
        line("event_msg", { type: "user_message", message: "重构 markdown parser" }),
        line("event_msg", { type: "agent_message", message: "先补失败测试" }),
      ].join("\n"),
    );

    const dbPath = join(base, "index.sqlite");
    const summary = await syncSessions({ dbPath, rootDir: join(base, "sessions") });

    expect(summary.added).toBe(2);

    const found = findSessions(dbPath, "health check", 5);
    expect(found.results).toHaveLength(1);
    expect(found.results[0]?.sessionUuid).toBe("11111111-1111-4111-8111-111111111111");
    expect(found.results[0]?.matchSeq).toBe(2);

    const range = getMessageRange(dbPath, "11111111-1111-4111-8111-111111111111", {
      seq: 2,
      before: 1,
      after: 1,
    });
    expect(range.anchorSeq).toBe(2);
    expect(range.messages.map((message) => message.seq)).toEqual([1, 2, 3]);

    const page = getMessagePage(dbPath, "11111111-1111-4111-8111-111111111111", 2, 2);
    expect(page.messages.map((message) => message.seq)).toEqual([2, 3]);
  });

  test("read-range can relocate anchor by query within a session", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-query-"));
    tempDirs.push(base);
    const sessionsRoot = join(base, "sessions", "2026", "04", "21");
    mkdirSync(sessionsRoot, { recursive: true });

    writeFileSync(
      join(sessionsRoot, "rollout-2026-04-21T10-00-00-33333333-3333-4333-8333-333333333333.jsonl"),
      [
        line("session_meta", { id: "33333333-3333-4333-8333-333333333333", cwd: "/tmp/project-c" }),
        line("turn_context", { model: "gpt-5.4" }),
        line("event_msg", { type: "user_message", message: "先做回滚预案" }),
        line("event_msg", { type: "agent_message", message: "health check 先确认 500 触发点" }),
        line("event_msg", { type: "agent_message", message: "然后看 readback" }),
      ].join("\n"),
    );

    const dbPath = join(base, "index.sqlite");
    const summary = await syncSessions({ dbPath, rootDir: join(base, "sessions") });
    expect(summary.added).toBe(1);

    const range = getMessageRange(dbPath, "33333333-3333-4333-8333-333333333333", {
      query: "health check",
      before: 0,
      after: 1,
    });

    expect(range.anchorSeq).toBe(1);
    expect(range.rangeStartSeq).toBe(1);
    expect(range.rangeEndSeq).toBe(2);
    expect(range.messages.map((message) => message.seq)).toEqual([1, 2]);
  });

  test("session title hit outranks broad incidental mentions", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-rank-"));
    tempDirs.push(base);
    const sessionsRoot = join(base, "sessions", "2026", "04", "21");
    mkdirSync(sessionsRoot, { recursive: true });

    writeFileSync(
      join(sessionsRoot, "rollout-2026-04-21T09-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl"),
      [
        line("session_meta", { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", cwd: "/tmp/mac-setup" }),
        line("turn_context", { model: "gpt-5.4" }),
        line("event_msg", { type: "user_message", message: "同步新 Mac 配置" }),
        line("event_msg", { type: "agent_message", message: "先确认 Hammerspoon 进程在不在" }),
        line("event_msg", { type: "agent_message", message: "Hammerspoon 路径已经对了" }),
        line("event_msg", { type: "agent_message", message: "如果 Hammerspoon console 没报错就继续" }),
      ].join("\n"),
    );

    writeFileSync(
      join(sessionsRoot, "rollout-2026-04-21T10-00-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl"),
      [
        line("session_meta", { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", cwd: "/Users/envvar/.hammerspoon" }),
        line("turn_context", { model: "gpt-5.4" }),
        line("event_msg", { type: "user_message", message: "hammerspoon clipboard 搜索坏了" }),
        line("event_msg", { type: "agent_message", message: "先检查 clipboard history" }),
      ].join("\n"),
    );

    const dbPath = join(base, "index.sqlite");
    const summary = await syncSessions({ dbPath, rootDir: join(base, "sessions") });
    expect(summary.added).toBe(2);

    const found = findSessions(dbPath, "hammerspoon", 5);
    expect(found.results[0]?.sessionUuid).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });

  test("broad query prefers sustained session evidence over title-only incidental hit", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-broad-"));
    tempDirs.push(base);
    const sessionsRoot = join(base, "sessions", "2026", "04", "21");
    mkdirSync(sessionsRoot, { recursive: true });

    writeFileSync(
      join(sessionsRoot, "rollout-2026-04-21T09-00-00-cccccccc-cccc-4ccc-8ccc-cccccccccccc.jsonl"),
      [
        line("session_meta", { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", cwd: "/tmp/deploy-title" }),
        line("turn_context", { model: "gpt-5.4" }),
        line("event_msg", { type: "user_message", message: "deploy checklist 先记一下" }),
        line("event_msg", { type: "agent_message", message: "今天主要在调 hammerspoon 输入法切换" }),
        line("event_msg", { type: "agent_message", message: "先确认 WeChat 输入法默认值" }),
      ].join("\n"),
    );

    writeFileSync(
      join(sessionsRoot, "rollout-2026-04-21T10-00-00-dddddddd-dddd-4ddd-8ddd-dddddddddddd.jsonl"),
      [
        line("session_meta", { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", cwd: "/tmp/deploy-incident" }),
        line("turn_context", { model: "gpt-5.4" }),
        line("event_msg", { type: "user_message", message: "fly deploy 之后 health check 还是 500" }),
        line("event_msg", { type: "agent_message", message: "先确认 deploy 之后的 readback 和 health check" }),
        line("event_msg", { type: "user_message", message: "这个 deploy 回滚后恢复了" }),
      ].join("\n"),
    );

    const dbPath = join(base, "index.sqlite");
    const summary = await syncSessions({ dbPath, rootDir: join(base, "sessions") });
    expect(summary.added).toBe(2);

    const found = findSessions(dbPath, "deploy", 5);
    expect(found.results[0]?.sessionUuid).toBe("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  });

  test("sync stores derived session summary and find returns it", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-summary-"));
    tempDirs.push(base);
    const sessionsRoot = join(base, "sessions", "2026", "04", "21");
    mkdirSync(sessionsRoot, { recursive: true });

    writeFileSync(
      join(sessionsRoot, "rollout-2026-04-21T12-00-00-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.jsonl"),
      [
        line("session_meta", { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", cwd: "/tmp/deploy-summary" }),
        line("turn_context", { model: "gpt-5.4" }),
        line("event_msg", { type: "user_message", message: "排查 fly deploy 失败" }),
        line("event_msg", { type: "agent_message", message: "先看 health check 和 readback" }),
        line("event_msg", { type: "user_message", message: "health check 还是 500" }),
        line("event_msg", { type: "agent_message", message: "继续核对 secrets readback" }),
      ].join("\n"),
    );

    const dbPath = join(base, "index.sqlite");
    const summary = await syncSessions({ dbPath, rootDir: join(base, "sessions") });
    expect(summary.added).toBe(1);

    const db = openDb(dbPath);
    const row = db
      .query("SELECT summary_text AS summaryText FROM sessions WHERE session_uuid = ? LIMIT 1")
      .get("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee") as { summaryText: string } | null;
    db.close();

    expect(row?.summaryText).toContain("排查 fly deploy 失败");
    expect(row?.summaryText).toContain("先看 health check 和 readback");
    expect(row?.summaryText).toContain("health check 还是 500");

    const found = findSessions(dbPath, "deploy", 5);
    expect(found.results[0]?.summaryText).toContain("排查 fly deploy 失败");
  });

  test("find keeps distinct sessions even when titles collapse to the same normalized key", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-dedup-"));
    tempDirs.push(base);
    const sessionsRoot = join(base, "sessions", "2026", "04", "22");
    mkdirSync(sessionsRoot, { recursive: true });

    writeFileSync(
      join(sessionsRoot, "rollout-2026-04-22T08-00-00-12121212-1212-4212-8212-121212121212.jsonl"),
      [
        line("session_meta", { id: "12121212-1212-4212-8212-121212121212", cwd: "/tmp/alpha" }),
        line("turn_context", { model: "gpt-5.4" }),
        line("event_msg", { type: "user_message", message: "排查 deploy 500" }),
        line("event_msg", { type: "agent_message", message: "alpha 先看 first deploy rollback" }),
      ].join("\n"),
    );

    writeFileSync(
      join(sessionsRoot, "rollout-2026-04-22T09-00-00-34343434-3434-4343-8343-343434343434.jsonl"),
      [
        line("session_meta", { id: "34343434-3434-4343-8343-343434343434", cwd: "/tmp/beta" }),
        line("turn_context", { model: "gpt-5.4" }),
        line("event_msg", { type: "user_message", message: "排查 deploy 500" }),
        line("event_msg", { type: "agent_message", message: "beta 再看 second deploy readback" }),
      ].join("\n"),
    );

    const dbPath = join(base, "index.sqlite");
    const summary = await syncSessions({ dbPath, rootDir: join(base, "sessions") });
    expect(summary.added).toBe(2);

    const found = findSessions(dbPath, "deploy 500", 5);
    expect(found.results).toHaveLength(2);
    expect(found.results.map((result) => result.sessionUuid).sort()).toEqual([
      "12121212-1212-4212-8212-121212121212",
      "34343434-3434-4343-8343-343434343434",
    ]);
  });
});

describe("query profile", () => {
  test("classifies broad concept query separately from exact troubleshooting query", () => {
    expect(classifyQueryProfile("deploy").kind).toBe("broad");
    expect(classifyQueryProfile("health check 500").kind).toBe("exact");
    expect(classifyQueryProfile("src/background.ts remoteHosts").kind).toBe("exact");
  });
});

function line(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: new Date("2026-04-21T00:00:00.000Z").toISOString(),
    type,
    payload,
  });
}
