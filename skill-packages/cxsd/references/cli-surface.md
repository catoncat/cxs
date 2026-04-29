# cxsd CLI Surface

命令默认写法：

```bash
"${CXSD_BIN:-cxsd}" <subcommand> ...
```

如果你没有把 `cxsd` 放进 `PATH`，先：

```bash
export CXSD_BIN=/absolute/path/to/bin/cxsd
```

没有单独的 `init` 命令。首次安装后先跑 `status --json`，根据返回的 `context.root`、`sourceInventory.cwdGroups` 和问题范围构造 selector，再跑 `sync --selector '<json>'`。

缺少 cxs 索引时,`find` / `read-range` / `read-page` / `list` / `stats --json` 返回:

```json
{ "error": { "code": "index_unavailable", "message": "...", "dbPath": "...", "hint": "..." } }
```

## status

Purpose: 返回执行上下文、source inventory、index 状态和 coverage 状态。`status` 可以扫描 raw session metadata，但不回答内容问题、不写 index。

Example:

```bash
"${CXSD_BIN:-cxsd}" status --json
```

Selector shapes:

```json
{"kind":"all","root":"/Users/me/.codex/sessions"}
{"kind":"date_range","root":"/Users/me/.codex/sessions","fromDate":"2026-04-01","toDate":"2026-04-30"}
{"kind":"cwd","root":"/Users/me/.codex/sessions","cwd":"/Users/me/work/foo"}
{"kind":"cwd_date_range","root":"/Users/me/.codex/sessions","cwd":"/Users/me/work/foo","fromDate":"2026-04-01","toDate":"2026-04-30"}
```

## sync

Purpose: 按显式 selector 扫描本地 sessions 并同步到 SQLite 索引。

Options:

| option | 说明 |
| --- | --- |
| `--selector <json>` | 必填;结构化同步范围 |
| `--db <path>` | 覆盖默认数据库 |
| `--best-effort` | 即使部分文件失败也继续写入成功部分;不写 complete coverage |
| `--json` | 成功时把 `SyncSummary` 打到 stdout |

严格模式成功时，`sync` 会先把 selector 范围内的 index 与当前 source snapshot 对齐；源文件已删除、被过滤或不再能解析成 session 的旧 row 会被移除，并计入 `removed`。

Example:

```bash
"${CXSD_BIN:-cxsd}" sync --selector '{"kind":"cwd","root":"/Users/me/.codex/sessions","cwd":"/Users/me/work/foo"}' --json
"${CXSD_BIN:-cxsd}" sync --selector '{"kind":"all","root":"/Users/me/.codex/sessions"}' --json 2>&1
```

## find

Purpose: 搜索相关 session，返回最小必要命中。

Example:

```bash
"${CXSD_BIN:-cxsd}" find "cf tunnel" --json -n 5
"${CXSD_BIN:-cxsd}" find "cf tunnel" --selector '{"kind":"cwd","root":"/Users/me/.codex/sessions","cwd":"/Users/me/work/foo"}' --json -n 5
```

## read-range

Purpose: 围绕命中点读取局部上下文。

Notes:

- 必须显式传 `<sessionUuid>`
- 必须二选一提供 `--seq` 或 `--query`

Example:

```bash
"${CXSD_BIN:-cxsd}" read-range <sessionUuid> --seq 12 --before 4 --after 8 --json
"${CXSD_BIN:-cxsd}" read-range <sessionUuid> --query "IME" --before 4 --after 8 --json
```

## read-page

Purpose: 顺序分页读取某个 session 的消息。

Example:

```bash
"${CXSD_BIN:-cxsd}" read-page <sessionUuid> --offset 0 --limit 40 --json
```

## list

Purpose: 列出已索引 session，不做全文检索。

Example:

```bash
"${CXSD_BIN:-cxsd}" list --selector '{"kind":"cwd_date_range","root":"/Users/me/.codex/sessions","cwd":"/Users/me/work/foo","fromDate":"2026-04-15","toDate":"2026-04-30"}' --sort ended --json
```

## stats

Purpose: 展示索引状态统计。

Example:

```bash
"${CXSD_BIN:-cxsd}" stats --json
```

## 来源

- 仓库内 `cli.ts`
- 仓库内 `env.ts`
- 仓库内 `README.md`
