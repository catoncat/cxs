import type { FindMatchRole, FindResult, MatchSource } from "./types";
import { queryTerms } from "./tokenize";

export interface RawHitRow {
  sessionUuid: string;
  title: string;
  summaryText: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  matchSource: MatchSource;
  matchSeq: number | null;
  matchRole: FindMatchRole;
  matchTimestamp: string | null;
  contentText: string;
  snippet: string;
  // FTS path: negative bm25(). LIKE path: a small negative ordinal. Either
  // way, lower is "better" from the SQL side; we flip the sign during
  // rerank so all bonuses stay positive and additive.
  score: number;
}

export interface QueryProfile {
  normalizedQuery: string;
  terms: string[];
  isMultiTerm: boolean;
}

/**
 * Kept for backward compat with callers that still read `kind`. The v3
 * scoring pipeline does not branch on kind anymore; it treats `isMultiTerm`
 * as a continuous signal instead. Single-term queries are labelled "broad",
 * everything else "exact" to preserve existing external tests.
 */
export function classifyQueryProfile(query: string): QueryProfile & { kind: "broad" | "exact" } {
  const normalizedQuery = query.trim().toLowerCase();
  const terms = queryTerms(query);
  const hasMultipleRawTokens = query.trim().split(/\s+/).filter(Boolean).length >= 2;
  const hasDigits = /\d/.test(query);
  const hasPathLikeToken = /[\\/._:-]/.test(query);
  // "exact" historically meant: user gave us enough signal that we should
  // trust phrase matches heavily. Keep that label, but compute it off the
  // raw query rather than the tokenized terms so the category stays stable
  // for CJK queries that bigram-explode into many tokens.
  const kind: "broad" | "exact" = hasMultipleRawTokens || hasDigits || hasPathLikeToken
    ? "exact"
    : "broad";
  return {
    kind,
    normalizedQuery,
    terms,
    isMultiTerm: hasMultipleRawTokens,
  };
}

interface SessionAggregate {
  row: RawHitRow;
  bestRow: RawHitRow;
  bestDisplayRow: RawHitRow;
  bestRowSignalScore: number;
  bestDisplayRowSignalScore: number;
  hitCount: number;
  sessionHitCount: number;
  userHitCount: number;
  titlePhrase: boolean;
  titleTermHits: number;
  cwdTermHits: number;
}

export function rerankHits(rows: RawHitRow[], query: string, limit: number): FindResult[] {
  const profile = classifyQueryProfile(query);
  const now = Date.now();
  const grouped = new Map<string, SessionAggregate>();

  for (const row of rows) {
    const signalScore = scoreRow(row, profile);
    const existing = grouped.get(row.sessionUuid);
    const rowTitleLower = row.title.toLowerCase();
    const rowCwdLower = row.cwd.toLowerCase();
    const titlePhrase = profile.normalizedQuery.length > 0
      && rowTitleLower.includes(profile.normalizedQuery);
    const titleTermHits = countMatchedTerms(rowTitleLower, profile.terms);
    const cwdTermHits = countMatchedTerms(rowCwdLower, profile.terms);

    if (!existing) {
      grouped.set(row.sessionUuid, {
        row,
        bestRow: row,
        bestDisplayRow: row,
        bestRowSignalScore: signalScore,
        bestDisplayRowSignalScore: signalScore,
        hitCount: 1,
        sessionHitCount: row.matchSource === "session" ? 1 : 0,
        userHitCount: row.matchRole === "user" ? 1 : 0,
        titlePhrase,
        titleTermHits,
        cwdTermHits,
      });
      continue;
    }

    existing.hitCount += 1;
    if (row.matchSource === "session") existing.sessionHitCount += 1;
    if (row.matchRole === "user") existing.userHitCount += 1;
    existing.titlePhrase = existing.titlePhrase || titlePhrase;
    existing.titleTermHits = Math.max(existing.titleTermHits, titleTermHits);
    existing.cwdTermHits = Math.max(existing.cwdTermHits, cwdTermHits);
    if (signalScore > existing.bestRowSignalScore) {
      existing.bestRow = row;
      existing.bestRowSignalScore = signalScore;
    }
    if (shouldUseDisplayRow(existing.bestDisplayRow, row, existing.bestDisplayRowSignalScore, signalScore)) {
      existing.bestDisplayRow = row;
      existing.bestDisplayRowSignalScore = signalScore;
    }
  }

  const ranked = Array.from(grouped.values())
    .map((aggregate) => ({
      aggregate,
      sessionScore: scoreSession(aggregate, profile, now),
    }))
    .sort((left, right) => {
      if (right.sessionScore !== left.sessionScore) {
        return right.sessionScore - left.sessionScore;
      }
      return getTimestamp(right.aggregate.row.endedAt) - getTimestamp(left.aggregate.row.endedAt);
    });

  return ranked.slice(0, limit).map(({ aggregate, sessionScore }, index) => ({
    rank: index + 1,
    sessionUuid: aggregate.row.sessionUuid,
    title: aggregate.row.title,
    summaryText: aggregate.row.summaryText,
    cwd: aggregate.row.cwd,
    startedAt: aggregate.row.startedAt,
    endedAt: aggregate.row.endedAt,
    matchCount: aggregate.hitCount,
    matchSource: aggregate.bestDisplayRow.matchSource,
    matchSeq: aggregate.bestDisplayRow.matchSeq,
    matchRole: aggregate.bestDisplayRow.matchRole,
    matchTimestamp: aggregate.bestDisplayRow.matchTimestamp,
    score: sessionScore,
    snippet: aggregate.bestDisplayRow.snippet,
  }));
}

