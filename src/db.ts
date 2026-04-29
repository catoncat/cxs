import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { tokenizedText } from "./tokenize";
import { INDEX_VERSION } from "./env";
import type {
  CoverageRecord,
  CwdCount,
  MessageRecord,
  ParsedSession,
  Selector,
  SessionListEntry,
  SessionListQuery,
  SessionRecord,
} from "./types";
import { selectorImplies, selectorStorageKey } from "./selector";

type Db = Database.Database;
type SqlParams = unknown[];

const BUSY_TIMEOUT_MS = 5000;

export class IndexUnavailableError extends Error {
  constructor(public readonly dbPath: string) {
    super(`index not found: ${dbPath}`);
    this.name = "IndexUnavailableError";
  }
}

export function openReadDb(dbPath: string): Db {
  if (!existsSync(dbPath)) {
    throw new IndexUnavailableError(dbPath);
  }

  const db = new Database(dbPath, { readonly: true });
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.pragma("query_only = ON");
  db.pragma("temp_store = MEMORY");
  return db;
}

// Why: callers used to do `const db = openReadDb(...); ... db.close();` which
// leaks the connection if work in between throws. Wrapping in try/finally at
// every callsite is noise — fold it once.
export function withReadDb<T>(dbPath: string, fn: (db: Db) => T): T {
  const db = openReadDb(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function openWriteDb(dbPath: string): Db {
  const db = new Database(dbPath);
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("temp_store = MEMORY");
  db.pragma("foreign_keys = ON");
  ensureSchema(db);
  return db;
}

function ensureSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_uuid TEXT NOT NULL UNIQUE,
      file_path TEXT NOT NULL UNIQUE,
      source_root TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      summary_text TEXT NOT NULL DEFAULT '',
      compact_text TEXT NOT NULL DEFAULT '',
      reasoning_summary_text TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      path_date TEXT NOT NULL DEFAULT '',
      message_count INTEGER NOT NULL DEFAULT 0,
      raw_file_mtime INTEGER NOT NULL DEFAULT 0,
      raw_file_size INTEGER NOT NULL DEFAULT 0,
      index_version TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  ensureTextColumn(db, "sessions", "summary_text");
  ensureTextColumn(db, "sessions", "compact_text");
  ensureTextColumn(db, "sessions", "reasoning_summary_text");
  ensureTextColumn(db, "sessions", "path_date");
  ensureTextColumn(db, "sessions", "source_root");

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      session_uuid TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content_text TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      UNIQUE(session_uuid, seq)
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_uuid, seq)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at DESC)");

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content_text,
      session_uuid UNINDEXED,
      seq UNINDEXED,
      role UNINDEXED,
      timestamp UNINDEXED,
      tokenize='unicode61 remove_diacritics 1'
    )
  `);

  ensureSessionsFtsTable(db);
  ensureCoverageTable(db);

  dropLegacyTrigramTable(db);
}

function ensureCoverageTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS coverage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      selector_key TEXT NOT NULL UNIQUE,
      selector_json TEXT NOT NULL,
      selector_kind TEXT NOT NULL,
      root TEXT NOT NULL,
      cwd TEXT,
      from_date TEXT,
      to_date TEXT,
      source_fingerprint TEXT NOT NULL,
      source_file_count INTEGER NOT NULL,
      indexed_session_count INTEGER NOT NULL,
      completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      index_version TEXT NOT NULL
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_coverage_root ON coverage(root)");
}

function dropLegacyTrigramTable(db: Db): void {
  // cxs <= v2 shipped a second FTS5 virtual table for CJK trigram search.
  // The hybrid bigram+Segmenter tokenizer in tokenize.ts replaces it, so
  // drop the old table and its shadow rows if they still exist.
  db.exec("DROP TABLE IF EXISTS messages_fts_trigram");
}

function ensureSessionsFtsTable(db: Db): void {
  const existing = db
    .prepare("SELECT 1 FROM sqlite_master WHERE name = 'sessions_fts' LIMIT 1")
    .get();

  if (existing) {
    const columns = db
      .prepare("PRAGMA table_info(sessions_fts)")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("compact_text") || !names.has("reasoning_summary_text")) {
      db.exec("DROP TABLE sessions_fts");
    }
  }

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
      title,
      summary_text,
      compact_text,
      reasoning_summary_text,
      session_uuid UNINDEXED,
      tokenize='unicode61 remove_diacritics 1'
    )
  `);
}

