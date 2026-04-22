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

## P1: summary 参与 recall

当前 `sessions.summary_text` 已经生成、存库、参与 rerank，但没有进 recall 面。

这意味着：如果一个 session 的正文和 query 不重合，只有 summary 命中，它当前不会被 `find` 召回。

候选方案：

- 插入一条 `seq = -1`、`role = "summary"` 的虚拟 message 进 `messages` + `messages_fts`
- 或者新建 `sessions_fts(title + summary_text)`，`find` 时 UNION 两路候选

当前仍不优先的原因：

- 现有 eval 下还没观察到明显 recall 漏洞
- 在更强 eval 就位前，先改 recall 面容易变成“改了很多，但证据不够硬”

## P2: 真正接通 broad / exact query 分流

当前 [ranking.ts](/Users/envvar/work/repos/cxs/ranking.ts) 还保留 `classifyQueryProfile()`，但 scoring 没有显式按 broad / exact 分权。

这件事仍然值得做，但应放在更强 eval 之后。
