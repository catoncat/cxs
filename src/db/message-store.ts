import type { MessageRecord } from "../types";
import type { Db } from "./shared";

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
