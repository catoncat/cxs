# cxs JSON Schema

## find

Top-level shape:

```ts
{
  query: string;
  results: FindResult[];
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
}
```

## list

```ts
{
  query: {
    cwd?: string;
    since?: string;
    sort: "ended" | "started" | "messages";
    limit: number;
  };
  results: SessionListEntry[];
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
  errors: number;
  errorDetails: Array<{
    filePath: string;
    message: string;
  }>;
}
```

## Shared Records

`SessionRecord`:

```ts
{
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

## 来源

- 仓库内 `types.ts`
- 仓库内 `cli.ts`
- 仓库内 `query.ts`
