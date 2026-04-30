---
name: cxs
description: "Use proactively for local Codex history and personal setup archaeology. Trigger when the user asks what was discussed/done/configured before, or asks inventory of this Mac's configured servers/VPS/nodes/accounts/domains/providers/services: 本机有哪些服务器配置/都配过啥服务/配过/配置过/装过/调过/之前/上次/刚刚/前几天/我记得/翻旧 session/历史对话. Includes '本机有哪几台服务器的配置，都配过些啥服务' even without cxs. Use before or alongside memory/live inspection. Do not use for current repo code search, known-file reads, web docs, daily summaries, or session wrap-up."
---

# cxs

用 `cxs` 在 `~/.codex/sessions` 里检索旧 Codex 对话。心法:**先定位候选 session,再局部扩上下文,最后才翻全页**——不要冷启动整批 JSONL。

## 安装(两步)

**1. 装 cxs CLI**(本 skill 不带 CLI 包,只是 agent 工作流):

详见 README 的 [CLI Install Guide](https://github.com/catoncat/cxs#cli-install-guide)。安装后做一次 sanity:

```bash
"${CXS_BIN:-cxs}" --version       # 应输出 cxs 版本号
"${CXS_BIN:-cxs}" --help          # 应列出 status/sync/find/read-range/read-page/list/stats
```

如果 `cxs` 不在 PATH 里,设 `export CXS_BIN=/absolute/path/to/bin/cxs`。

**2. 装 skill**:

```bash
# Codex agent runtime
npx skills add catoncat/cxs --full-depth --skill cxs -g -a codex -y

# Claude Code / Anthropic agent runtime — 把 -a codex 换成对应 runtime,或省略
```

`-a` 取值依赖目标 agent runtime,**装错 slot 会看不到 skill**。装完通常需要重启 agent / 开新 session。

## 什么时候用 cxs

| 场景 | 起手 | 原因 |
| --- | --- | --- |
| 用户问"之前 / 上次 / 我记得 / 我们讨论过" | `cxs status --json` | 先拿 source inventory 和 coverage |
| 用户问"本机/这台 Mac 配过什么"、"有哪些服务器/VPS/节点/服务配置" | 先 `cxs status --json`,再用关键词 `服务器 VPS 节点 服务 域名 provider ssh sing-box launchd Cloudflare` 组合查 | 这类是本机配置考古,答案常在旧 Codex session 而不是当前 memory |
| 用户问"本项目最近的对话" | 构造 `{"kind":"cwd",...}` selector 后先查 coverage,再 `list --sort ended` | 内容只从 cxs index 出来 |
| 用户问"最新/最近 + 关键词" | 先确保 selector coverage,再 `find <query> --sort ended` | `find` 默认是相关性排序,不是时间排序 |
| 用户给项目名 / cwd / 时间窗 | 显式构造 selector | cwd/date selector 比全文搜更稳 |
| 已锁定某 session,需要局部上下文 | `cxs read-range --seq` 或 `--query` | 局部扩窗,不冷启 `read-page` |

**反例**(应该用别的工具):

- 当前 repo 代码/字符串搜索 → 代码搜索工具
- 当前文件或已知路径阅读 → 文件读取工具
- 外部文档/网页 → WebFetch / WebSearch
- 只问当前 live state 且无历史配置语义 → 运行态/文件检查；但若问题带"配过/以前/本机有哪些配置"语义,先用 cxs 找历史线索再验证 live truth
- 今日提交/日报 → `commit-daily-summary`
- 当前会话收尾 → `session-wrap`

## 工作流心法

- **status → ensure coverage → find/list → read-range → read-page**:先确定覆盖边界，再回答内容问题
- `sync` 只是写入/更新 SQLite index 和 coverage;查找本身不需要 sync。只有目标 selector 的 coverage 缺失或 stale 时才 `sync --selector`
- 用 `status --selector '<json>' --json` 检查目标范围；`requestedCoverage.recommendedAction === "query"` 时直接查，`"sync"` 时才同步
- `stats.sessionCount` 很多不等于目标范围有 v6 complete coverage；fresh `{"kind":"all",...}` coverage 可以覆盖 cwd/date 子 selector
- "最新/最近 + 关键词"不要直接把默认 `find` 结果当最新；用 `find <query> --selector ... --sort ended`，必要时 `--exclude-session <current_uuid>` 排除当前会话/self-hit
- `matchSource = "session"` 时 `matchSeq = null`;这种命中先 `read-page` 抽样,**不要伪造 `read-range --seq`**
- 用户给 cwd 但不确定 sync 状态 → `status --json`;根据 source inventory 构造 cwd selector;再 `status --selector`;缺失/stale 才 `sync --selector`
- `cwd` 只是候选过滤,不是主题真相;还要再看 `title`、`summaryText`、开头几条 message
- 同主题可能多个 uuid;按 `cwd / startedAt / matchCount` 选,不要按 title 脑补去重

## 前置

- 先 `status --json` 看 `context / sourceInventory / coverage`
- 先用 `status --selector '<json>' --json` 看目标 selector 的 `requestedCoverage`
- 索引不存在、读命令返回 `index_unavailable`、或 `requestedCoverage.recommendedAction === "sync"` → `sync --selector '<json>'`
- `sync` 默认严格模式;只有用户接受部分成功才加 `--best-effort`;best-effort 不写 complete coverage
- 从别的 cwd 调用时,若默认 db 不对,显式传 `--db`

## 参考

详细命令面、字段、流程、错误处理:

- [`references/cli-surface.md`](references/cli-surface.md) — 每个子命令的 options + Example
- [`references/progressive-workflow.md`](references/progressive-workflow.md) — 4 个 worked scenarios
- [`references/json-schema.md`](references/json-schema.md) — 完整 JSON 字段
- [`references/failure-cookbook.md`](references/failure-cookbook.md) — 错误症状速查 / `--json` error shape 速查
- [`references/advanced-queries.md`](references/advanced-queries.md) — query 语义 / CJK 行为 / snippet 高亮

# skill-sync: distributable cxs skill package, coverage-first recent-query workflow, 2026-04-30
