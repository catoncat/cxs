import { listSessions, withReadDb } from "../db";
import type { SessionListEntry, SessionListQuery } from "../types";
import { buildCoverageStatus } from "./coverage";

export function listSessionSummaries(
  dbPath: string,
  query: SessionListQuery,
): { query: SessionListQuery; results: SessionListEntry[]; coverage: ReturnType<typeof buildCoverageStatus> } {
  return withReadDb(dbPath, (db) => {
    const results = listSessions(db, query);
    return { query, results, coverage: buildCoverageStatus(db, query.selector ?? null) };
  });
}
