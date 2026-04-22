import type { FindResult } from "../types";

export interface ManualQuery {
  id: string;
  query: string;
  intent: string;
  category?: string;
  expectedTitleOrSummaryContains?: string;
  expectedCwdContains?: string;
  expectedSnippetContains?: string;
}

export type PassMark = "pass" | "fail" | "skip";

export interface ManualPredicateResult {
  label: "title_or_summary" | "cwd" | "snippet";
  needle: string;
  matched: boolean;
}

export interface ManualQueryEvaluation {
  mark: PassMark;
  predicateResults: ManualPredicateResult[];
}

export function evaluateManualQuery(
  item: ManualQuery,
  results: FindResult[],
): ManualQueryEvaluation {
  const predicateResults: ManualPredicateResult[] = [];

  if (item.expectedTitleOrSummaryContains) {
    const needle = item.expectedTitleOrSummaryContains.toLowerCase();
    predicateResults.push({
      label: "title_or_summary",
      needle,
      matched: results.some((result) =>
        result.title.toLowerCase().includes(needle)
        || result.summaryText.toLowerCase().includes(needle)
      ),
    });
  }

  if (item.expectedCwdContains) {
    const needle = item.expectedCwdContains.toLowerCase();
    predicateResults.push({
      label: "cwd",
      needle,
      matched: results.some((result) => result.cwd.toLowerCase().includes(needle)),
    });
  }

  if (item.expectedSnippetContains) {
    const needle = item.expectedSnippetContains.toLowerCase();
    predicateResults.push({
      label: "snippet",
      needle,
      matched: results.some((result) => result.snippet.toLowerCase().includes(needle)),
    });
  }

  if (predicateResults.length === 0) {
    return {
      mark: "skip",
      predicateResults,
    };
  }

  return {
    mark: predicateResults.every((predicate) => predicate.matched) ? "pass" : "fail",
    predicateResults,
  };
}
