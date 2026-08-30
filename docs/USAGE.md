# Sherlog Usage Guide

## Runtime 与安装状态

当前 checkout 的 production CLI 是 standalone Rust binary，内置 SQLite/FTS5，运行时不需要 Node.js。native release workflow 与 installer 已 source-ready，但本次 cutover 尚未发布新的 native tag/assets；本机全局 `shlog --version` 当前实测仍为旧发布版 `0.4.4`，不是此 checkout 的 Rust build。

从当前源码构建：

```bash
git clone https://github.com/catoncat/sherlog.git
cd sherlog
cargo build --release --locked --bin shlog
./target/release/shlog --version
./target/release/shlog --help
```

发布 native tag 后，installer 才可用于对应 assets：

```bash
curl -fsSL https://github.com/catoncat/sherlog/releases/latest/download/install.sh | sh
```

声明的 native target 仅有 macOS arm64 与 Linux x64 GNU。Intel macOS、Linux musl、Linux arm64 与 Windows 没有发布 archive。

开发 checkout 中：

```bash
cargo run --locked --bin shlog -- status --json
npm run shlog -- status --json           # Rust command 的开发包装
cargo run --locked --bin shlog -- status --json
```

最后两项只用于仓库开发；Node.js 不是 production CLI dependency。

## 固定命令面

| Command | Purpose | 写入 |
| --- | --- | --- |
| `shlog status` | live privacy-filtered inventory、index 状态与可选 requested coverage proof；cache miss 可流式读 raw | 否 |
| `shlog sync` | 扫描选中 raw transcript，建立/更新/migrate v8 index 与 coverage | 是 |
| `shlog cold add/list/remove` | 管理 prune retention root；list 只读 | add/remove 是 |
| `shlog find <query>` | 从 index 召回并排序 session candidate | 否 |
| `shlog read-range <sessionRef>` | 围绕 seq 或 query anchor 读取 message projection | 否 |
| `shlog read-page <sessionRef>` | 按 offset/limit 顺序读取 message projection | 否 |
| `shlog list` | 不做全文检索，按 metadata 列 session | 否 |
| `shlog stats` | 返回 index 统计与 stored coverage | 否 |

所有命令支持 `--db <path>`；结构化输出使用 `--json`。`find` / `read-*` / `list` / `stats` 只打开 SQLite query-only，不扫描 raw source、不隐式 sync、不隐式 migration。

## Quick start

首次建立默认 Codex index：

```bash
shlog sync
```

搜索后执行结果自带的 evidence read：

```bash
shlog find "health check" --json
shlog read-range codex:<session-id> --seq 12 --query "health check" --before 2 --after 2 --json
shlog read-page codex:<session-id> --offset 0 --limit 20 --json
```

`find` 默认 relevance。问“最新/最近一次提到 X”时：

```bash
shlog find "X" --cwd /Users/you/work/project --sort ended \
  --exclude-session codex:<current-session-id> -n 5 --json
```

不要只凭 title/snippet 回答内容问题。优先原样执行 JSON 结果的 `evidenceRead.command`（`executable:"inherit"` + `args`，已闭包 `--db/--json`）；message 太长且关键内容被省略时，在同一 read 命令上加 `--max-message-chars 0`。`read-range --query` 无 message anchor 时返回 typed `anchor_not_found`，按 nextAction 回退 `read-page`，不要伪造 seq 0。

## 从 0.4.x 升级（一次性迁移）

0.4.x 的 v7 index 是 legacy import 格式：`status` 会报告 `index.layout: legacy_v7`，内容命令（find/read/list）会返回 typed `index_schema_upgrade_required`，`nextAction` 指向一次显式 `shlog sync`。执行一次 sync 即完成迁移与 coverage 重建；迁移保留 `*.v7.bak.*` 备份、legacy cold-roots.json 被 tombstone、旧 0.4.4 writer 对 v8 fail-closed。没有自动升级命令；版本升级由 installer/brew/npm 等分发层完成。

## Source

公开值：

- `codex`
- `claude-code`（experimental transcript reader）
- `pi`（experimental transcript reader）
- `dsh`（experimental zstd transcript reader）

默认 root：

```text
codex        ~/.codex/sessions
claude-code  ~/.claude/projects
pi           ~/.pi/agent/sessions
dsh          ~/.dsh/sessions
```

