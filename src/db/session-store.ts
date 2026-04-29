import { tokenizedText } from "../tokenize";
import type { ParsedSession, SessionRecord } from "../types";
import type { Db } from "./shared";
import { sessionRootFromFile } from "./sql";

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

export function deleteSessionByUuid(db: Db, sessionUuid: string): void {
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
