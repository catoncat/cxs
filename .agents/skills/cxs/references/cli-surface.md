# cxs CLI Surface

命令默认写法：

```bash
"${CXS_BIN:-cxs}" <subcommand> ...
```

如果你没有把 `cxs` 放进 `PATH`，先：

```bash
export CXS_BIN=/absolute/path/to/bin/cxs
```

## sync

Purpose: 扫描本地 `~/.codex/sessions` 并同步到 SQLite 索引。

Options:

| option | 说明 |
| --- | --- |
| `--root <dir>` | 覆盖 sessions 根目录 |
| `--db <path>` | 覆盖默认数据库 |
| `--best-effort` | 即使部分文件失败也继续写入成功部分 |
| `--json` | 成功时把 `SyncSummary` 打到 stdout |

Example:

```bash
"${CXS_BIN:-cxs}" sync --json
"${CXS_BIN:-cxs}" sync --json 2>&1
```

## find

Purpose: 搜索相关 session，返回最小必要命中。

Example:

```bash
"${CXS_BIN:-cxs}" find "cf tunnel" --json -n 5
```

## read-range

Purpose: 围绕命中点读取局部上下文。

Notes:

- 必须显式传 `<sessionUuid>`
- 必须二选一提供 `--seq` 或 `--query`

Example:

```bash
"${CXS_BIN:-cxs}" read-range <sessionUuid> --seq 12 --before 4 --after 8 --json
"${CXS_BIN:-cxs}" read-range <sessionUuid> --query "IME" --before 4 --after 8 --json
```

## read-page

Purpose: 顺序分页读取某个 session 的消息。

Example:

```bash
"${CXS_BIN:-cxs}" read-page <sessionUuid> --offset 0 --limit 40 --json
```

## list

Purpose: 列出已索引 session，不做全文检索。

Example:

```bash
"${CXS_BIN:-cxs}" list --cwd hammerspoon --since 2026-04-15 --sort ended --json
```

## stats

Purpose: 展示索引状态统计。

Example:

```bash
"${CXS_BIN:-cxs}" stats --json
```

## 来源

- 仓库内 `cli.ts`
- 仓库内 `env.ts`
- 仓库内 `README.md`
