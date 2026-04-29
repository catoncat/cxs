export type MessageRole = "user" | "assistant";
export type MatchSource = "message" | "session";
export type FindMatchRole = MessageRole | "session";

export interface ParsedMessage {
  role: MessageRole;
  contentText: string;
  timestamp: string;
  seq: number;
  sourceKind: "event_msg";
}

export interface ParsedSession {
  sessionUuid: string;
  filePath: string;
  title: string;
  summaryText: string;
  compactText: string;
  reasoningSummaryText: string;
  cwd: string;
  model: string;
  startedAt: string;
  endedAt: string;
  messages: ParsedMessage[];
}

export type ParseSessionResult =
  | { kind: "parsed"; session: ParsedSession }
  | { kind: "filtered" }
  | { kind: "skipped" };

export interface SyncErrorDetail {
  filePath: string;
  message: string;
}

export type Selector =
  | { kind: "all"; root: string }
  | { kind: "date_range"; root: string; fromDate: string; toDate: string }
  | { kind: "cwd"; root: string; cwd: string }
  | { kind: "cwd_date_range"; root: string; cwd: string; fromDate: string; toDate: string };

export type SelectorKind = Selector["kind"];

export interface DateRange {
  from: string | null;
  to: string | null;
}

export interface SourceInventoryCwdGroup {
  cwd: string;
  fileCount: number;
  pathDateRange: DateRange;
}

export interface SourceInventory {
  root: string;
  totalFiles: number;
  pathDateRange: DateRange;
  cwdGroups: SourceInventoryCwdGroup[];
}

export interface SourceFileMeta {
  filePath: string;
  pathDate: string | null;
  cwd: string;
  mtimeMs: number;
  size: number;
}

export interface SourceSnapshot {
  selector: Selector;
  fingerprint: string;
  fileCount: number;
  files: SourceFileMeta[];
}

export interface CoverageRecord {
  id: number;
  selector: Selector;
  sourceFingerprint: string;
  sourceFileCount: number;
  indexedSessionCount: number;
  completedAt: string;
  indexVersion: string;
}

export interface CoverageInventoryStatus extends CoverageRecord {
  freshness: "fresh" | "stale";
  currentSourceFingerprint: string;
  currentSourceFileCount: number;
}

export interface CoverageWriteSummary {
  written: boolean;
  selector: Selector;
  sourceFingerprint: string;
  sourceFileCount: number;
  indexedSessionCount: number;
  reason?: string;
}

export interface CoverageStatus {
  requested: Selector | null;
  complete: boolean;
  freshness: "not_checked";
  coveringSelectors: CoverageRecord[];
}

export interface SessionRecord {
  sessionUuid: string;
  filePath: string;
  sourceRoot: string;
  title: string;
  summaryText: string;
  cwd: string;
  model: string;
  startedAt: string;
  endedAt: string;
  pathDate: string;
  messageCount: number;
}

export interface MessageRecord {
  sessionUuid: string;
  seq: number;
  role: MessageRole;
  contentText: string;
  timestamp: string;
  sourceKind: string;
}

export interface FindResult {
  rank: number;
  sessionUuid: string;
  title: string;
  summaryText: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  matchCount: number;
  matchSource: MatchSource;
  matchSeq: number | null;
  matchRole: FindMatchRole;
  matchTimestamp: string | null;
  score: number;
  snippet: string;
}

export interface SyncSummary {
  scanned: number;
  added: number;
  updated: number;
  skipped: number;
  filtered: number;
  removed: number;
  errors: number;
  errorDetails: SyncErrorDetail[];
  selector: Selector;
  coverage: CoverageWriteSummary;
}

export interface SessionListEntry {
  sessionUuid: string;
  title: string;
  summaryText: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  pathDate: string;
  messageCount: number;
}

export type SessionListSort = "ended" | "started" | "messages";

export interface SessionListQuery {
  cwd?: string;
  since?: string;
  selector?: Selector;
  sort: SessionListSort;
  limit: number;
}

export interface CwdCount {
  cwd: string;
  count: number;
}

export interface StatsSummary {
  sessionCount: number;
  messageCount: number;
  earliestStartedAt: string | null;
  latestEndedAt: string | null;
  topCwds: CwdCount[];
  indexVersion: string;
  dbPath: string;
  dbSizeBytes: number;
  lastSyncAt: string | null;
  coverage: CoverageRecord[];
}

export interface StatusSummary {
  context: {
    cwd: string;
    root: string;
    dbPath: string;
    indexVersion: string;
  };
  sourceInventory: SourceInventory;
  index: {
    exists: boolean;
    sessionCount: number;
    messageCount: number;
    earliestStartedAt: string | null;
    latestEndedAt: string | null;
    dbSizeBytes: number;
    lastSyncAt: string | null;
  };
  coverage: CoverageInventoryStatus[];
}
