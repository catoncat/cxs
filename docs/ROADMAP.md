# cxs Roadmap

## 当前判断

`cxs` 现在已经有一条可用的 retrieval 主链。`title + summary_text + compact_text + reasoning_summary_text` 已作为 session-level recall 面接入，并通过 FTS5 column weights 显式分权；下一步仍不该盲目继续堆排序逻辑，当前最缺的是更可信的 acceptance gate。

## 优先级

### P0: 先补强 eval 基线

目标：让后续 retrieval 调整有稳定证据，不再只靠感觉。

当前现状：

- [eval/manual-queries.json](/Users/envvar/work/repos/cxs/eval/manual-queries.json) 只有 18 条 seed query
- [eval/manual-eval-core.ts](/Users/envvar/work/repos/cxs/eval/manual-eval-core.ts) 只支持弱谓词：
  - `title_or_summary`
  - `cwd`
  - `snippet`
- [eval/run-dogfood-eval.ts](/Users/envvar/work/repos/cxs/eval/run-dogfood-eval.ts) 已提供本机 dogfood golden runner：
  - 读取 ignored JSONL golden 文件
  - 支持为单个 golden 描述真实检索 workflow：多 query attempt、`sort`、cwd/selector scope、排除 self-hit session
  - 检查 expected session / cwd / matchSource / context key phrase
  - 每个 attempt 会落盘 find/context artifact，scorecard 会标出最终采用的 attempt
  - `hard` 失败会以非零退出阻断本机 gate
  - `candidate` 失败只报告，不阻断

建议动作：

- 扩充真实 query 集
- 继续用 dev-only `~/.agents/skills/cxs-dogfood` 手动策展本机 dogfood golden；不要把私有样本放进发行 skill package
- 增加更强断言：
  - session 是否对
  - `read-range` 是否给出有用上下文
  - 是否命中关键 message / key phrase
- 对“最近本项目 / self-hit / 文件名近似”这类真实 agent workflow，优先用 dogfood 的 `find` workflow 字段表达当前可复现路径，再决定是否沉淀成正式 CLI 选项（例如 `--cwd`、`--exclude-current`、`recent`）
- 继续复用现有：
  - `npm run eval:manual`
  - `npm run eval:dogfood -- <goldens.local.jsonl>`
  - `npm run eval:compare -- <before> <after>`

### P1: 已补 session-level 字段召回

目标：解决“正文不命中、只有 title / summary / compact handoff 命中”的 recall 漏洞。

当前现状：

- `messages_fts` 负责真实 message evidence recall
- `sessions_fts(title + summary_text + compact_text + reasoning_summary_text)` 负责 session-level recall
- 字段权重固定为：title 8.0、compact 4.0、summary 3.0、reasoning summary 1.2
- session-only 命中返回 `matchSource = "session"`，且 `matchSeq = null`
- CLI 对 session-only 命中建议 `read-page`，不伪造 `read-range --seq`

已经排除：

- 不把 summary 写成 `seq = -1` 的虚拟 message
- 不新增 `session_projections` 业务表

后续需要补：

- 把 title/summary/compact-only query 加进 manual eval
- 对 session-only 命中补专门断言

### P2: 真正的 query profile 分流

目标：让 broad / exact query 的排序策略真正分开。

当前现状：

- [ranking.ts](/Users/envvar/work/repos/cxs/src/ranking.ts) 仍保留 `classifyQueryProfile()`
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
