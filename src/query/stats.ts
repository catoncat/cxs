import { statSync } from "node:fs";
import { getStatsCounts, getTopCwds, listCoverageRecords, withReadDb } from "../db";
import { INDEX_VERSION } from "../env";
import type { StatsSummary } from "../types";

export function collectStats(dbPath: string): StatsSummary {
  const { counts, topCwds, coverage } = withReadDb(dbPath, (db) => ({
    counts: getStatsCounts(db),
    topCwds: getTopCwds(db, 10),
    coverage: listCoverageRecords(db),
  }));

  let dbSizeBytes = 0;
  try {
    dbSizeBytes = statSync(dbPath).size;
  } catch {
    dbSizeBytes = 0;
  }

  return {
    sessionCount: counts.sessionCount,
    messageCount: counts.messageCount,
    earliestStartedAt: counts.earliestStartedAt,
    latestEndedAt: counts.latestEndedAt,
    topCwds,
    indexVersion: INDEX_VERSION,
    dbPath,
    dbSizeBytes,
    lastSyncAt: counts.lastSyncAt,
    coverage,
  };
}
