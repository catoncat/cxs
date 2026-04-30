import { withReadDb } from "../db";
import { rerankHits } from "../ranking";
import type { FindResult, FindSort, Selector } from "../types";
import { buildCoverageStatus } from "./coverage";
import { searchMessageHits, searchSessionHits } from "./search";

export interface FindSessionsOptions {
  sort?: FindSort;
  excludeSessions?: string[];
}

export function findSessions(
  dbPath: string,
  query: string,
  limit: number,
  selector: Selector | null = null,
  options: FindSessionsOptions = {},
): {
  query: string;
  sort: FindSort;
  excludedSessions: string[];
  results: FindResult[];
  coverage: ReturnType<typeof buildCoverageStatus>;
} {
  return withReadDb(dbPath, (db) => {
    const sort = options.sort ?? "relevance";
    const excludedSessions = uniqueNonEmpty(options.excludeSessions ?? []);
    const recallLimit = sort === "relevance" ? Math.max(limit * 12, 50) : Math.max(limit * 100, 1000);
    const rawRows = [
      ...searchMessageHits(db, query, recallLimit, undefined, selector, { sort, excludeSessions: excludedSessions }),
      ...searchSessionHits(db, query, recallLimit, selector, { sort, excludeSessions: excludedSessions }),
    ];
    const ranked = rerankHits(rawRows, query, Math.max(rawRows.length, limit));
    const results = sort === "relevance"
      ? ranked.slice(0, limit)
      : ranked.sort((left, right) => compareByTime(left, right, sort)).slice(0, limit)
        .map((result, index) => ({ ...result, rank: index + 1 }));
    return { query, sort, excludedSessions, results, coverage: buildCoverageStatus(db, selector) };
  });
}

function compareByTime(left: FindResult, right: FindResult, sort: FindSort): number {
  // OPTIMIZATION: ISO 8601 strings compare correctly lexicographically.
  // Replacing Date.parse() with string comparison avoids significant parsing overhead
  // during sort operations while maintaining the exact same ordering semantics.
  const leftTime = sort === "started" ? left.startedAt : left.endedAt;
  const rightTime = sort === "started" ? right.startedAt : right.endedAt;

  if (rightTime > leftTime) return 1;
  if (rightTime < leftTime) return -1;

  return right.score - left.score;
}

function uniqueNonEmpty(values: string[]): string[] {
  // OPTIMIZATION: Use a single loop to populate the Set.
  // Avoids intermediate array allocations from map() and filter() operations.
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}
