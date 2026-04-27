---
name: cxs
description: "用于用户要找本机 Codex 历史会话或 ~/.codex/sessions 上下文：之前、上次、前几天、我记得、我们讨论过、翻旧 session、找那次命令、历史对话、Codex history、previous/earlier/last Codex chat。不要用于当前仓库代码搜索、外部文档、今日提交/日报或当前会话收尾。"
---

# cxs

用 `cxs` 在 `~/.codex/sessions` 里检索旧 Codex 对话。目标是先定位候选 session，再局部扩上下文，最后才翻全页，不要冷启动整批 JSONL。

## 安装

```bash
npx skills add catoncat/cxs --skill cxs -g -a codex -y
```

CLI install guide: https://github.com/catoncat/cxs#cli-install-guide

这个 skill 只提供 agent 工作流，不安装 `cxs` CLI 本体。若用户询问安装方式，指向 README 的 CLI install guide，并提醒安装或更新 skill 后需要重启 Codex / 开新 session。

## 路径前提

这个 skill 只包含说明和参考资料，不会把 `cxs` CLI 二进制一起装进你的系统。

使用前请满足下面任一条件：

- `cxs` 已经在 `PATH` 里
- 或设置了 `CXS_BIN=/absolute/path/to/bin/cxs`

所有命令默认都写成：

```bash
"${CXS_BIN:-cxs}" <subcommand> ...
```

使用前先验证命令面确实是 cxs：

```bash
"${CXS_BIN:-cxs}" --version
"${CXS_BIN:-cxs}" --help
```

如果 `--version` 没有输出 cxs 版本，或 `--help` 没有列出 `sync/find/read-range/read-page/list/stats/current`，不要继续猜；改用 `CXS_BIN=/absolute/path/to/bin/cxs`，或先让用户完成 CLI install guide。

这样可以同时兼容：

- 你自己安装到 `PATH` 的 `cxs`
- 本地 checkout 里的 `bin/cxs`
- 其他自定义路径

## 什么时候用 cxs

| 场景 | 用什么 | 原因 |
| --- | --- | --- |
| 用户问“之前 / 上次 / 我记得 / 我们讨论过” | `cxs` | 目标是历史 session，不是当前 repo |
| 用户给了旧项目名、cwd、时间窗口 | `cxs list` 起手 | 先按 `cwd/since` 缩范围比全文搜更稳 |
| 用户问“最近本项目 / 这个 repo 做过什么讨论” | `cxs list --cwd <current-repo>` 起手 | 先圈出当前 repo 里的候选 session，再做主题判定 |
| 用户记得某个旧命令、旧报错、旧方案关键词 | `cxs find` 起手 | 先拿 `sessionUuid + matchSeq` |
| 当前仓库代码/字符串搜索 | 代码搜索工具 | 那是代码库，不是 session 历史 |
| 当前文件或已知路径阅读 | 文件读取工具 | 不需要走 session 索引 |
| 外部文档/网页/产品资料 | WebFetch / WebSearch | 不在本机 Codex 历史里 |
| 今日提交/日报 | commit-daily-summary | 目标是 git，不是 session |
| 当前会话收尾 | session-wrap | 目标是本轮工作，不是旧对话 |

## 什么时候不要用 cxs

- 用户要搜当前 repo 代码、配置、测试、文档
- 用户要查外部网站、官方文档、最新信息
- 用户要总结今天提交、项目日报、当前会话
- 你已经知道具体 JSONL 文件路径且只需直接读原文
- 没有 `sessionUuid` 时，不要一上来 `read-page`

## 前置

- 先用 `stats --json` 看 `dbPath`、`lastSyncAt`、`sessionCount`
- 如果 `stats --json` 提示索引不存在，先跑 `sync`
- 用户明确说“最近那次”“我刚做过”，但 `lastSyncAt` 很旧或 `find`/`list` 零结果时，先跑 `sync`
- `sync` 默认严格模式；任一文件失败都会非零退出且不提交半截索引
- 只有用户接受部分成功时才加 `--best-effort`
- 从别的 cwd 调用时，若默认 db 不对，显式传 `--db`

## 三步渐进式检索

