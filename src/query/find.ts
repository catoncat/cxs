import { withReadDb } from "../db";
import { rerankHits } from "../ranking";
import type { FindResult, Selector } from "../types";
import { buildCoverageStatus } from "./coverage";
import { searchMessageHits, searchSessionHits } from "./search";

export function findSessions(
  dbPath: string,
  query: string,
  limit: number,
  selector: Selector | null = null,
): { query: string; results: FindResult[]; coverage: ReturnType<typeof buildCoverageStatus> } {
  return withReadDb(dbPath, (db) => {
    const recallLimit = Math.max(limit * 12, 50);
    const rawRows = [
      ...searchMessageHits(db, query, recallLimit, undefined, selector),
      ...searchSessionHits(db, query, recallLimit, selector),
    ];
    const results = rerankHits(rawRows, query, limit);
    return { query, results, coverage: buildCoverageStatus(db, selector) };
  });
}
