import { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import { statSync } from "node:fs";
import {
  getMessagesForPage,
  getMessagesForRange,
  getSessionRecord,
  getStatsCounts,
  getTopCwds,
  listSessions,
  openReadDb,
} from "./db";
import { INDEX_VERSION } from "./env";
import { classifyQueryProfile, rerankHits } from "./ranking";
import type { RawHitRow } from "./ranking";
import { hasCjk, isCjkToken, queryTerms } from "./tokenize";
import type {
  CurrentSessionCandidate,
  FindResult,
  SessionListEntry,
  SessionListQuery,
  SessionRecord,
  StatsSummary,
} from "./types";

export { classifyQueryProfile } from "./ranking";
type SqlParams = SQLQueryBindings[];

export function findSessions(
  dbPath: string,
  query: string,
  limit: number,
): { query: string; results: FindResult[] } {
  const db = openReadDb(dbPath);
  const recallLimit = Math.max(limit * 12, 50);
  const rawRows = [
    ...searchMessageHits(db, query, recallLimit),
    ...searchSessionHits(db, query, recallLimit),
  ];
  const results = rerankHits(rawRows, query, limit);
  db.close();
  return { query, results };
}

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
} {
  const db = openReadDb(dbPath);
  const anchorSeq = resolveAnchorSeq(db, sessionUuid, options.seq, options.query);
  const session = getSessionRecord(db, sessionUuid);
  if (!session) throw new Error(`session not found: ${sessionUuid}`);

  const rangeStartSeq = Math.max(0, anchorSeq - options.before);
  const rangeEndSeq = anchorSeq + options.after;
  const messages = getMessagesForRange(db, sessionUuid, rangeStartSeq, rangeEndSeq);
  db.close();
  return { session, anchorSeq, rangeStartSeq, rangeEndSeq, messages };
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
} {
  const db = openReadDb(dbPath);
  const session = getSessionRecord(db, sessionUuid);
  if (!session) throw new Error(`session not found: ${sessionUuid}`);
  const messages = getMessagesForPage(db, sessionUuid, offset, limit);
  const totalCount = session.messageCount;
  const hasMore = offset + messages.length < totalCount;
  db.close();
  return { session, offset, limit, totalCount, hasMore, messages };
}

export function listSessionSummaries(
  dbPath: string,
  query: SessionListQuery,
): { query: SessionListQuery; results: SessionListEntry[] } {
  const db = openReadDb(dbPath);
  const results = listSessions(db, query);
  db.close();
  return { query, results };
}

export function getCurrentSessions(
  stateDbPath: string,
  cwd: string,
  limit: number,
): { cwd: string; candidates: CurrentSessionCandidate[] } {
  const normalizedCwd = cwd.trim();
  if (!normalizedCwd) {
    return { cwd: normalizedCwd, candidates: [] };
  }

  const db = new Database(stateDbPath, { readonly: true });
  try {
    const candidates = db
      .query<CurrentSessionCandidate, [string, number]>(`
        SELECT
          id AS sessionUuid,
          title,
          cwd,
          rollout_path AS filePath,
          COALESCE(updated_at_ms, 0) AS updatedAtMs
        FROM threads
        WHERE cwd = ?
        ORDER BY updated_at_ms DESC
        LIMIT ?
      `)
      .all(normalizedCwd, limit) as CurrentSessionCandidate[];
    return { cwd: normalizedCwd, candidates };
  } finally {
    db.close();
  }
}

export function collectStats(dbPath: string): StatsSummary {
  const db = openReadDb(dbPath);
  const counts = getStatsCounts(db);
  const topCwds = getTopCwds(db, 10);
  db.close();

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
  };
}