export function getIndexedSessionMeta(
  db: Db,
  filePath: string,
): { rawFileMtime: number; rawFileSize: number; indexVersion: string } | null {
  const row = db
    .prepare<[string], { rawFileMtime: number; rawFileSize: number; indexVersion: string }>(`
      SELECT raw_file_mtime AS rawFileMtime, raw_file_size AS rawFileSize, index_version AS indexVersion
      FROM sessions
      WHERE file_path = ?
      LIMIT 1
    `)
    .get(filePath) as
    | { rawFileMtime: number; rawFileSize: number; indexVersion: string }
    | undefined;

  return row ?? null;
}

export function deleteSessionByFilePath(db: Db, filePath: string): void {
  const row = db
    .prepare<[string], { sessionUuid: string }>("SELECT session_uuid AS sessionUuid FROM sessions WHERE file_path = ? LIMIT 1")
    .get(filePath) as { sessionUuid: string } | undefined;

  if (!row) return;
  deleteSessionByUuid(db, row.sessionUuid);
}

function deleteSessionByUuid(db: Db, sessionUuid: string): void {
  db.prepare("DELETE FROM sessions_fts WHERE session_uuid = ?").run(sessionUuid);
  db.prepare("DELETE FROM messages_fts WHERE session_uuid = ?").run(sessionUuid);
  db.prepare("DELETE FROM messages WHERE session_uuid = ?").run(sessionUuid);
  db.prepare("DELETE FROM sessions WHERE session_uuid = ?").run(sessionUuid);
}

