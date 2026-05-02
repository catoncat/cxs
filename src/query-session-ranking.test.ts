import { describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWriteDb, replaceSession } from "./db";
import { INDEX_VERSION } from "./env";
import { syncSessions } from "./indexer";
import { findSessions } from "./query";
import { line, tempDirs } from "./query-test-helpers";

describe("cxs session ranking", () => {
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

  test("path-like command query prefers bounded command use over prefix and scattered term mentions", async () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-command-rank-"));
    tempDirs.push(base);
    const sessionsRoot = join(base, "sessions", "2026", "05", "01");
    mkdirSync(sessionsRoot, { recursive: true });

    writeFileSync(
      join(sessionsRoot, "rollout-2026-05-01T09-00-00-e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1.jsonl"),
      [
        line("session_meta", { id: "e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1", cwd: "/tmp/tool-debug" }),
        line("turn_context", { model: "gpt-5.4" }),
        line("event_msg", { type: "user_message", message: "调试 node build/cli.js deploy-preview 的异常输出" }),
        line("event_msg", {
          type: "agent_message",
          message: [
            "复现发行调试：node build/cli.js deploy-preview 会触发 db missing。",
            "另外 deploy 包时检查 package metadata。",
          ].join(" "),
        }),
      ].join("\n"),
    );

    writeFileSync(
      join(sessionsRoot, "rollout-2026-05-01T10-00-00-f2f2f2f2-f2f2-42f2-82f2-f2f2f2f2f2f2.jsonl"),
      [
        line("session_meta", { id: "f2f2f2f2-f2f2-42f2-82f2-f2f2f2f2f2f2", cwd: "/tmp/deploy-tool" }),
        line("turn_context", { model: "gpt-5.4" }),
        line("event_msg", { type: "user_message", message: "怎么发布" }),
        line("event_msg", {
          type: "agent_message",
          message: "cd /tmp/deploy-tool 后运行 node build/cli.js deploy fixtures/sample.jsonl --json",
        }),
      ].join("\n"),
    );

    const dbPath = join(base, "index.sqlite");
    const summary = await syncSessions({ dbPath, rootDir: join(base, "sessions") });
    expect(summary.added).toBe(2);

    const found = findSessions(dbPath, "node build/cli.js deploy", 5);
    expect(found.results[0]?.sessionUuid).toBe("f2f2f2f2-f2f2-42f2-82f2-f2f2f2f2f2f2");
  });
});
