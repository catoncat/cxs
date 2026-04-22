# cxs 当前架构

## 一句话

`cxs` 是一个面向本机 Codex session 日志的渐进式检索 CLI，当前架构是：

`sync -> message recall -> session heuristic rerank -> read-range/read-page`

它已经可用，但仍是轻量 retrieval 后端，不是完整的 resource-level retrieval 系统。

## 当前命令面

- `cxs sync`
- `cxs find <query>`
- `cxs read-range <sessionUuid>`
- `cxs read-page <sessionUuid>`
- `cxs list`
- `cxs stats`

这套命令面已经定型，不再保留 `window/session` 旧别名语义。

## 数据流

### 1. 同步

[indexer.ts](/Users/envvar/work/repos/cxs/indexer.ts) 扫描 `~/.codex/sessions` 下的 JSONL session 文件，按文件 `mtime`、`size` 和 `indexVersion` 做增量判断。

[parser.ts](/Users/envvar/work/repos/cxs/parser.ts) 只抽取 `event_msg` 里的：

- `user_message`
- `agent_message`

同时过滤内部 marker，避免污染索引。

### 2. 持久化

[db.ts](/Users/envvar/work/repos/cxs/db.ts) 维护两层主数据：

- `sessions`
- `messages`

以及一个全文索引：

- `messages_fts`

当前 `sessions` 已包含 `summary_text` 字段，但没有单独的 `sessions_fts`。

### 3. 查询

[query.ts](/Users/envvar/work/repos/cxs/query.ts) 提供三类读取：

- `findSessions()`
- `getMessageRange()`
- `getMessagePage()`

`findSessions()` 当前流程是：

1. 先从 `messages_fts` 做候选召回
2. 极少数零 token CJK query 回退到 LIKE
3. 把 raw hits 交给 [ranking.ts](/Users/envvar/work/repos/cxs/ranking.ts) 做 session 级排序

### 4. 排序

[ranking.ts](/Users/envvar/work/repos/cxs/ranking.ts) 当前是 heuristic rerank，不是独立的 resource-level reranker。

主要信号包括：

- row 级 bm25 翻转分数
- content phrase / term coverage
- user message bump
- title phrase / term hits
- cwd term hits
- user hit count
- hit count
- recency

## 当前已落地能力

- 渐进式命令面
- CJK 兼容的 tokenized FTS
- `summary_text` 派生摘要
- strict / best-effort 两种 sync 语义
- manual eval 导出
- eval batch compare

## 当前未落地能力

下面这些不要误写成现状：

- `summary_text` 参与 recall
- `sessions_fts` 或 session/resource 独立搜索面
- 真正按 broad/exact query profile 分权的 scoring
- richer projection / event replay / range cache
- duplicate collapse / diversity control
- 强约束 gold set / rubric / error taxonomy

## 为什么当前文档改成这版

之前的 tracking/research 文档混合了三种内容：

- 当前实现
- 目标态建议
- 外部调研结论

这种写法会误导后续 agent 把“建议”当成“现状”。这里保留的只有当前代码真相；后续计划单独放到 [docs/ROADMAP.md](/Users/envvar/work/repos/cxs/docs/ROADMAP.md)。