function resolveAnchorSeq(
  db: Database,
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

function searchTopHitInSession(db: Database, sessionUuid: string, query: string): FindResult | null {
  const rows = searchMessageHits(db, query, 20, sessionUuid);
  const result = rerankHits(rows, query, 1)[0];
  return result ?? null;
}

function searchMessageHits(db: Database, query: string, limit: number, sessionUuid?: string): RawHitRow[] {
  const normalized = query.trim();
  if (!normalized) return [];

  const terms = queryTerms(normalized);
  // Queries that degenerate to zero tokens (e.g. a single kanji dropped as
  // stop-word-like noise, or whitespace only) cannot hit the FTS index. Fall
  // back to a bounded LIKE scan so single-character CJK probes still work
  // even though they are discouraged.
  if (terms.length === 0) {
    if (hasCjk(normalized)) return searchByLike(db, normalized, limit, sessionUuid);
    return [];
  }

  return searchByFts(db, terms, limit, sessionUuid);
}

function searchSessionHits(db: Database, query: string, limit: number): RawHitRow[] {
  const normalized = query.trim();
  if (!normalized || !tableExists(db, "sessions_fts")) return [];

  const terms = queryTerms(normalized);
  if (terms.length === 0) return [];

  return searchSessionsByFts(db, normalized, terms, limit);
}

function searchByFts(
  db: Database,
  terms: string[],
  limit: number,
  sessionUuid?: string,
): RawHitRow[] {
  const matchExpr = buildFtsMatch(terms);
  const conditions = [`messages_fts MATCH ?`];
  const params: SqlParams = [matchExpr];

  if (sessionUuid) {
    conditions.push("m.session_uuid = ?");
    params.push(sessionUuid);
  }
  params.push(limit);

  return db
    .query<RawHitRow, typeof params>(`
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
  db: Database,
  query: string,
  terms: string[],
  limit: number,
): RawHitRow[] {
  const matchExpr = buildFtsMatch(terms);
  const rows = db
    .query<RawHitRow, [string, number]>(`
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
      WHERE sessions_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `)
    .all(matchExpr, limit) as RawHitRow[];

  return rows.map((row) => ({
    ...row,
    snippet: makeRawSnippet(row.contentText, query, terms),
  }));
}

function searchByLike(db: Database, query: string, limit: number, sessionUuid?: string): RawHitRow[] {
  const conditions = ["lower(m.content_text) LIKE ? ESCAPE '\\'"];
  const params: SqlParams = [`%${escapeLike(query.toLowerCase())}%`];
  if (sessionUuid) {
    conditions.push("m.session_uuid = ?");
    params.push(sessionUuid);
  }
  params.push(limit);

  const rows = db
    .query<RawHitRow & { contentText: string }, typeof params>(`
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

function tableExists(db: Database, tableName: string): boolean {
  const row = db
    .query<unknown, [string]>("SELECT 1 FROM sqlite_master WHERE name = ? LIMIT 1")
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

function makeLikeSnippet(content: string, query: string): string {
  const lower = content.toLowerCase();
  const target = query.toLowerCase();
  const index = lower.indexOf(target);
  if (index < 0) return content.slice(0, 160);
  const start = Math.max(0, index - 40);
  const end = Math.min(content.length, index + target.length + 80);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  const snippet = content.slice(start, end);
  // Re-scan the snippet slice and wrap every occurrence so the returned
  // snippet agrees with FTS5's snippet() which highlights all matches.
  const highlighted = wrapAllOccurrences(snippet, target);
  return `${prefix}${highlighted}${suffix}`;
}

function makeRawSnippet(content: string, query: string, terms: string[]): string {
  const normalizedQuery = query.toLowerCase();
  const lower = content.toLowerCase();
  const phraseIndex = normalizedQuery ? lower.indexOf(normalizedQuery) : -1;
  if (phraseIndex >= 0) {
    return snippetAround(content, phraseIndex, query.length, [normalizedQuery]);
  }

  const termLowers = uniqueNonEmpty(terms.map((term) => term.toLowerCase()));
  const termHits = termLowers.flatMap((term) => collectTermHits(lower, term));
  if (termHits.length === 0) return content.slice(0, 160);

  const bestWindow = termHits
    .map((hit) => {
      const start = Math.max(0, hit.index - 40);
      const end = Math.min(content.length, hit.index + hit.length + 80);
      return {
        start,
        end,
        anchor: hit.index,
        score: scoreSnippetWindow(lower.slice(start, end), termLowers),
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.anchor - right.anchor;
    })[0];

  return snippetWindow(content, bestWindow.start, bestWindow.end, termLowers);
}

function snippetAround(content: string, index: number, length: number, needleLowers: string[]): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(content.length, index + length + 80);
  return snippetWindow(content, start, end, needleLowers);
}

function snippetWindow(content: string, start: number, end: number, needleLowers: string[]): string {
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  const snippet = content.slice(start, end);
  return `${prefix}${wrapAnyOccurrences(snippet, needleLowers)}${suffix}`;
}

function collectTermHits(lower: string, termLower: string): Array<{ index: number; length: number }> {
  const hits: Array<{ index: number; length: number }> = [];
  let cursor = 0;
  while (cursor < lower.length) {
    const index = lower.indexOf(termLower, cursor);
    if (index < 0) break;
    hits.push({ index, length: termLower.length });
    cursor = index + termLower.length;
  }
  return hits;
}

function scoreSnippetWindow(lowerSnippet: string, termLowers: string[]): number {
  let distinctTerms = 0;
  let totalHits = 0;
  let matchedChars = 0;

  for (const term of termLowers) {
    const hits = collectTermHits(lowerSnippet, term).length;
    if (hits > 0) distinctTerms += 1;
    totalHits += hits;
    matchedChars += hits * term.length;
  }

  return distinctTerms * 1_000 + matchedChars * 10 + totalHits;
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function wrapAnyOccurrences(haystack: string, needleLowers: string[]): string {
  const needles = uniqueNonEmpty(needleLowers).sort((left, right) => right.length - left.length);
  if (needles.length === 0) return haystack;

  const lower = haystack.toLowerCase();
  const matches = needles
    .flatMap((needle) => collectTermHits(lower, needle))
    .sort((left, right) => {
      if (left.index !== right.index) return left.index - right.index;
      return right.length - left.length;
    });

  const out: string[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.index < cursor) continue;
    out.push(haystack.slice(cursor, match.index));
    out.push("<mark>");
    out.push(haystack.slice(match.index, match.index + match.length));
    out.push("</mark>");
    cursor = match.index + match.length;
  }
  out.push(haystack.slice(cursor));
  return out.join("");
}

function wrapAllOccurrences(haystack: string, needleLower: string): string {
  if (!needleLower) return haystack;
  const out: string[] = [];
  let cursor = 0;
  const lower = haystack.toLowerCase();
  while (cursor < haystack.length) {
    const hit = lower.indexOf(needleLower, cursor);
    if (hit < 0) {
      out.push(haystack.slice(cursor));
      break;
    }
    out.push(haystack.slice(cursor, hit));
    out.push("<mark>");
    out.push(haystack.slice(hit, hit + needleLower.length));
    out.push("</mark>");
    cursor = hit + needleLower.length;
  }
  return out.join("");
}

// Re-export for callers that still rely on the old helper name.
export function isCjkTerm(token: string): boolean {
  return isCjkToken(token);
}
