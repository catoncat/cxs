const WORD_SEGMENTER = new Intl.Segmenter("zh-Hans-CN", { granularity: "word" });
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_ONLY = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;

/**
 * Split text into FTS-friendly tokens.
 *
 * Strategy:
 * - CJK runs are split into overlapping bigrams (stable recall; ICU's
 *   zh-Hans word dictionary fragments technical terms too aggressively).
 * - Non-CJK runs go through Intl.Segmenter to get wordlike tokens
 *   (handles sing-box -> [sing, box], preserves identifiers).
 * - Single CJK characters are dropped: they carry no retrieval value
 *   and would otherwise act as stop-word-level noise.
 *
 * Use the same function for indexing and query-time term extraction
 * so both paths produce matching tokens.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const tokens: string[] = [];
  let cjkBuffer = "";
  let nonCjkBuffer = "";

  const flushCjk = () => {
    if (!cjkBuffer) return;
    if (cjkBuffer.length >= 2) {
      for (let i = 0; i < cjkBuffer.length - 1; i += 1) {
        tokens.push(cjkBuffer.slice(i, i + 2));
      }
    }
    cjkBuffer = "";
  };

  const flushNonCjk = () => {
    if (!nonCjkBuffer) return;
    for (const segment of WORD_SEGMENTER.segment(nonCjkBuffer)) {
      if (!segment.isWordLike) continue;
      const token = segment.segment.toLowerCase();
      if (token) tokens.push(token);
    }
    nonCjkBuffer = "";
  };

  for (const ch of text) {
    if (CJK_CHAR.test(ch)) {
      flushNonCjk();
      cjkBuffer += ch;
    } else {
      flushCjk();
      nonCjkBuffer += ch;
    }
  }
  flushCjk();
  flushNonCjk();

  return tokens;
}

/**
 * Produce the whitespace-joined representation of a text that gets
 * stored in the FTS virtual column. Indexing and query pipelines must
 * both go through tokenize() to stay in sync.
 */
export function tokenizedText(text: string): string {
  return tokenize(text).join(" ");
}

/**
 * Query-time helper: returns the distinct token list for a query.
 */
export function queryTerms(query: string): string[] {
  return Array.from(new Set(tokenize(query)));
}

/**
 * Whether a query contains any CJK characters at all. Used to shape
 * UX-facing fallbacks for queries that tokenize to nothing (e.g. a
 * single kanji).
 */
export function hasCjk(text: string): boolean {
  return CJK_CHAR.test(text);
}

/**
 * Whether a token is purely CJK (useful when deciding whether to
 * treat a token as a phrase vs a word).
 */
export function isCjkToken(token: string): boolean {
  return CJK_ONLY.test(token);
}
