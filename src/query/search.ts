import { selectorWhereSql } from "../db";
import type { RawHitRow } from "../ranking";
import { hasCjk, queryTerms } from "../tokenize";
import type { Selector } from "../types";
import type { Db, SqlParams } from "../db";
import { makeLikeSnippet, makeRawSnippet } from "./snippet";

export function searchMessageHits(
  db: Db,
  query: string,
  limit: number,
  sessionUuid?: string,
  selector: Selector | null = null,
): RawHitRow[] {
  const normalized = query.trim();
  if (!normalized) return [];

  const terms = queryTerms(normalized);
  // Queries that degenerate to zero tokens (e.g. a single kanji dropped as
  // stop-word-like noise, or whitespace only) cannot hit the FTS index. Fall
  // back to a bounded LIKE scan so single-character CJK probes still work
  // even though they are discouraged.
  if (terms.length === 0) {
    if (hasCjk(normalized)) return searchByLike(db, normalized, limit, sessionUuid, selector);
    return [];
  }

  return searchByFts(db, terms, limit, sessionUuid, selector);
}

export function searchSessionHits(db: Db, query: string, limit: number, selector: Selector | null): RawHitRow[] {
  const normalized = query.trim();
  if (!normalized || !tableExists(db, "sessions_fts")) return [];

  const terms = queryTerms(normalized);
  if (terms.length === 0) {
    if (hasCjk(normalized)) return searchSessionsByLike(db, normalized, limit, selector);
    return [];
  }

  return searchSessionsByFts(db, normalized, terms, limit, selector);
}

function searchByFts(
  db: Db,
  terms: string[],
  limit: number,
  sessionUuid?: string,
  selector: Selector | null = null,
): RawHitRow[] {
  const matchExpr = buildFtsMatch(terms);
  const conditions = [`messages_fts MATCH ?`];
  const params: SqlParams = [matchExpr];

  if (selector) {
    const selectorWhere = selectorWhereSql(selector, "s");
    conditions.push(...selectorWhere.conditions);
    params.push(...selectorWhere.params);
  }
  if (sessionUuid) {
    conditions.push("m.session_uuid = ?");
    params.push(sessionUuid);
  }
  params.push(limit);

  return db
    .prepare<typeof params, RawHitRow>(`
      SELECT
        s.session_uuid AS sessionUuid,
        s.title AS title,
        s.summary_text AS summaryText,
        s.cwd AS cwd,
        s.started_at AS startedAt,
        s.ended_at AS endedAt,
        'message' AS matchSource,
        m.seq AS matchSeq,
        m.role AS matchRole,
        m.timestamp AS matchTimestamp,
        m.content_text AS contentText,
        snippet(messages_fts, 0, '<mark>', '</mark>', '…', 16) AS snippet,
        bm25(messages_fts) AS score
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid
      JOIN sessions s ON s.id = m.session_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY score
      LIMIT ?
    `)
    .all(...params) as RawHitRow[];
}

function searchSessionsByFts(
  db: Db,
  query: string,
  terms: string[],
  limit: number,
  selector: Selector | null,
): RawHitRow[] {
  const matchExpr = buildFtsMatch(terms);
  const conditions = ["sessions_fts MATCH ?"];
  const params: SqlParams = [matchExpr];
  if (selector) {
    const selectorWhere = selectorWhereSql(selector, "s");
    conditions.push(...selectorWhere.conditions);
    params.push(...selectorWhere.params);
  }
  params.push(limit);
  const rows = db
    .prepare<typeof params, RawHitRow>(`
      SELECT
        s.session_uuid AS sessionUuid,
        s.title AS title,
        s.summary_text AS summaryText,
        s.cwd AS cwd,
        s.started_at AS startedAt,
        s.ended_at AS endedAt,
        'session' AS matchSource,
        NULL AS matchSeq,
        'session' AS matchRole,
        NULL AS matchTimestamp,
        s.title || char(10) || s.summary_text || char(10) || s.compact_text || char(10) || s.reasoning_summary_text AS contentText,
        '' AS snippet,
        bm25(sessions_fts, 8.0, 3.0, 4.0, 1.2) AS score
      FROM sessions_fts
      JOIN sessions s ON s.id = sessions_fts.rowid
      WHERE ${conditions.join(" AND ")}
      ORDER BY score
      LIMIT ?
    `)
    .all(...params) as RawHitRow[];

  return rows.map((row) => ({
    ...row,
    snippet: makeRawSnippet(row.contentText, query, terms),
  }));
}

