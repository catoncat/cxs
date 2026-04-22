# cxs Roadmap

## 当前判断

`cxs` 现在已经有一条可用的 retrieval 主链，但下一步不该盲目继续堆排序逻辑。当前最缺的是一个更可信的 acceptance gate。

## 优先级

### P0: 先补强 eval 基线

目标：让后续 retrieval 调整有稳定证据，不再只靠感觉。

当前现状：

- [eval/manual-queries.json](/Users/envvar/work/repos/cxs/eval/manual-queries.json) 只有 18 条 seed query
- [eval/manual-eval-core.ts](/Users/envvar/work/repos/cxs/eval/manual-eval-core.ts) 只支持弱谓词：
  - `title_or_summary`
  - `cwd`
  - `snippet`

建议动作：

- 扩充真实 query 集
- 增加更强断言：
  - session 是否对
  - `read-range` 是否给出有用上下文
  - 是否命中关键 message / key phrase
- 继续复用现有：
  - `bun run eval:manual`
  - `bun run ./eval/compare-eval-batches.ts <before> <after>`

### P1: 再决定是否补 summary recall

目标：解决“正文不命中、只有 summary 命中”的 recall 漏洞。

当前现状：

- `summary_text` 已生成、已持久化、已参与 rerank
- 但 `find` 的候选仍只来自 `messages_fts` / LIKE

候选实现方向：

- 方案 A：把 summary 作为虚拟 message 写入 `messages` + `messages_fts`
- 方案 B：新增 `sessions_fts(title + summary_text)`，`find` 时 UNION 两路候选

当前不把它排到 P0 的原因：

- [docs/TODO.md](/Users/envvar/work/repos/cxs/docs/TODO.md) 记录的现有 eval 里，还没观察到明显 recall 漏洞

### P2: 真正的 query profile 分流

目标：让 broad / exact query 的排序策略真正分开。

当前现状：

- [ranking.ts](/Users/envvar/work/repos/cxs/ranking.ts) 仍保留 `classifyQueryProfile()`
- 但当前 scoring 没有按 `kind` 做显式不同权重

这意味着：

- 分类标签还在
- 真正的分流还没完成

### P3: 更重的 retrieval 能力

暂不优先：

- resource-level reranker
- richer projection
- duplicate family collapse / diversity control
- heavier model / vector retrieval

这些都应该建立在更强 eval 之后，而不是先上。
