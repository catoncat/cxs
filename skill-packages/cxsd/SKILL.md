---
name: cxsd
description: "Use when the user wants to dogfood, verify, debug, or compare unpublished local cxs changes from /Users/envvar/work/repos/cxs; mentions cxsd, dev cxs, local cxs, current checkout, or latest local code. Do not use for published-version checks; use cxs there."
---

# cxsd

用 `cxsd` 跑当前本机 checkout 的 cxs 开发版。`cxsd` 只改变 CLI 实现来源,内容回答仍然只来自 cxs index。

## 本机入口

`cxsd` 是这台机器的开发版 wrapper,不等同于发布版 `cxs`:

- repo: `/Users/envvar/work/repos/cxs`
- bin: `/Users/envvar/.local/bin/cxsd`
- override: `CXSD_BIN=/absolute/path/to/bin/cxsd`

```bash
"${CXSD_BIN:-cxsd}" --version
"${CXSD_BIN:-cxsd}" --help          # 应列出 status/sync/find/read-range/read-page/list/stats,不应列 current
```

如果用户要验证 npm/npx 已发布版本,改用 `cxs` skill 和发布版 `cxs` 命令。

## 什么时候用 cxsd

| 场景 | 起手 | 原因 |
| --- | --- | --- |
| 验证当前 checkout 的 cxs 行为 | `"${CXSD_BIN:-cxsd}" status --json` | 用本地源码,不碰发布版 |
| 用户问"之前 / 上次 / 我记得 / 我们讨论过"且要试 dev 版 | `"${CXSD_BIN:-cxsd}" status --json` | 先拿 source inventory 和 coverage |
| 用户问"本项目最近的对话" | 构造 `{"kind":"cwd",...}` selector 后先查 coverage,再 `"${CXSD_BIN:-cxsd}" list --sort ended` | 内容只从 cxs index 出来 |
| 用户问"最新/最近 + 关键词" | 先确保 selector coverage,再 `"${CXSD_BIN:-cxsd}" find <query> --sort ended` | `find` 默认是相关性排序,不是时间排序 |
| 用户给项目名 / cwd / 时间窗 | 显式构造 selector | cwd/date selector 比全文搜更稳 |
| 已锁定某 session,需要局部上下文 | `"${CXSD_BIN:-cxsd}" read-range --seq` 或 `--query` | 局部扩窗,不冷启 `read-page` |

**反例**(应该用别的工具):

- 用户要验证最新发布版 / npx 行为 → `cxs` skill
- 当前 repo 代码/字符串搜索 → 代码搜索工具
- 当前文件或已知路径阅读 → 文件读取工具
- 外部文档/网页 → WebFetch / WebSearch
- 今日提交/日报 → `commit-daily-summary`
- 当前会话收尾 → `session-wrap`

## 工作流心法

- **status → ensure coverage → find/list → read-range → read-page**:先确定覆盖边界，再回答内容问题
- `sync` 只是写入/更新 SQLite index 和 coverage;查找本身不需要 sync。只有目标 selector 的 coverage 缺失或 stale 时才 `"${CXSD_BIN:-cxsd}" sync --selector`
- 用 `"${CXSD_BIN:-cxsd}" status --selector '<json>' --json` 检查目标范围；`requestedCoverage.recommendedAction === "query"` 时直接查，`"sync"` 时才同步
- `stats.sessionCount` 很多不等于目标范围有 v6 complete coverage；fresh `{"kind":"all",...}` coverage 可以覆盖 cwd/date 子 selector
- "最新/最近 + 关键词"不要直接把默认 `find` 结果当最新；用 `"${CXSD_BIN:-cxsd}" find <query> --selector ... --sort ended`，必要时 `--exclude-session <current_uuid>` 排除当前会话/self-hit
- `matchSource = "session"` 时 `matchSeq = null`;这种命中先 `read-page` 抽样,**不要伪造 `read-range --seq`**
- 用户给 cwd 但不确定 sync 状态 → `"${CXSD_BIN:-cxsd}" status --json`;根据 source inventory 构造 cwd selector;再 `"${CXSD_BIN:-cxsd}" status --selector`;缺失/stale 才 `"${CXSD_BIN:-cxsd}" sync --selector`
- `cwd` 只是候选过滤,不是主题真相;还要再看 `title`、`summaryText`、开头几条 message
- 同主题可能多个 uuid;按 `cwd / startedAt / matchCount` 选,不要按 title 脑补去重

## 前置

- 先 `status --json` 看 `context / sourceInventory / coverage`
- 先用 `"${CXSD_BIN:-cxsd}" status --selector '<json>' --json` 看目标 selector 的 `requestedCoverage`
- 索引不存在、读命令返回 `index_unavailable`、或 `requestedCoverage.recommendedAction === "sync"` → `"${CXSD_BIN:-cxsd}" sync --selector '<json>'`
- `sync` 默认严格模式;只有用户接受部分成功才加 `--best-effort`;best-effort 不写 complete coverage
- 从别的 cwd 调用时,若默认 db 不对,显式传 `--db`

## 参考

详细命令面、字段、流程、错误处理:

- [`references/cli-surface.md`](references/cli-surface.md) — 每个子命令的 options + Example
- [`references/progressive-workflow.md`](references/progressive-workflow.md) — 4 个 worked scenarios
- [`references/json-schema.md`](references/json-schema.md) — 完整 JSON 字段
- [`references/failure-cookbook.md`](references/failure-cookbook.md) — 错误症状速查 / `--json` error shape 速查
- [`references/advanced-queries.md`](references/advanced-queries.md) — query 语义 / CJK 行为 / snippet 高亮

# skill-sync: local cxsd dev skill, coverage-first recent-query workflow, 2026-04-30