function shouldUseDisplayRow(
  current: RawHitRow,
  candidate: RawHitRow,
  currentScore: number,
  candidateScore: number,
): boolean {
  if (candidate.matchSource === "message" && current.matchSource !== "message") return true;
  if (candidate.matchSource !== current.matchSource) return false;
  return candidateScore > currentScore;
}

/**
 * Score a single FTS/LIKE row. Higher is better. The only signals we trust
 * at row-level are:
 * 1. The normalized FTS bm25 score (flipped so higher=better).
 * 2. Whether the full query phrase appears verbatim in the content.
 * 3. User-message bump (user-authored content is usually the search intent).
 */
function scoreRow(row: RawHitRow, profile: QueryProfile): number {
  const normalizedBm25 = -row.score; // higher is better now
  const contentLower = row.contentText.toLowerCase();
  const contentPhrase = profile.normalizedQuery.length > 0
    && contentLower.includes(profile.normalizedQuery);
  const termCoverage = countMatchedTerms(contentLower, profile.terms);

  return normalizedBm25
    + (contentPhrase ? 8 : 0)
    + termCoverage * 2
    + (row.matchSource === "message" ? 4 : 0)
    + (row.matchRole === "user" ? 2 : 0);
}

/**
 * Score a whole session. Combines the best row's signal score with session
 * metadata signals (title, cwd, user-authored evidence, recency) so that a
 * session whose raw FTS match is weaker but whose title/cwd strongly reflect
 * the query can still win.
 */
function scoreSession(aggregate: SessionAggregate, profile: QueryProfile, now: number): number {
  const recencyBonus = recencyDecay(aggregate.row.endedAt, now);

  return aggregate.bestRowSignalScore
    + (aggregate.titlePhrase ? 30 : 0)
    + aggregate.titleTermHits * 10
    + aggregate.cwdTermHits * 18
    + Math.min(aggregate.userHitCount, 3) * 4
    + Math.min(aggregate.sessionHitCount, 2) * 2
    + Math.min(aggregate.hitCount, 6) * 1.5
    + recencyBonus;
}

/**
 * Linear decay over a 120-day window. Anything older contributes nothing.
 * The 0.15-per-day factor means today's session gets +18, yesterday +17.85,
 * a month ago +13.5, which is meaningful against title-boost scale but does
 * not dominate genuine content matches.
 */
function recencyDecay(endedAt: string, now: number): number {
  const ts = Date.parse(endedAt);
  if (Number.isNaN(ts)) return 0;
  const days = Math.max(0, (now - ts) / (1000 * 60 * 60 * 24));
  return Math.max(0, 18 - days * 0.15);
}

function countMatchedTerms(haystack: string, terms: string[]): number {
  let matched = 0;
  for (const term of terms) {
    if (haystack.includes(term)) matched += 1;
  }
  return matched;
}

function getTimestamp(iso: string): number {
  const timestamp = Date.parse(iso);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}
