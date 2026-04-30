import { existsSync, statSync } from "node:fs";
import { collectSourceInventory, collectSourceSnapshot } from "./source-inventory";
import { INDEX_VERSION, DEFAULT_DB_PATH, resolveCodexDir } from "./env";
import { getStatsCounts, listCoverageRecords, withReadDb } from "./db";
import { selectorImplies } from "./selector";
import type { CoverageInventoryStatus, CoverageRecord, RequestedCoverageStatus, Selector, StatusSummary } from "./types";

export function collectStatus(options: { rootDir?: string; dbPath?: string; cwd?: string; selector?: Selector } = {}): StatusSummary {
  const root = resolveCodexDir(options.rootDir);
  const dbPath = options.dbPath ?? DEFAULT_DB_PATH;
  const sourceInventory = collectSourceInventory(root);
  const index = collectIndexStatus(dbPath);
  const coverage = existsSync(dbPath) ? withReadDb(dbPath, (db) => listCoverageRecords(db)) : [];
  const coverageStatus = coverage.map(toCoverageInventoryStatus);
  const summary: StatusSummary = {
    context: {
      cwd: options.cwd ?? process.cwd(),
      root,
      dbPath,
      indexVersion: INDEX_VERSION,
    },
    sourceInventory,
    index,
    coverage: coverageStatus,
  };
  if (options.selector) {
    summary.requestedCoverage = requestedCoverageStatus(options.selector, coverageStatus);
  }
  return summary;
}

function collectIndexStatus(dbPath: string): StatusSummary["index"] {
  if (!existsSync(dbPath)) {
    return {
      exists: false,
      sessionCount: 0,
      messageCount: 0,
      earliestStartedAt: null,
      latestEndedAt: null,
      dbSizeBytes: 0,
      lastSyncAt: null,
    };
  }

  const counts = withReadDb(dbPath, (db) => getStatsCounts(db));
  let dbSizeBytes = 0;
  try {
    dbSizeBytes = statSync(dbPath).size;
  } catch {
    dbSizeBytes = 0;
  }

  return {
    exists: true,
    sessionCount: counts.sessionCount,
    messageCount: counts.messageCount,
    earliestStartedAt: counts.earliestStartedAt,
    latestEndedAt: counts.latestEndedAt,
    dbSizeBytes,
    lastSyncAt: counts.lastSyncAt,
  };
}

function toCoverageInventoryStatus(record: CoverageRecord): CoverageInventoryStatus {
  const snapshot = collectSourceSnapshot(record.selector);
  const fresh = snapshot.fingerprint === record.sourceFingerprint
    && snapshot.fileCount === record.sourceFileCount
    && record.indexVersion === INDEX_VERSION;
  return {
    ...record,
    freshness: fresh ? "fresh" : "stale",
    currentSourceFingerprint: snapshot.fingerprint,
    currentSourceFileCount: snapshot.fileCount,
  };
}

function requestedCoverageStatus(
  selector: Selector,
  coverage: CoverageInventoryStatus[],
): RequestedCoverageStatus {
  const snapshot = collectSourceSnapshot(selector);
  const coveringSelectors = coverage.filter((entry) =>
    entry.indexVersion === INDEX_VERSION && selectorImplies(entry.selector, selector)
  );
  const hasFreshCovering = coveringSelectors.some((entry) => entry.freshness === "fresh");
  const freshness: RequestedCoverageStatus["freshness"] = hasFreshCovering
    ? "fresh"
    : coveringSelectors.length > 0
      ? "stale"
      : "missing";
  return {
    requested: snapshot.selector,
    complete: freshness === "fresh",
    freshness,
    sourceFingerprint: snapshot.fingerprint,
    sourceFileCount: snapshot.fileCount,
    coveringSelectors,
    recommendedAction: freshness === "fresh" ? "query" : "sync",
  };
}
