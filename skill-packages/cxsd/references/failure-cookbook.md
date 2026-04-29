# Failure Cookbook

## 快速表

| 症状 | 先跑 | 处理 |
| --- | --- | --- |
| `find` 零结果但用户坚持存在 | `status --json` | 看目标 selector 是否有 coverage；必要时 `sync --selector`；再带 selector 查询 |
| `sync` 非零退出带 per-file errors | `sync --selector '<json>' --json 2>&1` | 看 `errorDetails[]`；默认严格模式；只在允许部分成功时加 `--best-effort` |
| `sync` 返回 `selector_required` | 原命令补 `--selector` | selector 必须显式，不存在默认范围 |
| `find/list/stats/read-*` 输出 `index_unavailable` | `status --json` | 索引还没建立；选择 selector 后 `sync --selector` |
| `stats/list/find` 报 `database is locked` | 原命令重试一次 | 多半是 SQLite 忙；仍失败就先跳过 `stats` 直接读 |
| 同一主题多条 uuid | `find -n 10 --json` | 按 `startedAt`、`cwd`、`matchCount` 选 |
| 中文/CJK 零结果 | 无 | 换至少两字中文、英文关键词，或先用 selector 缩范围 |
| 用户问“最近本项目讨论了什么” | `status --json` | 用当前 repo cwd 构造 selector，同步后 `list --selector` |
| 用户说“在 X 项目里” | `status --json` | 从 `sourceInventory.cwdGroups` 选择 cwd selector |
| 从其他 cwd 调用找不到 db | `stats --json` | 看 `dbPath`；必要时显式传 `--db` |

## Find zero results but user insists it exists

```bash
"${CXSD_BIN:-cxsd}" status --json
```

如果目标范围没有 coverage，先同步明确 selector：

```bash
"${CXSD_BIN:-cxsd}" sync --selector '{"kind":"cwd","root":"/Users/me/.codex/sessions","cwd":"/Users/me/work/foo"}'
```

然后查询时继续带同一个 selector。

## Sync non-zero with per-file errors

```bash
"${CXSD_BIN:-cxsd}" sync --selector '{"kind":"all","root":"/Users/me/.codex/sessions"}' --json 2>&1
```

处理规则：

- 默认不要忽略，先看是坏 JSONL、权限问题还是别的解析失败。
- 只有用户明确接受 partial index 时，才用 `--best-effort`。
- `--best-effort` 不写 complete coverage。

## index_unavailable

`find` / `read-range` / `read-page` / `list` / `stats` 都读 cxs 自己的 SQLite 索引。第一次安装后还没跑过 `sync --selector` 时，这些命令会在 `--json` 模式下返回:

```json
{
  "error": {
    "code": "index_unavailable",
    "message": "index not found: ...",
    "dbPath": "...",
    "hint": "Run `cxsd sync` first ..."
  }
}
```

处理方式:

```bash
"${CXSD_BIN:-cxsd}" status --json
"${CXSD_BIN:-cxsd}" sync --selector '{"kind":"all","root":"/Users/me/.codex/sessions"}'
```

没有单独 `init` 命令；`sync --selector` 会创建并更新索引。

## Database is locked or SQLITE_BUSY

- 先重试原命令一次。
- 如果只是想读取历史，不一定非得先拿 `stats`。
- 如果你刚跑过 `sync` 或怀疑别的进程正占着 db，先等一下再重试。

## Current project discussion query

用户问“最近本项目讨论了什么”时，默认先用当前 repo 绝对路径构造 cwd selector：

```bash
"${CXSD_BIN:-cxsd}" status --json
"${CXSD_BIN:-cxsd}" sync --selector '{"kind":"cwd","root":"/Users/me/.codex/sessions","cwd":"/absolute/path/to/current/repo"}' --json
"${CXSD_BIN:-cxsd}" list --selector '{"kind":"cwd","root":"/Users/me/.codex/sessions","cwd":"/absolute/path/to/current/repo"}' --sort ended -n 8 --json
```

然后至少再看：

- `title`
- `summaryText`
- `read-page` 开头 6 到 8 条
- `read-page` 结尾 6 到 8 条

## --json error shape 速查

不同子命令在 `--json` 下的 error 形状不一致，解析时按命令分流:

| 命令 | error 出口 | 形状 |
| --- | --- | --- |
| `sync` 缺 selector | stdout | `{ "error": { "code": "selector_required", "message": "..." } }` |
| `sync` invalid selector | stdout | `{ "error": { "code": "invalid_selector", "message": "..." } }` |
| `sync` per-file 错 | stderr | `SyncSummary`，看 `errors / errorDetails[]` |
| `sync` 锁超时 | stderr | `{ "error": <message string> }` |
| `find / read-range / read-page / list / stats` 索引不存在 | stdout | `{ "error": { "code": "index_unavailable", "message": "...", "dbPath": "...", "hint": "..." } }` |
| `find / read-range / read-page / list / stats` 其他异常 | 进程异常退出 | 直接非零退出 |

## Schema drift

source of truth 永远是：

- 仓库内 `src/types.ts`
- 仓库内 `src/cli.ts`

如果字段、命令、flag 变了：

- 先更新 `references/*.md`
- 再更新 `SKILL.md`
- 最后 bump `skill-sync` 日期

## 来源

- 仓库内 `src/cli.ts`
- 仓库内 `src/types.ts`
- 仓库内 `src/env.ts`
- 仓库内 `src/query.ts`
