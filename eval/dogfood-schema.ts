import type { MatchSource } from "../src/types";

export type DogfoodStatus = "candidate" | "hard" | "stale";
export type DogfoodOriginKind = "observed-user-ask" | "evidence-backed-derived" | "manual";
export type DogfoodContextMode = "auto" | "read-range" | "read-page";

export interface DogfoodOrigin {
  kind: DogfoodOriginKind;
  sourceSessionUuid?: string;
  sourceSeq?: number;
  note?: string;
}

export interface DogfoodExpectedContext {
  mode?: DogfoodContextMode;
  before?: number;
  after?: number;
  offset?: number;
  limit?: number;
  mustContain?: string[];
}

export interface DogfoodExpected {
  topK?: number;
  acceptableSessionUuids?: string[];
  cwdContains?: string;
  matchSource?: MatchSource;
  context?: DogfoodExpectedContext;
}

export interface DogfoodGolden {
  id: string;
  query: string;
  intent: string;
  status: DogfoodStatus;
  origin?: DogfoodOrigin;
  expected: DogfoodExpected;
}

export interface DogfoodParseResult {
  entries: DogfoodGolden[];
  errors: string[];
}

export function parseDogfoodJsonl(text: string, sourceName: string): DogfoodParseResult {
  const entries: DogfoodGolden[] = [];
  const errors: string[] = [];

  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    try {
      const parsed = JSON.parse(line) as unknown;
      const validation = validateDogfoodGolden(parsed, lineNumber);
      if (validation.ok) {
        entries.push(validation.value);
      } else {
        errors.push(`${sourceName}:${lineNumber}: ${validation.error}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${sourceName}:${lineNumber}: invalid JSONL entry: ${message}`);
    }
  }

  return { entries, errors };
}

function validateDogfoodGolden(
  value: unknown,
  lineNumber: number,
): { ok: true; value: DogfoodGolden } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "entry must be an object" };

  const id = readNonEmptyString(value, "id");
  const query = readNonEmptyString(value, "query");
  const intent = readNonEmptyString(value, "intent");
  if (!id || !query || !intent) {
    return { ok: false, error: "id, query and intent are required non-empty strings" };
  }

  const status = value.status;
  if (status !== "candidate" && status !== "hard" && status !== "stale") {
    return { ok: false, error: "status must be candidate, hard or stale" };
  }

  const expected = parseExpected(value.expected);
  if (!expected) return { ok: false, error: "expected must contain at least one assertion" };

  const origin = parseOrigin(value.origin, lineNumber);
  if (origin === "invalid") return { ok: false, error: "origin is invalid" };

  return { ok: true, value: { id, query, intent, status, expected, ...(origin ? { origin } : {}) } };
}

function parseExpected(value: unknown): DogfoodExpected | null {
  if (!isRecord(value)) return null;

  const expected: DogfoodExpected = {};
  const topK = readPositiveInteger(value.topK);
  if (topK) expected.topK = topK;

  const acceptableSessionUuids = readStringArray(value.acceptableSessionUuids);
  if (acceptableSessionUuids) expected.acceptableSessionUuids = acceptableSessionUuids;

  const cwdContains = readNonEmptyString(value, "cwdContains");
  if (cwdContains) expected.cwdContains = cwdContains;

  if (value.matchSource === "message" || value.matchSource === "session") {
    expected.matchSource = value.matchSource;
  }

  const context = parseContext(value.context);
  if (context) expected.context = context;

  return hasExpectedAssertion(expected) ? expected : null;
}

function parseContext(value: unknown): DogfoodExpectedContext | undefined {
  if (!isRecord(value)) return undefined;
  const context: DogfoodExpectedContext = {};

  if (value.mode === "auto" || value.mode === "read-range" || value.mode === "read-page") {
    context.mode = value.mode;
  }
  const before = readPositiveInteger(value.before);
  if (before) context.before = before;
  const after = readPositiveInteger(value.after);
  if (after) context.after = after;
  const offset = readNonNegativeInteger(value.offset);
  if (typeof offset === "number") context.offset = offset;
  const limit = readPositiveInteger(value.limit);
  if (limit) context.limit = limit;
  const mustContain = readStringArray(value.mustContain);
  if (mustContain) context.mustContain = mustContain;

  return Object.keys(context).length > 0 ? context : undefined;
}

function parseOrigin(value: unknown, _lineNumber: number): DogfoodOrigin | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return "invalid";
  if (
    value.kind !== "observed-user-ask"
    && value.kind !== "evidence-backed-derived"
    && value.kind !== "manual"
  ) {
    return "invalid";
  }

  const origin: DogfoodOrigin = { kind: value.kind };
  const sourceSessionUuid = readNonEmptyString(value, "sourceSessionUuid");
  if (sourceSessionUuid) origin.sourceSessionUuid = sourceSessionUuid;
  if (typeof value.sourceSeq === "number" && Number.isInteger(value.sourceSeq)) origin.sourceSeq = value.sourceSeq;
  const note = readNonEmptyString(value, "note");
  if (note) origin.note = note;
  return origin;
}

function hasExpectedAssertion(expected: DogfoodExpected): boolean {
  return Boolean(
    expected.acceptableSessionUuids?.length
    || Boolean(expected.cwdContains)
    || Boolean(expected.matchSource)
    || expected.context?.mustContain?.length,
  );
}

function readNonEmptyString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim());
  return items.length > 0 ? items : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
