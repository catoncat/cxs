import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodexSession } from "./parser";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseCodexSession", () => {
  test("extracts compacted handoff and reasoning summaries without turning them into messages", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-parser-compact-"));
    tempDirs.push(base);
    const sessionsRoot = join(base, "sessions", "2026", "04", "22");
    mkdirSync(sessionsRoot, { recursive: true });

    const filePath = join(
      sessionsRoot,
      "rollout-2026-04-22T09-00-00-88888888-8888-4888-8888-888888888888.jsonl",
    );
    writeFileSync(filePath, [
      line("session_meta", { id: "88888888-8888-4888-8888-888888888888", cwd: "/tmp/compact" }),
      line("turn_context", { model: "gpt-5.4" }),
      line("event_msg", { type: "user_message", message: "继续前一个任务" }),
      line("compacted", { message: "handoff: durable output queue needs final verification" }),
      line("event_msg", { type: "context_compacted" }),
      line("response_item", {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "checking batch checkpoint behavior" }],
      }),
      line("event_msg", { type: "agent_message", message: "我会先看现有测试" }),
    ].join("\n"));

    const parsed = await parseCodexSession(filePath);
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") return;

    expect(parsed.session.compactText).toContain("durable output queue");
    expect(parsed.session.reasoningSummaryText).toContain("batch checkpoint behavior");
    expect(parsed.session.messages.map((message) => message.contentText)).toEqual([
      "继续前一个任务",
      "我会先看现有测试",
    ]);
  });

  test("keeps legitimate sessions even when one synthetic marker message appears", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-parser-"));
    tempDirs.push(base);
    const sessionsRoot = join(base, "sessions", "2026", "04", "22");
    mkdirSync(sessionsRoot, { recursive: true });

    const filePath = join(
      sessionsRoot,
      "rollout-2026-04-22T10-00-00-99999999-9999-4999-8999-999999999999.jsonl",
    );
    writeFileSync(filePath, [
      line("session_meta", { id: "99999999-9999-4999-8999-999999999999", cwd: "/tmp/mixed" }),
      line("turn_context", { model: "gpt-5.4" }),
      line("event_msg", { type: "user_message", message: "排查 retrieval false positive" }),
      line("event_msg", {
        type: "agent_message",
        message: [
          "The following is the Codex agent history whose request action you are assessing",
          ">>> TRANSCRIPT START",
        ].join("\n"),
      }),
      line("event_msg", { type: "agent_message", message: "继续检查 ranking 输出" }),
    ].join("\n"));

    const parsed = await parseCodexSession(filePath);
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") return;

    expect(parsed.session.sessionUuid).toBe("99999999-9999-4999-8999-999999999999");
    expect(parsed.session.messages.map((message) => message.contentText)).toEqual([
      "排查 retrieval false positive",
      "继续检查 ranking 输出",
    ]);
  });

  test("filters sessions that only contain synthetic marker messages", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-parser-filtered-"));
    tempDirs.push(base);
    const sessionsRoot = join(base, "sessions", "2026", "04", "22");
    mkdirSync(sessionsRoot, { recursive: true });

    const filePath = join(
      sessionsRoot,
      "rollout-2026-04-22T11-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl",
    );
    writeFileSync(filePath, [
      line("session_meta", { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", cwd: "/tmp/synthetic" }),
      line("turn_context", { model: "gpt-5.4" }),
      line("event_msg", {
        type: "agent_message",
        message: ">>> APPROVAL REQUEST START",
      }),
    ].join("\n"));

    const parsed = await parseCodexSession(filePath);
    expect(parsed).toEqual({ kind: "filtered" });
  });
});

function line(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: new Date("2026-04-22T00:00:00.000Z").toISOString(),
    type,
    payload,
  });
}
