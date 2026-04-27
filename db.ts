import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import { tokenizedText } from "./tokenize";
import type {
  CwdCount,
  MessageRecord,
  ParsedSession,
  SessionListEntry,
  SessionListQuery,
  SessionRecord,
} from "./types";

const CUSTOM_SQLITE = "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib";
const BUSY_TIMEOUT_MS = 5000;
type SqlParams = SQLQueryBindings[];

if (existsSync(CUSTOM_SQLITE)) {
  Database.setCustomSQLite(CUSTOM_SQLITE);
}

export function openReadDb(dbPath: string): Database {
  if (!existsSync(dbPath)) {
    throw new Error(`index not found: ${dbPath}; run cxs sync first`);
  }

  const db = new Database(dbPath, { readonly: true });
  db.run(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
  db.run("PRAGMA query_only=ON");
  db.run("PRAGMA temp_store=MEMORY");
  return db;
}

export function openWriteDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.run(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA synchronous=NORMAL");
  db.run("PRAGMA temp_store=MEMORY");
  db.run("PRAGMA foreign_keys=ON");
  ensureSchema(db);
  return db;
}

function ensureSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_uuid TEXT NOT NULL UNIQUE,
      file_path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL DEFAULT '',
      summary_text TEXT NOT NULL DEFAULT '',
      compact_text TEXT NOT NULL DEFAULT '',
      reasoning_summary_text TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
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

  db.run(`
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

  db.run("CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_uuid, seq)");
  db.run("CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at DESC)");

  db.run(`
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

  dropLegacyTrigramTable(db);
}

function dropLegacyTrigramTable(db: Database): void {
  // cxs <= v2 shipped a second FTS5 virtual table for CJK trigram search.
  // The hybrid bigram+Segmenter tokenizer in tokenize.ts replaces it, so
  // drop the old table and its shadow rows if they still exist.
  db.run("DROP TABLE IF EXISTS messages_fts_trigram");
}

function ensureSessionsFtsTable(db: Database): void {
  const existing = db
    .query("SELECT 1 FROM sqlite_master WHERE name = 'sessions_fts' LIMIT 1")
    .get();

  if (existing) {
    const columns = db
      .query("PRAGMA table_info(sessions_fts)")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("compact_text") || !names.has("reasoning_summary_text")) {
      db.run("DROP TABLE sessions_fts");
    }
  }

  db.run(`
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
  db: Database,
  filePath: string,
): { rawFileMtime: number; rawFileSize: number; indexVersion: string } | null {
  const row = db
    .query<{ rawFileMtime: number; rawFileSize: number; indexVersion: string }, [string]>(`
      SELECT raw_file_mtime AS rawFileMtime, raw_file_size AS rawFileSize, index_version AS indexVersion
      FROM sessions
      WHERE file_path = ?
      LIMIT 1
    `)
    .get(filePath) as
    | { rawFileMtime: number; rawFileSize: number; indexVersion: string }
    | null;

  return row ?? null;
}

export function deleteSessionByFilePath(db: Database, filePath: string): void {
  const row = db
    .query<{ sessionUuid: string }, [string]>("SELECT session_uuid AS sessionUuid FROM sessions WHERE file_path = ? LIMIT 1")
    .get(filePath) as { sessionUuid: string } | null;

  if (!row) return;
  deleteSessionByUuid(db, row.sessionUuid);
}

function deleteSessionByUuid(db: Database, sessionUuid: string): void {
  db.run("DELETE FROM sessions_fts WHERE session_uuid = ?", [sessionUuid]);
  db.run("DELETE FROM messages_fts WHERE session_uuid = ?", [sessionUuid]);
  db.run("DELETE FROM messages WHERE session_uuid = ?", [sessionUuid]);
  db.run("DELETE FROM sessions WHERE session_uuid = ?", [sessionUuid]);
}

export function replaceSession(
  db: Database,
  session: ParsedSession,
  rawFileMtime: number,
  rawFileSize: number,
  indexVersion: string,
): void {
  const tx = db.transaction(() => {
    const existing = db
      .query<{ id: number }, [string, string]>("SELECT id FROM sessions WHERE session_uuid = ? OR file_path = ? LIMIT 1")
      .get(session.sessionUuid, session.filePath) as { id: number } | null;

    if (existing) {
      db.run(
        `
          UPDATE sessions
          SET session_uuid = ?, file_path = ?, title = ?, summary_text = ?, compact_text = ?, reasoning_summary_text = ?,
              cwd = ?, model = ?, started_at = ?, ended_at = ?,
              message_count = ?, raw_file_mtime = ?, raw_file_size = ?, index_version = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
        [
          session.sessionUuid,
          session.filePath,
          session.title,
          session.summaryText,
          session.compactText ?? "",
          session.reasoningSummaryText ?? "",
          session.cwd,
          session.model,
          session.startedAt,
          session.endedAt,
          session.messages.length,
          rawFileMtime,
          rawFileSize,
          indexVersion,
          existing.id,
        ],
      );
    } else {
      db.run(
        `
          INSERT INTO sessions (
            session_uuid, file_path, title, summary_text, compact_text, reasoning_summary_text,
            cwd, model, started_at, ended_at,
            message_count, raw_file_mtime, raw_file_size, index_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          session.sessionUuid,
          session.filePath,
          session.title,
          session.summaryText,
          session.compactText ?? "",
          session.reasoningSummaryText ?? "",
          session.cwd,
          session.model,
          session.startedAt,
          session.endedAt,
          session.messages.length,
          rawFileMtime,
          rawFileSize,
          indexVersion,
        ],
      );
    }

    const sessionRow = db
      .query<{ id: number }, [string]>("SELECT id FROM sessions WHERE session_uuid = ? LIMIT 1")
      .get(session.sessionUuid) as { id: number };

    db.run("DELETE FROM messages_fts WHERE session_uuid = ?", [session.sessionUuid]);
    db.run("DELETE FROM messages WHERE session_uuid = ?", [session.sessionUuid]);
    db.run("DELETE FROM sessions_fts WHERE rowid = ? OR session_uuid = ?", [sessionRow.id, session.sessionUuid]);

    db.run(
      `
        INSERT INTO sessions_fts(rowid, title, summary_text, compact_text, reasoning_summary_text, session_uuid)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        sessionRow.id,
        tokenizedText(session.title),
        tokenizedText(session.summaryText),
        tokenizedText(session.compactText ?? ""),
        tokenizedText(session.reasoningSummaryText ?? ""),
        session.sessionUuid,
      ],
    );

    const messageStmt = db.prepare<unknown, [number, string, number, string, string, string, string]>(`
      INSERT INTO messages (session_id, session_uuid, seq, role, content_text, timestamp, source_kind)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const ftsStmt = db.prepare<unknown, [number, string, string, number, string, string]>(`
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

export function getSessionRecord(db: Database, sessionUuid: string): SessionRecord | null {
  const row = db
    .query<SessionRecord & { filePath: string }, [string]>(`
      SELECT
        session_uuid AS sessionUuid,
        file_path AS filePath,
        title,
        summary_text AS summaryText,
        cwd,
        model,
        started_at AS startedAt,
        ended_at AS endedAt,
        message_count AS messageCount
      FROM sessions
      WHERE session_uuid = ?
      LIMIT 1
    `)
    .get(sessionUuid) as (SessionRecord & { filePath: string }) | null;

  if (!row) return null;
  return row;
}

function ensureTextColumn(db: Database, tableName: string, columnName: string): void {
  const columns = db
    .query(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name?: string }>;

  if (columns.some((column) => column.name === columnName)) return;
  db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} TEXT NOT NULL DEFAULT ''`);
}

export function getMessagesForRange(
  db: Database,
  sessionUuid: string,
  startSeq: number,
  endSeq: number,
): MessageRecord[] {
  return db
    .query<MessageRecord, [string, number, number]>(`
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
  db: Database,
  sessionUuid: string,
  offset: number,
  limit: number,
): MessageRecord[] {
  return db
    .query<MessageRecord, [string, number, number]>(`
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

export function listSessions(db: Database, query: SessionListQuery): SessionListEntry[] {
  const conditions: string[] = [];
  const params: SqlParams = [];
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
    .query<SessionListEntry, typeof params>(`
      SELECT
        session_uuid AS sessionUuid,
        title,
        summary_text AS summaryText,
        cwd,
        started_at AS startedAt,
        ended_at AS endedAt,
        message_count AS messageCount
      FROM sessions
      ${where}
      ORDER BY ${orderColumn} DESC
      LIMIT ?
    `)
    .all(...params) as SessionListEntry[];
}

export function getStatsCounts(db: Database): {
  sessionCount: number;
  messageCount: number;
  earliestStartedAt: string | null;
  latestEndedAt: string | null;
  lastSyncAt: string | null;
} {
  const row = db
    .query(`
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

export function getTopCwds(db: Database, limit: number): CwdCount[] {
  return db
    .query<CwdCount, [number]>(`
      SELECT cwd, COUNT(*) AS count
      FROM sessions
      WHERE cwd != ''
      GROUP BY cwd
      ORDER BY count DESC, cwd ASC
      LIMIT ?
    `)
    .all(limit) as CwdCount[];
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
