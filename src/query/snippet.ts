export function makeLikeSnippet(content: string, query: string): string {
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

export function makeRawSnippet(content: string, query: string, terms: string[]): string {
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
  // OPTIMIZATION: Use a single loop to populate the Set.
  // Avoids intermediate array allocations from filter() operation.
  const seen = new Set<string>();
  for (const value of values) {
    if (value) seen.add(value);
  }
  return [...seen];
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
