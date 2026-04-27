import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareEvalBatches } from "./compare";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("compareEvalBatches", () => {
  test("summarizes top1 changes across two manual eval batches", () => {
    const base = mkdtempSync(join(tmpdir(), "cxs-eval-compare-"));
    tempDirs.push(base);

    const beforeDir = join(base, "before");
    const afterDir = join(base, "after");
    mkdirSync(beforeDir, { recursive: true });
    mkdirSync(afterDir, { recursive: true });

    writeFileSync(join(beforeDir, "01-deploy.find.json"), findJson("deploy", [
      { rank: 1, sessionUuid: "session-a", title: "deploy checklist" },
      { rank: 2, sessionUuid: "session-b", title: "deploy incident" },
    ]));
    writeFileSync(join(afterDir, "01-deploy.find.json"), findJson("deploy", [
      { rank: 1, sessionUuid: "session-b", title: "deploy incident" },
      { rank: 2, sessionUuid: "session-a", title: "deploy checklist" },
    ]));

    writeFileSync(join(beforeDir, "02-cursor.find.json"), findJson("cursor", [
      { rank: 1, sessionUuid: "session-c", title: "cursor login" },
    ]));
    writeFileSync(join(afterDir, "02-cursor.find.json"), findJson("cursor", [
      { rank: 1, sessionUuid: "session-c", title: "cursor login" },
    ]));

    const summary = compareEvalBatches(beforeDir, afterDir);

    expect(summary.totalQueries).toBe(2);
    expect(summary.top1Changed).toBe(1);
    expect(summary.changedQueries[0]).toEqual({
      query: "deploy",
      beforeTop1: "session-a",
      afterTop1: "session-b",
      beforeTitle: "deploy checklist",
      afterTitle: "deploy incident",
    });
  });
});

function findJson(
  query: string,
  results: Array<{ rank: number; sessionUuid: string; title: string }>,
): string {
  return JSON.stringify({
    query,
    results: results.map((item) => ({
      ...item,
      cwd: "/tmp",
      startedAt: "2026-04-21T00:00:00.000Z",
      endedAt: "2026-04-21T00:00:00.000Z",
      matchCount: 1,
      matchSeq: 0,
      matchRole: "user",
      matchTimestamp: "2026-04-21T00:00:00.000Z",
      score: 100,
      snippet: item.title,
    })),
  });
}