export function replaceSession(
  db: Db,
  session: ParsedSession,
  rawFileMtime: number,
  rawFileSize: number,
  indexVersion: string,
  pathDate: string,
  sourceRoot = sessionRootFromFile(session.filePath),
): void {
  const tx = db.transaction(() => {
    const existing = db
      .prepare<[string, string], { id: number }>("SELECT id FROM sessions WHERE session_uuid = ? OR file_path = ? LIMIT 1")
      .get(session.sessionUuid, session.filePath) as { id: number } | undefined;

    if (existing) {
      db.prepare(
        `
          UPDATE sessions
          SET session_uuid = ?, file_path = ?, source_root = ?, title = ?, summary_text = ?, compact_text = ?, reasoning_summary_text = ?,
              cwd = ?, model = ?, started_at = ?, ended_at = ?, path_date = ?,
              message_count = ?, raw_file_mtime = ?, raw_file_size = ?, index_version = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
      ).run(
        session.sessionUuid,
        session.filePath,
        sourceRoot,
        session.title,
        session.summaryText,
        session.compactText ?? "",
        session.reasoningSummaryText ?? "",
        session.cwd,
        session.model,
        session.startedAt,
        session.endedAt,
        pathDate,
        session.messages.length,
        rawFileMtime,
        rawFileSize,
        indexVersion,
        existing.id,
      );
    } else {
      db.prepare(
        `
          INSERT INTO sessions (
            session_uuid, file_path, source_root, title, summary_text, compact_text, reasoning_summary_text,
            cwd, model, started_at, ended_at, path_date,
            message_count, raw_file_mtime, raw_file_size, index_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        session.sessionUuid,
        session.filePath,
        sourceRoot,
        session.title,
        session.summaryText,
        session.compactText ?? "",
        session.reasoningSummaryText ?? "",
        session.cwd,
        session.model,
        session.startedAt,
        session.endedAt,
        pathDate,
        session.messages.length,
        rawFileMtime,
        rawFileSize,
        indexVersion,
      );
    }

    const sessionRow = db
      .prepare<[string], { id: number }>("SELECT id FROM sessions WHERE session_uuid = ? LIMIT 1")
      .get(session.sessionUuid) as { id: number };

    db.prepare("DELETE FROM messages_fts WHERE session_uuid = ?").run(session.sessionUuid);
    db.prepare("DELETE FROM messages WHERE session_uuid = ?").run(session.sessionUuid);
    db.prepare("DELETE FROM sessions_fts WHERE rowid = ? OR session_uuid = ?").run(sessionRow.id, session.sessionUuid);

    db.prepare(
      `
        INSERT INTO sessions_fts(rowid, title, summary_text, compact_text, reasoning_summary_text, session_uuid)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
    ).run(
      sessionRow.id,
      tokenizedText(session.title),
      tokenizedText(session.summaryText),
      tokenizedText(session.compactText ?? ""),
      tokenizedText(session.reasoningSummaryText ?? ""),
      session.sessionUuid,
    );

    const messageStmt = db.prepare<[number, string, number, string, string, string, string]>(`
      INSERT INTO messages (session_id, session_uuid, seq, role, content_text, timestamp, source_kind)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const ftsStmt = db.prepare<[number, string, string, number, string, string]>(`
      INSERT INTO messages_fts(rowid, content_text, session_uuid, seq, role, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const message of session.messages) {
      const result = messageStmt.run(
        sessionRow.id,
        session.sessionUuid,
        message.seq,
        message.role,
        message.contentText,
        message.timestamp,
        message.sourceKind,
      );
      const messageId = Number(result.lastInsertRowid);
      // Feed the FTS index with tokenized text so that CJK runs are split
      // into bigrams by tokenize(). Stored content in messages.content_text
      // stays raw for display.
      ftsStmt.run(
        messageId,
        tokenizedText(message.contentText),
        session.sessionUuid,
        message.seq,
        message.role,
        message.timestamp,
      );
    }
  });

  tx();
}

export function getSessionRecord(db: Db, sessionUuid: string): SessionRecord | null {
  const row = db
    .prepare<[string], SessionRecord & { filePath: string }>(`
      SELECT
        session_uuid AS sessionUuid,
        file_path AS filePath,
        source_root AS sourceRoot,
        title,
        summary_text AS summaryText,
        cwd,
        model,
        started_at AS startedAt,
        ended_at AS endedAt,
        path_date AS pathDate,
        message_count AS messageCount
      FROM sessions
      WHERE session_uuid = ?
      LIMIT 1
    `)
    .get(sessionUuid) as (SessionRecord & { filePath: string }) | undefined;

  if (!row) return null;
  return row;
}

function ensureTextColumn(db: Db, tableName: string, columnName: string): void {
  const columns = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name?: string }>;

  if (columns.some((column) => column.name === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} TEXT NOT NULL DEFAULT ''`);
}

export function getMessagesForRange(
  db: Db,
  sessionUuid: string,
  startSeq: number,
  endSeq: number,
): MessageRecord[] {
  return db
    .prepare<[string, number, number], MessageRecord>(`
      SELECT
        session_uuid AS sessionUuid,
        seq,
        role,
        content_text AS contentText,
        timestamp,
        source_kind AS sourceKind
      FROM messages
      WHERE session_uuid = ? AND seq BETWEEN ? AND ?
      ORDER BY seq
    `)
    .all(sessionUuid, startSeq, endSeq) as MessageRecord[];
}

export function getMessagesForPage(
  db: Db,
  sessionUuid: string,
  offset: number,
  limit: number,
): MessageRecord[] {
  return db
    .prepare<[string, number, number], MessageRecord>(`
      SELECT
        session_uuid AS sessionUuid,
        seq,
        role,
        content_text AS contentText,
        timestamp,
        source_kind AS sourceKind
      FROM messages
      WHERE session_uuid = ?
      ORDER BY seq
      LIMIT ? OFFSET ?
    `)
    .all(sessionUuid, limit, offset) as MessageRecord[];
}

export function listSessions(db: Db, query: SessionListQuery): SessionListEntry[] {
  const conditions: string[] = [];
  const params: SqlParams = [];
  if (query.selector) {
    const selectorWhere = selectorWhereSql(query.selector, "sessions");
    conditions.push(...selectorWhere.conditions);
    params.push(...selectorWhere.params);
  }
  if (query.cwd) {
    // Substring match rather than prefix/equality: agent callers often pass
    // the trailing segment of a project path, not the full canonical path.
    conditions.push("lower(cwd) LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(query.cwd.toLowerCase())}%`);
  }
  if (query.since) {
    conditions.push("ended_at >= ?");
    params.push(query.since);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const orderColumn = query.sort === "started"
    ? "started_at"
    : query.sort === "messages"
      ? "message_count"
      : "ended_at";

  params.push(query.limit);

  return db
    .prepare<typeof params, SessionListEntry>(`
      SELECT
        session_uuid AS sessionUuid,
        title,
        summary_text AS summaryText,
        cwd,
        started_at AS startedAt,
        ended_at AS endedAt,
        path_date AS pathDate,
        message_count AS messageCount
      FROM sessions
      ${where}
      ORDER BY ${orderColumn} DESC
      LIMIT ?
    `)
    .all(...params) as SessionListEntry[];
}

export function getStatsCounts(db: Db): {
  sessionCount: number;
  messageCount: number;
  earliestStartedAt: string | null;
  latestEndedAt: string | null;
  lastSyncAt: string | null;
} {
  const row = db
    .prepare(`
      SELECT
        COUNT(*) AS sessionCount,
        COALESCE(SUM(message_count), 0) AS messageCount,
        MIN(started_at) AS earliestStartedAt,
        MAX(ended_at) AS latestEndedAt,
        MAX(updated_at) AS lastSyncAt
      FROM sessions
    `)
    .get() as {
      sessionCount: number;
      messageCount: number;
      earliestStartedAt: string | null;
      latestEndedAt: string | null;
      lastSyncAt: string | null;
    };
  return row;
}

export function getTopCwds(db: Db, limit: number): CwdCount[] {
  return db
    .prepare<[number], CwdCount>(`
      SELECT cwd, COUNT(*) AS count
      FROM sessions
      WHERE cwd != ''
      GROUP BY cwd
      ORDER BY count DESC, cwd ASC
      LIMIT ?
    `)
    .all(limit) as CwdCount[];
}

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

export function selectorWhereSql(selector: Selector, alias: string): { conditions: string[]; params: SqlParams } {
  const conditions = [`(${alias}.file_path = ? OR ${alias}.file_path LIKE ? ESCAPE '\\')`];
  const params: SqlParams = [selector.root, `${escapeLike(selector.root)}/%`];
  if (selector.kind === "cwd" || selector.kind === "cwd_date_range") {
    conditions.push(`${alias}.cwd = ?`);
    params.push(selector.cwd);
  }
  if (selector.kind === "date_range" || selector.kind === "cwd_date_range") {
    conditions.push(`${alias}.path_date >= ?`);
    conditions.push(`${alias}.path_date <= ?`);
    params.push(selector.fromDate, selector.toDate);
  }
  return { conditions, params };
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

function tableExists(db: Db, tableName: string): boolean {
  const row = db.prepare<[string], unknown>("SELECT 1 FROM sqlite_master WHERE name = ? LIMIT 1").get(tableName);
  return Boolean(row);
}

function requestedIndexVersion(_db: Db): string {
  // Kept as a function so coverage matching has one place for future index
  // compatibility policy; current policy is exact index version equality.
  return INDEX_VERSION;
}

function sessionRootFromFile(filePath: string): string {
  const marker = "/sessions/";
  const index = filePath.indexOf(marker);
  if (index >= 0) return filePath.slice(0, index + marker.length - 1);
  return filePath.slice(0, Math.max(0, filePath.lastIndexOf("/")));
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