1. 如果用户给了项目名、cwd、时间窗，先缩范围：

```bash
"${CXS_BIN:-cxs}" list --cwd hammerspoon --since 2026-04-15 --json
```

如果用户说“本项目 / 这个 repo”，把 `<cwd>` 直接换成你当前工作目录路径。

2. 常规入口永远先 `find`，不要冷启 `read-page`：

```bash
"${CXS_BIN:-cxs}" find "cf tunnel" --json -n 5
```

先看这些字段：

- `results[].sessionUuid`
- `results[].matchSource`
- `results[].matchSeq`
- `results[].cwd`
- `results[].startedAt`
- `results[].matchCount`
- `results[].summaryText`
- `results[].snippet`

3. 拿最像的候选做局部扩窗：

```bash
"${CXS_BIN:-cxs}" read-range <sessionUuid> --seq <matchSeq> --before 4 --after 8 --json
```

4. 如果你已经锁定某个 session，但想在它内部重定位锚点，用：

```bash
"${CXS_BIN:-cxs}" read-range <sessionUuid> --query "IME" --before 4 --after 8 --json
```

5. 只有在 `read-range` 仍不够时，才升级到整页浏览：

```bash
"${CXS_BIN:-cxs}" read-page <sessionUuid> --offset 0 --limit 40 --json
```

工作流心法：

- 永远先 `find`，不要直接 `read-page`
- `matchSource=session` 表示命中来自 title / summary / compact / reasoning summary 等 session-level 字段，且 `matchSeq=null`；这种结果先 `read-page`，不要伪造 `read-range --seq`
- 升级到 `read-page` 之前，先尝试放大 `--before/--after`
- 用户给出 `cwd` 或时间窗口时，优先 `list` 缩范围再 `read-range --query`
- `cwd` 只是候选过滤，不是主题真相；还要再看 `title`、`summaryText`、开头几条 message
- 同主题可能返回多个不同 `sessionUuid`；按 `cwd`、`startedAt`、`matchCount` 选，不要按 title 脑补去重

## JSON 模式速查

- `find --json`：顶层是 `{ query, results }`；重点看 `sessionUuid`、`matchSource`、`matchSeq`、`summaryText`、`snippet`
- `read-range --json`：重点看 `anchorSeq`、`rangeStartSeq`、`rangeEndSeq`、`messages[]`
- `read-page --json`：重点看 `offset`、`limit`、`totalCount`、`hasMore`
- `list --json`：重点看 `results[].cwd`、`startedAt`、`endedAt`、`messageCount`
- `stats --json`：重点看 `lastSyncAt`、`dbPath`、`indexVersion`
- `sync --json`：重点看 `errors`、`errorDetails[]`
- 完整字段见：`references/json-schema.md`

## 常用排障

| 症状 | 先跑什么 | 怎么处理 |
| --- | --- | --- |
| `find` 零结果但用户坚持存在 | `stats --json` | 先看 `lastSyncAt`，必要时 `sync` |
| `sync` 非零退出 | `sync --json 2>&1` | 看 `errorDetails[]` |
| `stats/list/find` 报 `database is locked` | 同命令先重试一次 | 还是忙就先跳过 `stats` 直接读 |
| 同主题出现多条 uuid | `find -n 10 --json` | 按 `cwd`、`startedAt`、`matchCount` 选 |
| 用户问“最近本项目讨论了什么” | `list --cwd <current-repo> --sort ended --json` | `cwd` 只先圈候选，再抽样确认主题 |
| 中文关键词搜不到 | 换至少两字中文或英文关键词 | 详见 `references/failure-cookbook.md#cjk-zero-results` |
| 用户说“在 X 项目里” | `list --cwd X --json` | 先按 cwd 缩范围 |
| 从别的 cwd 调用找不到 db | `stats --json` | 看 `dbPath` 或显式传 `--db` |

## 参考

- `references/cli-surface.md`
- `references/json-schema.md`
- `references/progressive-workflow.md`
- `references/advanced-queries.md`
- `references/failure-cookbook.md`

# skill-sync: repo-shared cxs skill, PATH-or-CXS_BIN mode, 2026-04-22