`find` 省略 `--source` 时跨所有公开 source 搜索；`--source all` 等价。`status`、`sync`、`list`、`stats` 省略时默认 Codex。bare session id 也按 Codex 解释，跨 source 请直接使用 `find` 返回的 `sessionRef`：

```bash
shlog find "deployment failure" --source claude-code --json
shlog read-page claude-code:<native-session-id> --offset 0 --limit 20 --json
```

未知 source 在扫描/查询前返回 `unsupported_source`。

## Selector 与 coverage scope

CLI shortcut：

```bash
shlog sync --root /Users/you/.codex/sessions
shlog sync --cwd /Users/you/work/project
shlog status --cwd /Users/you/work/project --json
shlog find "health check" --cwd /Users/you/work/project --json
shlog list --root /Users/you/.codex/sessions --sort ended -n 10 --json
```

canonical selector JSON：

```json
{"source":"codex","kind":"all","root":"/Users/you/.codex/sessions"}
{"source":"codex","kind":"cwd","root":"/Users/you/.codex/sessions","cwd":"/Users/you/work/project"}
{"source":"codex","kind":"date_range","root":"/Users/you/.codex/sessions","fromDate":"2026-08-01","toDate":"2026-08-15"}
{"source":"codex","kind":"cwd_date_range","root":"/Users/you/.codex/sessions","cwd":"/Users/you/work/project","fromDate":"2026-08-01","toDate":"2026-08-15"}
```

`--selector` 可省略 `root` 与 `source`，CLI 会用选中 source 的默认值补齐。`--selector` 不能与 `--cwd` 组合；显式 `--source` 必须与 selector source 一致。

`status --root` 改变 inventory/default selector root；要请求明确 coverage proof，使用 `--cwd` 或 `--selector`。`status --inventory` 才返回完整 stored coverage audit 与 cwd groups。

## Storage

默认数据库：

```text
~/.local/state/shlog/index.sqlite
```

路径优先级：

1. `SHLOG_DATA_DIR`
2. legacy alias `CXS_DATA_DIR`
3. `$XDG_STATE_HOME/shlog`
4. `~/.local/state/shlog`

例如：

```bash
export SHLOG_DATA_DIR="$HOME/.config/shlog"
```

v8 `index.sqlite` 是唯一真相；没有 `index.meta.json` sidecar。核心 object 是：

- `meta`
- writable `session_rows` + read-only compatibility view `sessions`
- `source_files`
- `documents` + contentless `documents_fts`
- `coverage`
- `cold_roots`

使用者不要手工改这些表。需要 metadata projection 时可用 `sqlite3 -readonly` 查询 `sessions` view，内容证据仍用 `read-*`。

## Status 与 coverage

```bash
shlog status --json
shlog status --cwd /Users/you/work/project --json
shlog status --selector '{"kind":"date_range","fromDate":"2026-08-01","toDate":"2026-08-15"}' --json
shlog status --inventory --json
```

`status` 不返回/检索正文，也不写 index。为派生 live inventory/fingerprint，cache miss 会流式读取 raw accepted records/body，并只让 source privacy allowlist 接受的 metadata/message projection 影响 cwd/time/identity/fingerprint；rejected/private record 不影响 proof。exact `mtime_ns`/checkpoint cache hit 不重 parse。因此 cache miss 可能是 O(raw bytes)，不能描述成固定 metadata-only cost。`requestedCoverage` 的核心字段：

- `complete`
- `freshness`: `fresh | stale | missing`
- `staleReason`
- `coveringSelectors`
- `recommendedAction`: `query | sync`

`find/list` 中的 coverage 只来自 stored SQLite proof，不做 live raw scan；其 `freshness` 当前为 `not_checked`，即使 `complete=true` 也只表示存在 compatible covering record。结果仍可作为 best-effort candidate。若零结果或答案要求 latest/completeness，先运行同 selector 的 `status`：`recommendedAction=query` 时无需 sync，`recommendedAction=sync` 时才同步同范围并重试。

## Sync

常用命令：

```bash
shlog sync --json
shlog sync --cwd /Users/you/work/project --json
shlog sync --source claude-code --root "$HOME/.claude/projects" --json
shlog sync --best-effort --json
shlog sync --prune --json
shlog sync --prune --cold-root /archive/codex --json
```

