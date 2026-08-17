---
name: sherlog
description: "Search local agent-session history to recover prior decisions, commands, configurations, and context from earlier sessions. Use for cross-session recall when the current task depends on what happened in a previous agent conversation, not for inspecting the current repository or summarizing the current session."
---

# Sherlog

用 `shlog` 检索本机 agent session 历史。命令语法与默认值以 `shlog --help` 和 `shlog <command> --help` 为准；本 skill 只给 help 教不了的检索决策。

## 主循环

1. **定位**：按问题选 `find` / `list` / `stats`（usage 看 `--help`）。主题或关键词明确用 `find`；已知项目/时间、关键词弱用 `list`。完成：有可读取的 candidate identity 和明确 scope。
2. **取证**：执行 candidate 的 `evidenceRead.command`，或 `read-range` / `read-page`。完成：每个历史事实都有 `read-*` 返回内容支持；`hasMore=true` 且目标上下文未解决时继续翻页，抽样则说明边界。
3. **证明范围**：只在回答依赖 latest / completeness / miss 结论时，对相同 selector 跑 `status --json`。完成：按 `recommendedAction` 决定 query、同范围 sync，或说明无法证明。
4. **报告**：不确定处明确说明；不伪造完整性或不存在的证据。

## 不变量

- `find/read/list/stats/cold list` 只读；`sync` 是唯一 content writer；`cold add/remove` 只写 retention state。只读命令不隐式 sync/migrate。
- 内容事实只能来自 `read-*`；title/snippet/profile 命中只是 candidate。
- message anchor 走 `read-range`；profile-only 命中不伪造 seq；`anchor_not_found` 时按 nextAction 回退。
- `find --cwd` 构造 exact cwd selector；`list --cwd` 是 substring filter，两者 coverage 语义不同。
- latest/completeness/miss 结论必须匹配同 selector 的 coverage proof。
- 破坏性操作（`sync --prune`、`cold remove`）只在用户明确表达删除意图后执行。
- 跨 source 读取使用 `find` 返回的 `sessionRef`，不从 UUID 猜 source。

## References（按触发条件加载）

- 遇到 typed error / zero results / 迁移升级：`references/failure-cookbook.md`
- 需要跨命令语义陷阱或 selector 形状：`references/cli-surface.md`
- 需要解析 `evidenceRead` / coverage / `nextAction` 字段：`references/json-schema.md`
- 需要具体场景示例与完成标准：`references/progressive-workflow.md`
- 需要 query/tokenizer 或只读 metadata SQL 细节：`references/advanced-queries.md`
