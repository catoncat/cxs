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
  matchSeq: number;
  matchRole: "user" | "assistant";
  matchTimestamp: string;
  score: number;
  snippet: string;
}
```

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
