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
  const leftTime = Date.parse(sort === "started" ? left.startedAt : left.endedAt);
  const rightTime = Date.parse(sort === "started" ? right.startedAt : right.endedAt);
  const primary = safeTime(rightTime) - safeTime(leftTime);
  if (primary !== 0) return primary;
  return right.score - left.score;
}

function safeTime(value: number): number {
  return Number.isNaN(value) ? 0 : value;
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
