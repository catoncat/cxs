import { describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { syncSessions } from "./indexer";
import { holdExclusiveLock, line, runReadChild, tempDirs } from "./query-test-helpers";

describe("cxs query concurrency", () => {
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
