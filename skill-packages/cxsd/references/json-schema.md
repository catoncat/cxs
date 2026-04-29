# cxs JSON Schema

## find

Top-level shape:

```ts
{
  query: string;
  results: FindResult[];
  coverage: CoverageStatus;
}
```

`FindResult`:

```ts
{
  rank: number;
  sessionUuid: string;
  title: string;
  summaryText: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  matchCount: number;
  matchSource: "message" | "session";
  matchSeq: number | null;
  matchRole: "user" | "assistant" | "session";
  matchTimestamp: string | null;
  score: number;
  snippet: string;
}
```

`matchSource = "session"` means the hit came from session-level fields such as title, derived summary, compact handoff, or reasoning summary rather than a concrete message. In that case `matchSeq` is `null`; use `read-page` first instead of fabricating a `read-range --seq` anchor.

## read-range

```ts
{
  session: SessionRecord;
  anchorSeq: number;
  rangeStartSeq: number;
  rangeEndSeq: number;
  messages: MessageRecord[];
  coverage: { entries: CoverageRecord[] };
}
```

## read-page

```ts
{
  session: SessionRecord;
  offset: number;
  limit: number;
  totalCount: number;
  hasMore: boolean;
  messages: MessageRecord[];
  coverage: { entries: CoverageRecord[] };
}
```

## list

```ts
{
  query: {
    cwd?: string;
    since?: string;
    selector?: Selector;
    sort: "ended" | "started" | "messages";
    limit: number;
  };
  results: SessionListEntry[];
  coverage: CoverageStatus;
}
```

## stats

```ts
{
  sessionCount: number;
  messageCount: number;
  earliestStartedAt: string | null;
  latestEndedAt: string | null;
  topCwds: Array<{ cwd: string; count: number }>;
  indexVersion: string;
  dbPath: string;
  dbSizeBytes: number;
  lastSyncAt: string | null;
  coverage: CoverageInventoryStatus[];
}
```

## status

```ts
{
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
  coverage: CoverageRecord[];
}
```

## sync

```ts
{
  scanned: number;
  added: number;
  updated: number;
  skipped: number;
  filtered: number;
  removed: number;
  errors: number;
  errorDetails: Array<{
    filePath: string;
    message: string;
  }>;
  selector: Selector;
  coverage: {
    written: boolean;
    selector: Selector;
    sourceFingerprint: string;
    sourceFileCount: number;
    indexedSessionCount: number;
    reason?: string;
  };
}
```

## Shared Records

`SessionRecord`:

```ts
{
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
```

`MessageRecord`:

```ts
{
  sessionUuid: string;
  seq: number;
  role: "user" | "assistant";
  contentText: string;
  timestamp: string;
  sourceKind: string;
}
```

`Selector`:

```ts
type Selector =
  | { kind: "all"; root: string }
  | { kind: "date_range"; root: string; fromDate: string; toDate: string }
  | { kind: "cwd"; root: string; cwd: string }
  | { kind: "cwd_date_range"; root: string; cwd: string; fromDate: string; toDate: string };
```

`CoverageStatus`:

```ts
{
  requested: Selector | null;
  complete: boolean;
  freshness: "not_checked";
  coveringSelectors: CoverageRecord[];
}
```

`CoverageRecord`:

```ts
{
  id: number;
  selector: Selector;
  sourceFingerprint: string;
  sourceFileCount: number;
  indexedSessionCount: number;
  completedAt: string;
  indexVersion: string;
}
```

`CoverageInventoryStatus`:

```ts
CoverageRecord & {
  freshness: "fresh" | "stale";
  currentSourceFingerprint: string;
  currentSourceFileCount: number;
}
```

## 来源

- 仓库内 `types.ts`
- 仓库内 `cli.ts`
- 仓库内 `query.ts`
