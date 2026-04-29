import { describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWriteDb, replaceSession } from "./db";
import { INDEX_VERSION } from "./env";
import { syncSessions } from "./indexer";
import { findSessions } from "./query";
import { line, tempDirs } from "./query-test-helpers";

describe("cxs display row selection", () => {
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
});
