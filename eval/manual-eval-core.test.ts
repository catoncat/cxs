import { describe, expect, test } from "vitest";
import { evaluateManualQuery } from "./manual-eval-core";
import type { FindResult } from "../src/types";

describe("evaluateManualQuery", () => {
  test("requires every configured predicate to match somewhere in top-k", () => {
    const evaluation = evaluateManualQuery(
      {
        id: "deploy",
        query: "deploy",
        intent: "find the deploy session",
        expectedTitleOrSummaryContains: "deploy incident",
        expectedCwdContains: "/tmp/project-a",
      },
      [
        findResult({ title: "deploy incident", cwd: "/tmp/project-b" }),
      ],
    );

    expect(evaluation.mark).toBe("fail");
    expect(evaluation.predicateResults).toEqual([
      {
        label: "title_or_summary",
        needle: "deploy incident",
        matched: true,
      },
      {
        label: "cwd",
        needle: "/tmp/project-a",
        matched: false,
      },
    ]);
  });

  test("allows different predicates to match different results inside the same top-k window", () => {
    const evaluation = evaluateManualQuery(
      {
        id: "deploy",
        query: "deploy",
        intent: "find the deploy session",
        expectedTitleOrSummaryContains: "deploy incident",
        expectedCwdContains: "/tmp/project-a",
      },
      [
        findResult({ title: "deploy incident", cwd: "/tmp/project-b" }),
        findResult({ title: "other", cwd: "/tmp/project-a" }),
      ],
    );

    expect(evaluation.mark).toBe("pass");
    expect(evaluation.predicateResults.every((predicate) => predicate.matched)).toBe(true);
  });
});

function findResult(
  overrides: Partial<{
    rank: number;
    sessionUuid: string;
    title: string;
    summaryText: string;
    cwd: string;
    snippet: string;
  }> = {},
): FindResult {
  return {
    rank: overrides.rank ?? 1,
    sessionUuid: overrides.sessionUuid ?? "session-a",
    title: overrides.title ?? "title",
    summaryText: overrides.summaryText ?? "",
    cwd: overrides.cwd ?? "/tmp/project",
    startedAt: "2026-04-22T00:00:00.000Z",
    endedAt: "2026-04-22T00:00:00.000Z",
    matchCount: 1,
    matchSource: "message",
    matchSeq: 0,
    matchRole: "user",
    matchTimestamp: "2026-04-22T00:00:00.000Z",
    score: 100,
    snippet: overrides.snippet ?? overrides.title ?? "title",
  };
}
