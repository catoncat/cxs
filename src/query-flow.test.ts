import { describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openReadDb } from "./db";
import { syncSessions } from "./indexer";
import { findSessions, getMessagePage, getMessageRange } from "./query";
import { line, tempDirs } from "./query-test-helpers";

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

  test("read-page reports coverage for sessions synced from a nonstandard root", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-nonstandard-root-"));
    tempDirs.push(base);
    const root = join(base, "rawroot");
    const day = join(root, "2026", "04", "22");
    mkdirSync(day, { recursive: true });

    writeFileSync(
      join(day, "rollout-2026-04-22T10-00-00-45454545-4545-4545-8545-454545454545.jsonl"),
      [
        line("session_meta", { id: "45454545-4545-4545-8545-454545454545", cwd: "/tmp/nonstandard-root" }),
        line("event_msg", { type: "user_message", message: "root attribution needle" }),
      ].join("\n"),
    );

    const dbPath = join(base, "index.sqlite");
    await syncSessions({ dbPath, selector: { kind: "all", root } });

    const page = getMessagePage(dbPath, "45454545-4545-4545-8545-454545454545", 0, 10);

    expect(page.coverage.entries).toHaveLength(1);
    expect(page.coverage.entries[0]?.selector).toEqual({ kind: "all", root });
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

    const db = openReadDb(dbPath);
    const row = db
      .prepare<[string], { summaryText: string }>("SELECT summary_text AS summaryText FROM sessions WHERE session_uuid = ? LIMIT 1")
      .get("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee") as { summaryText: string } | null;
    db.close();

    expect(row?.summaryText).toContain("排查 fly deploy 失败");
    expect(row?.summaryText).toContain("先看 health check 和 readback");
    expect(row?.summaryText).toContain("health check 还是 500");

    const found = findSessions(dbPath, "deploy", 5);
    expect(found.results[0]?.summaryText).toContain("排查 fly deploy 失败");
  });
});
