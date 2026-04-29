import { coverageEntriesForSession, getMessagesForPage, getMessagesForRange, getSessionRecord, withReadDb } from "../db";
import { rerankHits } from "../ranking";
import type { FindResult, SessionRecord } from "../types";
import type { Db } from "../db";
import { searchMessageHits } from "./search";

export function getMessageRange(
  dbPath: string,
  sessionUuid: string,
  options: { seq?: number; query?: string; before: number; after: number },
): {
  session: SessionRecord;
  anchorSeq: number;
  rangeStartSeq: number;
  rangeEndSeq: number;
  messages: ReturnType<typeof getMessagesForRange>;
  coverage: { entries: ReturnType<typeof coverageEntriesForSession> };
} {
  return withReadDb(dbPath, (db) => {
    const anchorSeq = resolveAnchorSeq(db, sessionUuid, options.seq, options.query);
    const session = getSessionRecord(db, sessionUuid);
    if (!session) throw new Error(`session not found: ${sessionUuid}`);

    const rangeStartSeq = Math.max(0, anchorSeq - options.before);
    const rangeEndSeq = anchorSeq + options.after;
    const messages = getMessagesForRange(db, sessionUuid, rangeStartSeq, rangeEndSeq);
    return {
      session,
      anchorSeq,
      rangeStartSeq,
      rangeEndSeq,
      messages,
      coverage: { entries: coverageEntriesForSession(db, session) },
    };
  });
}

export function getMessagePage(
  dbPath: string,
  sessionUuid: string,
  offset: number,
  limit: number,
): {
  session: SessionRecord;
  offset: number;
  limit: number;
  totalCount: number;
  hasMore: boolean;
  messages: ReturnType<typeof getMessagesForPage>;
  coverage: { entries: ReturnType<typeof coverageEntriesForSession> };
} {
  return withReadDb(dbPath, (db) => {
    const session = getSessionRecord(db, sessionUuid);
    if (!session) throw new Error(`session not found: ${sessionUuid}`);
    const messages = getMessagesForPage(db, sessionUuid, offset, limit);
    const totalCount = session.messageCount;
    const hasMore = offset + messages.length < totalCount;
    return {
      session,
      offset,
      limit,
      totalCount,
      hasMore,
      messages,
      coverage: { entries: coverageEntriesForSession(db, session) },
    };
  });
}

function resolveAnchorSeq(
  db: Db,
  sessionUuid: string,
  seq?: number,
  query?: string,
): number {
  if (typeof seq === "number") {
    return seq;
  }

  if (query) {
    const best = searchTopHitInSession(db, sessionUuid, query);
    if (best && typeof best.matchSeq === "number") return best.matchSeq;
  }

  throw new Error("read-range requires explicit session_uuid plus either --seq or --query");
}

function searchTopHitInSession(db: Db, sessionUuid: string, query: string): FindResult | null {
  const rows = searchMessageHits(db, query, 20, sessionUuid);
  const result = rerankHits(rows, query, 1)[0];
  return result ?? null;
}