默认 strict：选中输入出现 scan/parse/projection/revalidation error 时命令非零，不发布部分 complete coverage。`--best-effort` 可提交成功文件并在 `errorDetails` 报告失败，但不会把不完整运行标成 complete coverage。

增量规则：

- unchanged file 复用 projection；
- 可证明 append 从 stored cursor/checkpoint 继续；
- truncate、prefix rewrite、identity/epoch 不安全时 full replay；
- 同步中发生只追加且已读 prefix 可证明安全时可提交该 prefix，并把 coverage 标为 `source_content_changed` / `recommendedAction: query`；
- 无法证明安全的新活跃文件会 deferred，不写 complete coverage。

默认保留 raw 已消失的历史 projection。只有显式 `--prune` 才删除同 source 中 hot 与 registered cold 都不存在的 session。详见 [COLD_RETENTION.md](COLD_RETENTION.md)。

## Cold retention

```bash
shlog cold add --root /archive/codex --source codex --json
shlog cold list --json
shlog cold remove --root /archive/codex --source codex --json
```

v8 中注册信息存于 `cold_roots` 表。`cold add` 只登记 presence root，不解压/解析内容；`cold remove` 只取消登记，不删文件、不立即删 index row。下一次显式 `sync --prune` 才决定 projection 是否删除。

首次 v8 建库前的 cold add/remove 可使用 legacy one-shot config 作为 bootstrap 输入；成功 v8 sync/migration 会导入所有 source registration，并把 `cold-roots.json` 备份后替换为目录 tombstone。v8 建立后 SQLite 是唯一真相。

当前 cold-presence prune 只支持 Codex rollout filename 中的 UUID；非 Codex source 带 cold root 的 destructive prune 会 fail closed。

## v7 migration

read-only command 可以读兼容 v7 projection，但不会升级它。第一次授权 writer sync 遇到 v7 时会：

1. 锁住 writer；
2. 建立一致 backup；
3. copy stored projection 到 v8 staging；
4. 校验 counts、FTS、invariants 与 cold-only session；
5. 原子发布，失败时保留 backup/quarantine evidence。

不要在 migration 过程中同时运行旧 writer。v8 的 `sessions` 只读 view 与 cold-config tombstone 会让旧 TypeScript writer fail closed，但它们不是并发迁移的许可。

## Read options

`read-range`：

```bash
shlog read-range <sessionRef> --seq 12 --before 4 --after 8 --json
shlog read-range <sessionRef> --query "decision" --before 4 --after 8 --json
```

`--seq` 与 `--query` 可同时出现；显式 seq 决定 anchor，query 用于 snippet/elision。默认 before/after 各 2。

`read-page`：

```bash
shlog read-page <sessionRef> --offset 0 --limit 20 --json
```

两者默认每条 message 最多显示 800 chars；`--max-message-chars 0` 禁用 elision。

## Error handling

业务错误的 JSON envelope：

```json
{"error":{"code":"index_unavailable","message":"...","nextAction":{}}}
```

`index_unavailable.nextAction.commands[]` 保留兼容 `argv`，并提供可原样执行的闭包 `command`（`executable: "inherit"`、完整 `args`、`sideEffect: "write_index"`）。有确切 source 或显式 `--root/--cwd/--selector` 时，它保留失败查询的 DB 与该 scope（多 source 时每 source 一条，Codex 为 `recommended`）；无显式 scope 的跨 source find 仍给出默认 Codex `all`+`cwd` alternatives。宿主应执行 recommended（或唯一）command，并依据 side effect 决定授权，不需要让 skill 重建 sync 命令。

常见 code：`unsupported_source`、`invalid_selector`、`index_unavailable`、`index_schema_upgrade_required`、`session_not_found`、`invalid_cold_root`、`index_error`。

CLI parse error（例如漏掉 `find` query）写 stderr，保持命令行兼容文本，不包装成 JSON。strict sync 的 JSON failure report 也写 stderr；`--best-effort` report 写 stdout。

## Raw fallback

只有 `read-*` projection 明确无法保留完整 tool call、patch、长代码或原始事件时，才先用 Sherlog 定位 session，再由 agent 读取对应 hot plain JSONL 或 cold per-file zstd。raw fallback 不是 `shlog` subcommand，不应绕过 source adapter 的 privacy projection来做常规搜索。
