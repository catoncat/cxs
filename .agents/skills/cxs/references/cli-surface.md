# cxs CLI Surface

命令默认写法：

```bash
"${CXS_BIN:-cxs}" <subcommand> ...
```

如果你没有把 `cxs` 放进 `PATH`，先：

```bash
export CXS_BIN=/absolute/path/to/bin/cxs
```

## current

Purpose: 直读 Codex state SQLite,按 cwd 拿候选 session,**不依赖 cxs 自己的索引**(适合 sync 没跑过或刚换机器的场景)。

Notes:

- 默认 state DB 路径 `~/.codex/state.sqlite`,可用 `--state-db` 覆盖
- `--cwd` 缺省走 `process.cwd()`,直接拿当前 repo 候选
- 顶层 `{ cwd, candidates: CurrentSessionCandidate[] }`;每个 candidate 含 `sessionUuid / title / cwd / filePath / updatedAtMs`
- state DB 不存在/缺 `threads` 表/缺必需列时,`--json` 输出结构化 `{ error: { code: "state_db_unavailable", message } }`,exit code 1
- 拿到 `sessionUuid` 后通常直接 `read-page` 抽样确认,不需要再走 `find`

Options:

| option | 说明 |
| --- | --- |
| `--cwd <path>` | 指定 cwd,默认 `process.cwd()` |
| `-n, --limit <n>` | 候选条数上限,默认 100 |
| `--state-db <path>` | 覆盖默认 Codex state SQLite 路径 |
| `--json` | 输出 JSON |

Example:

```bash
"${CXS_BIN:-cxs}" current --json
"${CXS_BIN:-cxs}" current --cwd /Users/me/work/foo --json
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
