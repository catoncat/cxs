# Failure Cookbook

## 快速表

| 症状 | 先跑 | 处理 |
| --- | --- | --- |
| `find` 零结果但用户坚持存在 | `stats --json` | 看 `lastSyncAt`；必要时 `sync`；再试 `list --cwd` |
| `sync` 非零退出带 per-file errors | `sync --json 2>&1` | 看 `errorDetails[]`；默认严格模式；只在允许部分成功时加 `--best-effort` |
| `stats/list/find` 报 `database is locked` | 原命令重试一次 | 多半是 SQLite 忙；仍失败就先跳过 `stats` 直接读 |
| 同一主题多条 uuid | `find -n 10 --json` | 按 `startedAt`、`cwd`、`matchCount` 选 |
| 中文/CJK 零结果 | 无 | 换至少两字中文、英文关键词，或先 `list --since` |
| 用户问“最近本项目讨论了什么” | `list --cwd <current-repo> --sort ended --json` | `cwd` 先圈候选，再抽样读头尾确认主题 |
| 用户说“在 X 项目里” | `list --cwd X --json` | 先按 cwd 缩范围，再在候选里 `read-range --query` |
| 从其他 cwd 调用找不到 db | `stats --json` | 看 `dbPath`；必要时显式传 `--db` |

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
