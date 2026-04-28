# Failure Cookbook

## 快速表

| 症状 | 先跑 | 处理 |
| --- | --- | --- |
| `find` 零结果但用户坚持存在 | `stats --json` | 看 `lastSyncAt`；必要时 `sync`；再试 `list --cwd` |
| `sync` 非零退出带 per-file errors | `sync --json 2>&1` | 看 `errorDetails[]`；默认严格模式；只在允许部分成功时加 `--best-effort` |
| `find/list/stats/read-*` 输出 `index_unavailable` | `sync` | cxs 索引还没建立；没有单独 `init`，`sync` 就是建库入口 |
| `stats/list/find` 报 `database is locked` | 原命令重试一次 | 多半是 SQLite 忙；仍失败就先跳过 `stats` 直接读 |
| 同一主题多条 uuid | `find -n 10 --json` | 按 `startedAt`、`cwd`、`matchCount` 选 |
| 中文/CJK 零结果 | 无 | 换至少两字中文、英文关键词，或先 `list --since` |
| 用户问“最近本项目讨论了什么” | `list --cwd <current-repo> --sort ended --json` | `cwd` 先圈候选，再抽样读头尾确认主题 |
| 用户说“在 X 项目里” | `list --cwd X --json` | 先按 cwd 缩范围，再在候选里 `read-range --query` |
| 从其他 cwd 调用找不到 db | `stats --json` | 看 `dbPath`；必要时显式传 `--db` |
| `current --json` 输出 `state_db_unavailable` | 看 message | Codex state DB 问题,不是 cxs 本身坏;**不要重跑 sync** |

## Find zero results but user insists it exists

```bash
"${CXS_BIN:-cxs}" stats --json
```

如果 `lastSyncAt` 很旧，先：

```bash
"${CXS_BIN:-cxs}" sync
```

## Sync non-zero with per-file errors

```bash
"${CXS_BIN:-cxs}" sync --json 2>&1
```

处理规则：

- 默认不要忽略，先看是坏 JSONL、权限问题还是别的解析失败
- 只有用户明确接受 partial index 时，才用 `--best-effort`

## index_unavailable

`find` / `read-range` / `read-page` / `list` / `stats` 都读 cxs 自己的 SQLite 索引。第一次安装后还没跑过 `sync` 时,这些命令会在 `--json` 模式下返回:

```json
{
  "error": {
    "code": "index_unavailable",
    "message": "index not found: ...",
    "dbPath": "...",
    "hint": "Run `cxs sync` first ..."
  }
}
```

处理方式:

```bash
"${CXS_BIN:-cxs}" sync
```

没有单独 `init` 命令;`sync` 会创建并更新索引。如果用户是一次性 `npx @act0r/cxs find ...`,提示他先跑 `npx @act0r/cxs sync`。

## Database is locked or SQLITE_BUSY

- 先重试原命令一次
- 如果只是想读取历史，不一定非得先拿 `stats`
- 如果你刚跑过 `sync` 或怀疑别的进程正占着 db，先等一下再重试

## Current project discussion query

用户问“最近本项目讨论了什么”时，默认先用当前 repo 绝对路径：

```bash
"${CXS_BIN:-cxs}" list --cwd /absolute/path/to/current/repo --sort ended -n 8 --json
```

然后至少再看：

- `title`
- `summaryText`
- `read-page` 开头 6 到 8 条
- `read-page` 结尾 6 到 8 条

## state_db_unavailable

`cxs current` 直读 Codex state SQLite,跟 cxs 自身索引无关。`--json` 模式下,所有 state DB 不可用都被收口成:

```json
{ "error": { "code": "state_db_unavailable", "message": "..." } }
```

`message` 三类:

| message 关键词 | 真实原因 | 处理 |
| --- | --- | --- |
| `state db not found: <path>` | Codex state DB 文件不存在 | 用户没装 codex 或 `--state-db` 路径错 |
| `missing 'threads' table` | DB 存在但缺核心表 | Codex 版本异常或库被截断 |
| `missing column(s) ...` | `threads` 表缺必需列(`id` / `rollout_path` / `cwd` / `title` / `updated_at_ms`) | 上游 Codex 改了 schema,cxs 需要适配新版 |

**关键**:这是 **Codex 端**的问题,**不要尝试 `cxs sync` 修复**——`sync` 写的是 cxs 自己的索引,跟 state DB 毫无关系。直接告知用户检查 codex 安装/版本即可。

## --json error shape 速查

不同子命令在 `--json` 下的 error 形状不一致,解析时按命令分流:

| 命令 | error 出口 | 形状 |
| --- | --- | --- |
| `sync`(per-file 错) | stderr | `SyncSummary`,看 `errors / errorDetails[]` |
| `sync`(锁超时 `SyncLockTimeoutError`) | stderr | `{ "error": <message string> }` |
| `current`(state DB 问题) | stdout | `{ "error": { "code": "state_db_unavailable", "message": "..." } }` |
| `find / read-range / read-page / list / stats`(索引不存在) | stdout | `{ "error": { "code": "index_unavailable", "message": "...", "dbPath": "...", "hint": "..." } }` |
| `find / read-range / read-page / list / stats`(其他异常) | 进程异常退出 | 直接非零退出 |

**实务**:解析前先看 exit code;非零再判断是结构化(`current` / 缺索引读命令)还是字符串(`sync` 锁超时)还是 summary(`sync` per-file)。

## Schema drift

source of truth 永远是：

- 仓库内 `types.ts`
- 仓库内 `cli.ts`

如果字段、命令、flag 变了：

- 先更新 `references/*.md`
- 再更新 `SKILL.md`
- 最后 bump `skill-sync` 日期

## 来源

- 仓库内 `cli.ts`
- 仓库内 `types.ts`
- 仓库内 `env.ts`
- 仓库内 `query.ts`
