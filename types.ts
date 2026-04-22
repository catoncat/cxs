export type MessageRole = "user" | "assistant";

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

export interface SessionRecord {
  sessionUuid: string;
  filePath: string;
  title: string;
  summaryText: string;
  cwd: string;
  model: string;
  startedAt: string;
  endedAt: string;
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
  matchSeq: number;
  matchRole: MessageRole;
  matchTimestamp: string;
  score: number;
  snippet: string;
}

export interface SyncSummary {
  scanned: number;
  added: number;
  updated: number;
  skipped: number;
  filtered: number;
  errors: number;
  errorDetails: SyncErrorDetail[];
}

export interface SessionListEntry {
  sessionUuid: string;
  title: string;
  summaryText: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  messageCount: number;
}

export type SessionListSort = "ended" | "started" | "messages";

export interface SessionListQuery {
  cwd?: string;
  since?: string;
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
}
