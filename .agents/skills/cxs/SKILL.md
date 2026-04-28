---
name: cxs
description: "用于用户要找本机 Codex 历史会话或 ~/.codex/sessions 上下文:之前、上次、前几天、昨天、我记得我配过、我试过、我们讨论过、翻旧 session、找那次命令、历史对话、Codex 历史、session 历史。Also triggers on English: 'last time I', 'earlier session', 'did we already', 'I remember configuring', 'previous codex chat', 'search my codex history'. 不要用于当前仓库代码搜索(Grep)、读当前文件(Read)、外部文档(WebFetch/WebSearch)、今日提交/日报(commit-daily-summary)或当前会话收尾(session-wrap)。"
---

# cxs

用 `cxs` 在 `~/.codex/sessions` 里检索旧 Codex 对话。心法:**先定位候选 session,再局部扩上下文,最后才翻全页**——不要冷启动整批 JSONL。

## 安装(两步)

**1. 装 cxs CLI 二进制**(本 skill 不带 binary,只是 agent 工作流):

详见 README 的 [CLI Install Guide](https://github.com/catoncat/cxs#cli-install-guide)。安装后做一次 sanity:

```bash
"${CXS_BIN:-cxs}" --version       # 应输出 cxs 版本号
"${CXS_BIN:-cxs}" --help          # 应列出 sync/find/read-range/read-page/list/stats/current
```

如果 `cxs` 不在 PATH 里,设 `export CXS_BIN=/absolute/path/to/bin/cxs`。

**2. 装 skill**:

```bash
# Codex agent runtime
npx skills add catoncat/cxs --skill cxs -g -a codex -y

# Claude Code / Anthropic agent runtime — 把 -a codex 换成对应 runtime,或省略
```

`-a` 取值依赖目标 agent runtime,**装错 slot 会看不到 skill**。装完通常需要重启 agent / 开新 session。

## 什么时候用 cxs

| 场景 | 起手 | 原因 |
| --- | --- | --- |
| 用户问"之前 / 上次 / 我记得 / 我们讨论过" | `cxs find` | 先拿 `sessionUuid + matchSeq` |
| 用户问"本项目最近的对话",且不确定是否 sync 过 | `cxs current` | 直读 Codex state DB,零索引依赖 |
| 用户给项目名 / cwd / 时间窗,且 cxs 已 sync | `cxs list --cwd ... --since ...` | cwd/since 缩范围比全文搜更稳 |
| 已锁定某 session,需要局部上下文 | `cxs read-range --seq` 或 `--query` | 局部扩窗,不冷启 `read-page` |

**反例**(应该用别的工具):

- 当前 repo 代码/字符串搜索 → 代码搜索工具
- 当前文件或已知路径阅读 → 文件读取工具
- 外部文档/网页 → WebFetch / WebSearch
- 今日提交/日报 → `commit-daily-summary`
- 当前会话收尾 → `session-wrap`

## 工作流心法

- **find → read-range → read-page**:永远先 `find` 拿候选,不要冷启 `read-page`
- `matchSource = "session"` 时 `matchSeq = null`;这种命中先 `read-page` 抽样,**不要伪造 `read-range --seq`**
- 用户给 cwd 但不确定 sync 状态 → `current`(零索引依赖);cxs 已 sync → `list`(全索引)
- `cwd` 只是候选过滤,不是主题真相;还要再看 `title`、`summaryText`、开头几条 message
- 同主题可能多个 uuid;按 `cwd / startedAt / matchCount` 选,不要按 title 脑补去重

## 前置

- 先 `stats --json` 看 `dbPath / lastSyncAt / sessionCount`
- 索引不存在、读命令返回 `index_unavailable`、或 `lastSyncAt` 很旧 → `sync`(默认严格模式;只有用户接受部分成功才加 `--best-effort`)
- `current` 不依赖 cxs 索引,即使 sync 没跑过也能用
- 从别的 cwd 调用时,若默认 db 不对,显式传 `--db`

## 参考

详细命令面、字段、流程、错误处理:

- [`references/cli-surface.md`](references/cli-surface.md) — 每个子命令的 options + Example
- [`references/progressive-workflow.md`](references/progressive-workflow.md) — 4 个 worked scenarios
- [`references/json-schema.md`](references/json-schema.md) — 完整 JSON 字段
- [`references/failure-cookbook.md`](references/failure-cookbook.md) — 错误症状速查 / state_db_unavailable 处理 / `--json` error shape 速查
- [`references/advanced-queries.md`](references/advanced-queries.md) — query 语义 / CJK 行为 / snippet 高亮

# skill-sync: repo-shared cxs skill, PATH-or-CXS_BIN mode, 2026-04-27