function searchSessionsByLike(
  db: Db,
  query: string,
  limit: number,
  selector: Selector | null,
): RawHitRow[] {
  const like = `%${escapeLike(query.toLowerCase())}%`;
  const conditions = [
    `(
      lower(s.title) LIKE ? ESCAPE '\\'
      OR lower(s.summary_text) LIKE ? ESCAPE '\\'
      OR lower(s.compact_text) LIKE ? ESCAPE '\\'
      OR lower(s.reasoning_summary_text) LIKE ? ESCAPE '\\'
    )`,
  ];
  const params: SqlParams = [like, like, like, like];
  if (selector) {
    const selectorWhere = selectorWhereSql(selector, "s");
    conditions.push(...selectorWhere.conditions);
    params.push(...selectorWhere.params);
  }
  params.push(limit);

  const rows = db
    .prepare<typeof params, RawHitRow & { contentText: string }>(`
      SELECT
        s.session_uuid AS sessionUuid,
        s.title AS title,
        s.summary_text AS summaryText,
        s.cwd AS cwd,
        s.started_at AS startedAt,
        s.ended_at AS endedAt,
        'session' AS matchSource,
        NULL AS matchSeq,
        'session' AS matchRole,
        NULL AS matchTimestamp,
        s.title || char(10) || s.summary_text || char(10) || s.compact_text || char(10) || s.reasoning_summary_text AS contentText
      FROM sessions s
      WHERE ${conditions.join(" AND ")}
      ORDER BY s.started_at DESC
      LIMIT ?
    `)
    .all(...params) as Array<RawHitRow & { contentText: string }>;

  return rows.map((row, index) => ({
    ...row,
    snippet: makeRawSnippet(row.contentText, query, []),
    score: -(index + 1),
  }));
}

function searchByLike(
  db: Db,
  query: string,
  limit: number,
  sessionUuid?: string,
  selector: Selector | null = null,
): RawHitRow[] {
  const conditions = ["lower(m.content_text) LIKE ? ESCAPE '\\'"];
  const params: SqlParams = [`%${escapeLike(query.toLowerCase())}%`];
  if (selector) {
    const selectorWhere = selectorWhereSql(selector, "s");
    conditions.push(...selectorWhere.conditions);
    params.push(...selectorWhere.params);
  }
  if (sessionUuid) {
    conditions.push("m.session_uuid = ?");
    params.push(sessionUuid);
  }
  params.push(limit);

  const rows = db
    .prepare<typeof params, RawHitRow & { contentText: string }>(`
      SELECT
        s.session_uuid AS sessionUuid,
        s.title AS title,
        s.summary_text AS summaryText,
        s.cwd AS cwd,
        s.started_at AS startedAt,
        s.ended_at AS endedAt,
        'message' AS matchSource,
        m.seq AS matchSeq,
        m.role AS matchRole,
        m.timestamp AS matchTimestamp,
        m.content_text AS contentText
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY s.started_at DESC, m.seq ASC
      LIMIT ?
    `)
    .all(...params) as Array<RawHitRow & { contentText: string }>;

  return rows.map((row, index) => ({
    ...row,
    snippet: makeLikeSnippet(row.contentText, query),
    // Negate the ordinal so LIKE rows share the "lower is better" polarity
    // with bm25() scores; downstream rerank sorts on row metrics, but any
    // code that touches this raw score won't see a sign mismatch.
    score: -(index + 1),
  }));
}

function tableExists(db: Db, tableName: string): boolean {
  const row = db
    .prepare<[string], unknown>("SELECT 1 FROM sqlite_master WHERE name = ? LIMIT 1")
    .get(tableName);
  return Boolean(row);
}

/**
 * Build an FTS5 MATCH expression from already-tokenized terms. Each term is
 * quoted and ANDed, giving us intersection semantics across CJK bigrams and
 * non-CJK words alike.
 */
function buildFtsMatch(terms: string[]): string {
  return terms.map(quoteFtsTerm).join(" AND ");
}

function quoteFtsTerm(term: string): string {
  // FTS5 treats unquoted * / ^ / NEAR / NOT / AND / OR as operators. Wrapping
  // each term in double quotes neutralizes all of them (including *), and we
  // escape internal quotes by doubling them. Bigrams stay bigrams.
  const escaped = term.replaceAll('"', '""');
  return `"${escaped}"`;
}

// LIKE-path escape stays unchanged: only CJK single-character probes and
// empty-token queries fall through to this branch now.
function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
