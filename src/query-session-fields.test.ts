import { describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWriteDb, replaceSession } from "./db";
import { INDEX_VERSION } from "./env";
import { syncSessions } from "./indexer";
import { findSessions } from "./query";
import { line, tempDirs } from "./query-test-helpers";

describe("cxs session-level fields", () => {
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

    const singleCharFound = findSessions(dbPath, "设", 5);
    expect(singleCharFound.results).toHaveLength(1);
    expect(singleCharFound.results[0]?.sessionUuid).toBe("abababab-abab-4aba-8aba-abababababab");
    expect(singleCharFound.results[0]?.matchSource).toBe("session");
    expect(singleCharFound.results[0]?.matchSeq).toBeNull();
    expect(singleCharFound.results[0]?.snippet).toContain("<mark>设</mark>");
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
});
