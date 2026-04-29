# cxs TODO

## P0: 把 eval 升级成可用 gate

当前真正最缺的不是新排序逻辑，而是更可信的 acceptance gate。

现状：

- [eval/manual-queries.json](/Users/envvar/work/repos/cxs/eval/manual-queries.json) 只有 18 条 seed query
- [eval/manual-eval-core.ts](/Users/envvar/work/repos/cxs/eval/manual-eval-core.ts) 只支持 `title_or_summary`、`cwd`、`snippet` 这几类弱断言

下一步应该优先补：

- 更多真实 query
- 对 session 命中正确性的断言
- 对 `read-range` 可用性的断言
- 更清晰的 failure taxonomy

## P1: session-level recall 后续补强

当前 `sessions.summary_text`、`sessions.compact_text`、`sessions.reasoning_summary_text` 已经生成、存库，并通过 `sessions_fts(title + summary_text + compact_text + reasoning_summary_text)` 进入 recall 面。

已定边界：

- `messages` 仍只保存真实可回读消息
- compact handoff 与 reasoning summary 只作为 session-level 检索信号，不写成可回读 message
- session-level FTS 字段权重固定为：title 8.0、compact 4.0、summary 3.0、reasoning summary 1.2
- session-only 命中返回 `matchSource = "session"` 和 `matchSeq = null`
- 不插入 `seq = -1` 虚拟 message
- 不新增 `session_projections` 业务表

下一步应该补：

- 把 title/summary/compact-only query 写进 manual eval
- 增加对 `matchSource` / `matchSeq = null` 的断言
- 继续观察 session-level recall 是否引入排序噪音

## P2: 真正接通 broad / exact query 分流

当前 [ranking.ts](/Users/envvar/work/repos/cxs/src/ranking.ts) 还保留 `classifyQueryProfile()`，但 scoring 没有显式按 broad / exact 分权。

这件事仍然值得做，但应放在更强 eval 之后。
