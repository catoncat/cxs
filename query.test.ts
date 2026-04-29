import { afterEach, describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openReadDb, openWriteDb, replaceSession } from "./db";
import { INDEX_VERSION } from "./env";
import { syncSessions } from "./indexer";
import {
  classifyQueryProfile,
  findSessions,
  getMessagePage,
  getMessageRange,
} from "./query";

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

  test("find can recall session title even when no message contains the query", () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-session-title-"));
    tempDirs.push(base);
    const dbPath = join(base, "index.sqlite");
    const db = openWriteDb(dbPath);
    replaceSession(
      db,
      {
        sessionUuid: "abababab-abab-4aba-8aba-abababababab",
        filePath: join(base, "rollout.jsonl"),
        title: "设置 ChatGPT 订阅取消提醒",
        summaryText: "user: billing reminder | assistant: schedule a local notification",
        compactText: "",
        reasoningSummaryText: "",
        cwd: "/tmp/title-only",
        model: "gpt-5.4",
        startedAt: "2026-04-24T01:00:00.000Z",
        endedAt: "2026-04-24T01:01:00.000Z",
        messages: [
          {
            role: "user",
            contentText: "billing reminder",
            timestamp: "2026-04-24T01:00:00.000Z",
            seq: 0,
            sourceKind: "event_msg",
          },
          {
            role: "assistant",
            contentText: "schedule a local notification",
            timestamp: "2026-04-24T01:01:00.000Z",
            seq: 1,
            sourceKind: "event_msg",
          },
        ],
      },
      1,
      1,
      INDEX_VERSION,
      "",
    );
    db.close();

    const found = findSessions(dbPath, "订阅取消提醒", 5);

    expect(found.results).toHaveLength(1);
    expect(found.results[0]?.sessionUuid).toBe("abababab-abab-4aba-8aba-abababababab");
    expect(found.results[0]?.matchSource).toBe("session");
    expect(found.results[0]?.matchSeq).toBeNull();
    expect(found.results[0]?.snippet).toContain("订阅取消提醒");
  });

  test("session-level fields have explicit ranking weights", () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-session-field-weights-"));
    tempDirs.push(base);
    const dbPath = join(base, "index.sqlite");
    const db = openWriteDb(dbPath);
    const common = {
      filePath: join(base, "rollout.jsonl"),
      title: "neutral session",
      summaryText: "",
      compactText: "",
      reasoningSummaryText: "",
      cwd: "/tmp/field-weights",
      model: "gpt-5.4",
      startedAt: "2026-04-24T01:00:00.000Z",
      endedAt: "2026-04-24T01:00:00.000Z",
      messages: [
        {
          role: "user" as const,
          contentText: "ordinary visible message",
          timestamp: "2026-04-24T01:00:00.000Z",
          seq: 0,
          sourceKind: "event_msg" as const,
        },
      ],
    };

    replaceSession(db, {
      ...common,
      sessionUuid: "10101010-1010-4010-8010-101010101010",
      filePath: join(base, "title.jsonl"),
      title: "handoffneedle title",
    }, 1, 1, INDEX_VERSION, "");
    replaceSession(db, {
      ...common,
      sessionUuid: "20202020-2020-4020-8020-202020202020",
      filePath: join(base, "compact.jsonl"),
      compactText: "handoffneedle compact handoff",
    }, 1, 1, INDEX_VERSION, "");
    replaceSession(db, {
      ...common,
      sessionUuid: "30303030-3030-4030-8030-303030303030",
      filePath: join(base, "summary.jsonl"),
      summaryText: "handoffneedle derived summary",
    }, 1, 1, INDEX_VERSION, "");
    replaceSession(db, {
      ...common,
      sessionUuid: "40404040-4040-4040-8040-404040404040",
      filePath: join(base, "reasoning.jsonl"),
      reasoningSummaryText: "handoffneedle reasoning summary",
    }, 1, 1, INDEX_VERSION, "");
    db.close();

    const found = findSessions(dbPath, "handoffneedle", 10);

    expect(found.results.map((result) => result.sessionUuid)).toEqual([
      "10101010-1010-4010-8010-101010101010",
      "20202020-2020-4020-8020-202020202020",
      "30303030-3030-4030-8030-303030303030",
      "40404040-4040-4040-8040-404040404040",
    ]);
  });

  test("sync indexes compacted handoff text for session-level recall", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-compact-recall-"));
    tempDirs.push(base);
    const sessionsRoot = join(base, "sessions", "2026", "04", "24");
    mkdirSync(sessionsRoot, { recursive: true });

    writeFileSync(
      join(sessionsRoot, "rollout-2026-04-24T09-00-00-90909090-9090-4090-8090-909090909090.jsonl"),
      [
        line("session_meta", { id: "90909090-9090-4090-8090-909090909090", cwd: "/tmp/compact-recall" }),
        line("turn_context", { model: "gpt-5.4" }),
        line("event_msg", { type: "user_message", message: "继续前一个任务" }),
        line("compacted", { message: "handoff says durable output queue needs final verification" }),
        line("event_msg", { type: "context_compacted" }),
        line("event_msg", { type: "agent_message", message: "先读取测试文件" }),
      ].join("\n"),
    );

    const dbPath = join(base, "index.sqlite");
    const summary = await syncSessions({ dbPath, rootDir: join(base, "sessions") });
    expect(summary.added).toBe(1);

    const found = findSessions(dbPath, "durable output queue", 5);

    expect(found.results).toHaveLength(1);
    expect(found.results[0]?.sessionUuid).toBe("90909090-9090-4090-8090-909090909090");
    expect(found.results[0]?.matchSource).toBe("session");
    expect(found.results[0]?.snippet).toContain("durable output queue");
  });

  test("session-level snippet prefers the window with denser query term coverage", () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-session-snippet-"));
    tempDirs.push(base);
    const dbPath = join(base, "index.sqlite");
    const db = openWriteDb(dbPath);
    replaceSession(
      db,
      {
        sessionUuid: "50505050-5050-4050-8050-505050505050",
        filePath: join(base, "snippet.jsonl"),
        title: "neutral deploy title",
        summaryText: "",
        compactText: [
          "部署 happened early in the handoff.",
          "Later the important evidence says the health check failed after rollout.",
        ].join(" "),
        reasoningSummaryText: "",
        cwd: "/tmp/snippet",
        model: "gpt-5.4",
        startedAt: "2026-04-24T01:00:00.000Z",
        endedAt: "2026-04-24T01:00:00.000Z",
        messages: [
          {
            role: "user",
            contentText: "ordinary visible message",
            timestamp: "2026-04-24T01:00:00.000Z",
            seq: 0,
            sourceKind: "event_msg",
          },
        ],
      },
      1,
      1,
      INDEX_VERSION,
      "",
    );
    db.close();

    const found = findSessions(dbPath, "部署 health check", 5);

    expect(found.results[0]?.snippet).toContain("health");
    expect(found.results[0]?.snippet).toContain("check");
  });

  test("mixed session/message hit prefers message displayRow but keeps session ranking signal", () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-mixed-match-"));
    tempDirs.push(base);
    const dbPath = join(base, "index.sqlite");
    const db = openWriteDb(dbPath);

    // Mixed session: title carries the query (strong session hit) AND one
    // message body also carries it (weaker message hit). The display row
    // must come from the message hit so read-range can re-anchor on a real
    // seq, but the session-level signal still has to outrank a peer that
    // only has the message hit.
    replaceSession(db, {
      sessionUuid: "60606060-6060-4606-8606-606060606060",
      filePath: join(base, "mixed.jsonl"),
      title: "payloadbeacon retry handoff",
      summaryText: "",
      compactText: "",
      reasoningSummaryText: "",
      cwd: "/tmp/mixed",
      model: "gpt-5.4",
      startedAt: "2026-04-24T01:00:00.000Z",
      endedAt: "2026-04-24T01:00:00.000Z",
      messages: [
        {
          role: "user",
          contentText: "noticed payloadbeacon stalled in production",
          timestamp: "2026-04-24T01:00:00.000Z",
          seq: 0,
          sourceKind: "event_msg",
        },
        {
          role: "assistant",
          contentText: "checking retry queue depth and surface",
          timestamp: "2026-04-24T01:00:30.000Z",
          seq: 1,
          sourceKind: "event_msg",
        },
      ],
    }, 1, 1, INDEX_VERSION, "");

    // Message-only control: query appears only in a message body, neither
    // title nor any session-level field carries it.
    replaceSession(db, {
      sessionUuid: "70707070-7070-4707-8707-707070707070",
      filePath: join(base, "message-only.jsonl"),
      title: "neutral retry surface review",
      summaryText: "",
      compactText: "",
      reasoningSummaryText: "",
      cwd: "/tmp/message-only",
      model: "gpt-5.4",
      startedAt: "2026-04-24T01:00:00.000Z",
      endedAt: "2026-04-24T01:00:00.000Z",
      messages: [
        {
          role: "user",
          contentText: "saw payloadbeacon mentioned once in passing",
          timestamp: "2026-04-24T01:00:00.000Z",
          seq: 0,
          sourceKind: "event_msg",
        },
      ],
    }, 1, 1, INDEX_VERSION, "");

    db.close();

    const found = findSessions(dbPath, "payloadbeacon", 5);

    const mixed = found.results.find(
      (result) => result.sessionUuid === "60606060-6060-4606-8606-606060606060",
    );
    const messageOnly = found.results.find(
      (result) => result.sessionUuid === "70707070-7070-4707-8707-707070707070",
    );

    expect(mixed).toBeDefined();
    expect(messageOnly).toBeDefined();

    // Display row must come from the message hit so read-range can anchor
    // on a real seq.
    expect(mixed?.matchSource).toBe("message");
    expect(typeof mixed?.matchSeq).toBe("number");

    // Session-level signal still wins overall ranking and score.
    expect(found.results[0]?.sessionUuid).toBe("60606060-6060-4606-8606-606060606060");
    expect(mixed!.score).toBeGreaterThan(messageOnly!.score);
  });

  test("session-only hit reports matchSource session and null matchSeq", () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-session-only-match-"));
    tempDirs.push(base);
    const dbPath = join(base, "index.sqlite");
    const db = openWriteDb(dbPath);

    replaceSession(db, {
      sessionUuid: "80808080-8080-4808-8808-808080808080",
      filePath: join(base, "session-only.jsonl"),
      title: "payloadbeacon postmortem outline",
      summaryText: "",
      compactText: "",
      reasoningSummaryText: "",
      cwd: "/tmp/session-only",
      model: "gpt-5.4",
      startedAt: "2026-04-24T01:00:00.000Z",
      endedAt: "2026-04-24T01:00:00.000Z",
      messages: [
        {
          role: "user",
          contentText: "everything looked fine on the surface",
          timestamp: "2026-04-24T01:00:00.000Z",
          seq: 0,
          sourceKind: "event_msg",
        },
        {
          role: "assistant",
          contentText: "agreed, no anomalies in the queue depth",
          timestamp: "2026-04-24T01:00:30.000Z",
          seq: 1,
          sourceKind: "event_msg",
        },
      ],
    }, 1, 1, INDEX_VERSION, "");

    db.close();

    const found = findSessions(dbPath, "payloadbeacon", 5);

    expect(found.results).toHaveLength(1);
    expect(found.results[0]?.sessionUuid).toBe("80808080-8080-4808-8808-808080808080");
    expect(found.results[0]?.matchSource).toBe("session");
    expect(found.results[0]?.matchSeq).toBeNull();
  });

  test("message-only hit reports matchSource message with a numeric matchSeq", () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-message-only-match-"));
    tempDirs.push(base);
    const dbPath = join(base, "index.sqlite");
    const db = openWriteDb(dbPath);

    replaceSession(db, {
      sessionUuid: "90909090-9090-4909-8909-909090909090",
      filePath: join(base, "message-only-baseline.jsonl"),
      title: "neutral retry surface review",
      summaryText: "",
      compactText: "",
      reasoningSummaryText: "",
      cwd: "/tmp/message-only-baseline",
      model: "gpt-5.4",
      startedAt: "2026-04-24T01:00:00.000Z",
      endedAt: "2026-04-24T01:00:00.000Z",
      messages: [
        {
          role: "assistant",
          contentText: "kicked off neutral diagnostics",
          timestamp: "2026-04-24T01:00:00.000Z",
          seq: 0,
          sourceKind: "event_msg",
        },
        {
          role: "user",
          contentText: "found payloadbeacon in the trace",
          timestamp: "2026-04-24T01:00:30.000Z",
          seq: 1,
          sourceKind: "event_msg",
        },
      ],
    }, 1, 1, INDEX_VERSION, "");

    db.close();

    const found = findSessions(dbPath, "payloadbeacon", 5);

    expect(found.results).toHaveLength(1);
    expect(found.results[0]?.matchSource).toBe("message");
    expect(found.results[0]?.matchSeq).toBe(1);
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

  test("parallel read commands wait through transient locks without surfacing SQLITE_BUSY", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-parallel-"));
    tempDirs.push(base);
    const sessionsRoot = join(base, "sessions", "2026", "04", "22");
    mkdirSync(sessionsRoot, { recursive: true });

    writeFileSync(
      join(sessionsRoot, "rollout-2026-04-22T10-00-00-56565656-5656-4565-8565-565656565656.jsonl"),
      [
        line("session_meta", { id: "56565656-5656-4565-8565-565656565656", cwd: "/tmp/parallel" }),
        line("turn_context", { model: "gpt-5.4" }),
        line("event_msg", { type: "user_message", message: "reverse-i-search 历史怎么找" }),
        line("event_msg", { type: "agent_message", message: "先用 cxs find reverse-i-search" }),
        line("event_msg", { type: "user_message", message: "顺便查 ffmpeg 的那次会话" }),
        line("event_msg", { type: "agent_message", message: "可以并行 find ffmpeg 再看 stats" }),
      ].join("\n"),
    );

    const dbPath = join(base, "index.sqlite");
    const summary = await syncSessions({ dbPath, rootDir: join(base, "sessions") });
    expect(summary.added).toBe(1);

    const queryModuleUrl = pathToFileURL(join(import.meta.dirname, "query.ts")).href;
    const blocker = await holdExclusiveLock(dbPath, 400);
    const tasks = [
      ...Array.from({ length: 6 }, () => runReadChild(queryModuleUrl, dbPath, "find", "reverse-i-search")),
      ...Array.from({ length: 6 }, () => runReadChild(queryModuleUrl, dbPath, "stats")),
    ];
    const results = await Promise.all(tasks);
    await blocker.done;
    const failures = results.filter((result) => result.code !== 0);

    expect(failures).toEqual([]);
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

function runReadChild(
  queryModuleUrl: string,
  dbPath: string,
  command: "find" | "stats",
  query?: string,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const script = `
      const [moduleUrl, dbPath, command, query = ""] = process.argv.slice(1);
      const queryModule = await import(moduleUrl);
      if (command === "stats") {
        queryModule.collectStats(dbPath);
      } else {
        queryModule.findSessions(dbPath, query, 5);
      }
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--eval", script, queryModuleUrl, dbPath, command, query ?? ""],
      { cwd: import.meta.dirname, stdio: ["ignore", "ignore", "pipe"] },
    );

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stderr });
    });
  });
}

function holdExclusiveLock(
  dbPath: string,
  holdMs: number,
): Promise<{ done: Promise<number | null> }> {
  return new Promise((resolve, reject) => {
    const script = `
      import Database from "better-sqlite3";
      const [dbPath, holdMs] = process.argv.slice(1);
      const db = new Database(dbPath);
      db.pragma("busy_timeout = 5000");
      db.pragma("locking_mode = EXCLUSIVE");
      db.exec("BEGIN EXCLUSIVE");
      console.log("locked");
      setTimeout(() => {
        db.exec("COMMIT");
        db.close();
      }, Number(holdMs));
    `;
    const child = spawn(
      process.execPath,
      ["--eval", script, dbPath, String(holdMs)],
      { cwd: import.meta.dirname, stdio: ["ignore", "pipe", "pipe"] },
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
