import { INDEX_VERSION } from "../env";
import { selectorImplies, selectorStorageKey } from "../selector";
import type { CoverageRecord, Selector, SessionRecord } from "../types";
import { deleteSessionByUuid } from "./session-store";
import type { Db } from "./shared";
import { selectorWhereSql, sessionRootFromFile, tableExists } from "./sql";

export function replaceCoverage(
  db: Db,
  selector: Selector,
  sourceFingerprint: string,
  sourceFileCount: number,
  indexedSessionCount: number,
  indexVersion: string,
): CoverageRecord {
  const key = selectorStorageKey(selector);
  const stmt = db.prepare(`
    INSERT INTO coverage (
      selector_key, selector_json, selector_kind, root, cwd, from_date, to_date,
      source_fingerprint, source_file_count, indexed_session_count, index_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(selector_key) DO UPDATE SET
      selector_json = excluded.selector_json,
      selector_kind = excluded.selector_kind,
      root = excluded.root,
      cwd = excluded.cwd,
      from_date = excluded.from_date,
      to_date = excluded.to_date,
      source_fingerprint = excluded.source_fingerprint,
      source_file_count = excluded.source_file_count,
      indexed_session_count = excluded.indexed_session_count,
      completed_at = CURRENT_TIMESTAMP,
      index_version = excluded.index_version
  `);
  stmt.run(
    key,
    JSON.stringify(selector),
    selector.kind,
    selector.root,
    "cwd" in selector ? selector.cwd : null,
    "fromDate" in selector ? selector.fromDate : null,
    "toDate" in selector ? selector.toDate : null,
    sourceFingerprint,
    sourceFileCount,
    indexedSessionCount,
    indexVersion,
  );
  return getCoverageRecordByKey(db, key)!;
}

export function listCoverageRecords(db: Db): CoverageRecord[] {
  if (!tableExists(db, "coverage")) return [];
  const rows = db.prepare("SELECT * FROM coverage ORDER BY completed_at DESC, id DESC").all() as CoverageRow[];
  return rows.map(rowToCoverageRecord);
}

export function coverageStatusForSelector(db: Db, requested: Selector | null): {
  complete: boolean;
  coveringSelectors: CoverageRecord[];
} {
  if (!requested) return { complete: false, coveringSelectors: [] };
  const entries = listCoverageRecords(db).filter((entry) =>
    entry.indexVersion === requestedIndexVersion(db) && selectorImplies(entry.selector, requested)
  );
  return {
    complete: entries.length > 0,
    coveringSelectors: entries,
  };
}

export function countSessionsForSelector(db: Db, selector: Selector): number {
  const where = selectorWhereSql(selector, "sessions");
  const row = db
    .prepare<typeof where.params, { count: number }>(`
      SELECT COUNT(*) AS count
      FROM sessions
      WHERE ${where.conditions.join(" AND ")}
    `)
    .get(...where.params) as { count: number };
  return row.count;
}

export function deleteSessionsForSelectorExceptFilePaths(
  db: Db,
  selector: Selector,
  retainedFilePaths: Set<string>,
): number {
  const where = selectorWhereSql(selector, "sessions");
  const params = [...where.params];
  const retained = [...retainedFilePaths];
  const retainedClause = retained.length > 0
    ? ` AND sessions.file_path NOT IN (${retained.map(() => "?").join(", ")})`
    : "";
  params.push(...retained);
  const rows = db
    .prepare(`
      SELECT session_uuid AS sessionUuid
      FROM sessions
      WHERE ${where.conditions.join(" AND ")}${retainedClause}
    `)
    .all(...params) as Array<{ sessionUuid: string }>;

  for (const row of rows) {
    deleteSessionByUuid(db, row.sessionUuid);
  }
  return rows.length;
}

export function coverageEntriesForSession(db: Db, session: SessionRecord): CoverageRecord[] {
  const root = session.sourceRoot || sessionRootFromFile(session.filePath);
  const sessionSelectors: Selector[] = [
    { kind: "all", root },
    { kind: "cwd", root, cwd: session.cwd },
  ];
  if (session.pathDate) {
    sessionSelectors.push({
      kind: "date_range",
      root,
      fromDate: session.pathDate,
      toDate: session.pathDate,
    });
    sessionSelectors.push({
      kind: "cwd_date_range",
      root,
      cwd: session.cwd,
      fromDate: session.pathDate,
      toDate: session.pathDate,
    });
  }
  return listCoverageRecords(db).filter((entry) =>
    sessionSelectors.some((selector) => selectorImplies(entry.selector, selector))
  );
}

type CoverageRow = {
  id: number;
  selector_json: string;
  source_fingerprint: string;
  source_file_count: number;
  indexed_session_count: number;
  completed_at: string;
  index_version: string;
};

function getCoverageRecordByKey(db: Db, key: string): CoverageRecord | null {
  const row = db.prepare<[string], CoverageRow>("SELECT * FROM coverage WHERE selector_key = ? LIMIT 1").get(key);
  return row ? rowToCoverageRecord(row) : null;
}

function rowToCoverageRecord(row: CoverageRow): CoverageRecord {
  return {
    id: row.id,
    selector: JSON.parse(row.selector_json) as Selector,
    sourceFingerprint: row.source_fingerprint,
    sourceFileCount: row.source_file_count,
    indexedSessionCount: row.indexed_session_count,
    completedAt: row.completed_at,
    indexVersion: row.index_version,
  };
}

function requestedIndexVersion(_db: Db): string {
  // Kept as a function so coverage matching has one place for future index
  // compatibility policy; current policy is exact index version equality.
  return INDEX_VERSION;
}
