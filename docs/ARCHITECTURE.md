# Sherlog 当前架构

## 一句话

Sherlog 是一个短命、显式同步、local-first 的 agent session 检索 CLI：生产 runtime 是 standalone Rust binary，SQLite/FTS5 是唯一持久化真相源。

```text
raw transcripts --(explicit sync)--> privacy projection in SQLite v8
                                         |
query/list/read --------------------------+--> progressive evidence read
status --(read-only allowlisted inventory scan)--> live coverage diagnosis
```

它不是 GUI、watcher、daemon、实时同步服务，也不把 raw grep 当作正常查询路径。当前公开 source 是 `codex`、experimental `claude-code`、experimental `pi` 与 experimental `dsh`。

## Runtime 与命令权限

生产入口是 `src/main.rs` 生成的 `shlog`。`eval/` 是评测 harness；用户运行 production CLI 不需要 Node.js。

| 命令 | raw source | SQLite | 是否写状态 |
| --- | --- | --- | --- |
| `status` | cache miss 流式读 raw，只派生 allowlisted inventory/fingerprint；不返回/检索正文 | query-only | 否 |
| `sync` | 有界读取选中 transcript | 建库、迁移、写 projection/coverage | 是 |
| `cold add/remove` | 只验证 root/presence | 写 `cold_roots`；无库 `add` 或 legacy-backed `remove` 可创建 metadata-only v8 | 是 |
| `cold list` | 否 | query-only | 否 |
| `find` / `read-*` / `list` / `stats` | 否 | query-only | 否 |

只读命令不会隐式 sync、migrate、ensure schema 或创建数据库。裸 `shlog sync` 是默认 Codex root 的 first-install bootstrap。

## 深模块与 seam

- `app`（`src/app/`）隐藏 CLI orchestration、输出和 coverage guidance；调用者只看到固定命令 contract。
- `sources`（`src/sources/`）是 raw-format adapter seam；adapter 负责 inventory、bounded read 与 allowlisted projection，核心层不理解各家 JSONL 细节。
- `sync`（`src/sync/`）把锁、snapshot transition、并行 parse、staging、事务发布和 prune 集中在一个 writer module。
- `index`（`src/index/`）隐藏 v7/v8 layout、query-only reader、v8 writer、SQL filter pushdown 和 invariant checks。
- `retrieval`（`src/retrieval/`）接收 storage candidate，负责 deterministic ranking、snippet、evidence-read plan 和 zero-result guidance。
- `migration`（`src/migration/`）封装 v7 -> v8 copy/verify/backup/atomic publish；普通 reader 不知道 migration 如何发生。

共享的 identity、selector、coverage 与 tokenizer 分别在 `identity.rs`、`selector.rs`、`coverage.rs`、`tokenizer.rs`。

## SQLite v8

默认路径：

```text
${SHLOG_DATA_DIR:-${CXS_DATA_DIR:-${XDG_STATE_HOME:-~/.local/state}/shlog}}/index.sqlite
```

v8 schema：

| object | 作用 |
| --- | --- |
| `meta` | schema/index/projection/analyzer/coverage epoch 与 migration receipt |
| `session_rows` | 可写的 source-aware session 主表 |
| `sessions` | 无写 trigger 的只读兼容 view，供 CLI reader 与高级 SQL 使用 |
| `source_files` | raw file identity、generation、append cursor、digest、checkpoint 与 epoch |
| `documents` | message 与 session-profile 的统一 projection |
| `documents_fts` | contentless FTS5 candidate index |
| `coverage` | 成功 sync 的 selector proof；不是历史事实数据库 |
| `cold_roots` | v8 cold retention registration 的唯一真相 |

v8 writer 固定使用 rollback `journal_mode=DELETE` 与 `synchronous=FULL`。Sherlog 的写入由外层 single-writer lock 串行化，产品也不追求 daemon 式读写并发；因此优先让 quiescent index 保持单文件，并保证 query-only 命令在 DB `0444`、目录 `0555` 时不创建 `-wal` / `-shm`。不要以 `immutable=1` 绕过 WAL sidecar：数据库仍可能被显式 sync 更新，immutable reader 在并发更新时可以读到旧 snapshot。

`documents.kind` 只有：

- `message`：可回读的真实 user/assistant transcript，带 `seq`、role、timestamp 与正文；
- `session_profile`：title、summary、compact、reasoning summary；不带 message seq。

因此 session-profile 命中会返回 `matchSource = "session"`、`matchSeq = null`，绝不会伪装成 message evidence。

`documents_fts` 使用 `content=''` 与 `contentless_delete=1`。原文只保存在 `documents`；snippet 从 JOIN 后的 projection 构造，不读取 FTS content 列。

### 兼容与 fail-closed

公共 `sessions` view 保留稳定 metadata SQL surface。物理 writer table 改名为 `session_rows`，且 view 没有 `INSTEAD OF` trigger；旧 TypeScript writer 打开 v8 后会在写入处失败，不能静默混写旧/新 schema。

v8 reader 要求当前 schema、projection epoch、analyzer epoch 和 index version。coverage epoch 过旧时仍可读兼容的 content，但不会把旧 coverage 报成 complete；v8 writer 对任一 epoch/version mismatch 都 fail closed。

## Source projection 与隐私

每个 source adapter 只投影 allowlisted session metadata、user/assistant text 以及明确允许的 session-level handoff 字段。tool results、attachments、diagnostics、thinking、sidechain/meta 等记录默认不进入 searchable projection。

- Codex：`session_meta` / `turn_context` metadata，`event_msg` user/agent messages，允许的 compact 与 reasoning summary。
- Claude Code（experimental）：policy-approved user/assistant text 与对应 metadata。
- Pi（experimental）：session/model metadata、user/assistant text 与允许的 compaction summary。

raw transcript format 仍是 adapter implementation detail；experimental source 不构成上游格式稳定承诺。

## Sync state machine

`sync` 的主链：

```text
acquire writer lock
  -> inventory bounded snapshot
  -> compare source_files proof
  -> choose no-op / append / full replay
  -> parallel project into private stage
  -> revalidate source snapshot
  -> single SQLite transaction + invariant check
  -> publish coverage only when proof is complete
```

### Transition

- unchanged：复用现有 projection；
- proven append：从 `indexed_bytes` 与 reducer checkpoint 继续；
- truncate、prefix rewrite、identity/epoch 不安全：完整 replay 并原子替换旧 projection；
- source/file-set 在严格窗口中发生无法证明安全的变化：不发布完整 coverage。

核心验收不变量是：对同一最终 raw 状态，incremental projection 必须等于 full replay projection。当前测试覆盖 no-op/append/truncate、同步中 append/truncate、cold prune、migration crash/restore 与旧 writer fence；更完整的 property/state-machine 矩阵仍是近端 gate，不应伪装成已经完成。

### Strict、best effort 与 prune

- strict 默认：选中输入有不可接受错误时不提交部分 coverage；
- `--best-effort`：可以提交成功文件并返回 per-file errors，但不会写 complete coverage；
- 默认不删除 raw 已消失的历史 projection；
- `--prune` 才删除同 source 中 hot snapshot 与 registered cold 都不存在的 session；
- cold-present session 只被保护，不从 `.jsonl.zst` 重新建索引。

## Retrieval

### Candidate generation

Rust tokenizer 在 index/query 两侧共享：

- 非 CJK：lowercase UAX #29 words；
- CJK：连续 Han/Hiragana/Katakana/Hangul 的重叠 Unicode-scalar bigram；
- 单个 CJK scalar 无 FTS token 时，可走有界 literal LIKE fallback。

多 term FTS expression 使用 quoted term `AND`。body/title/summary/compact/reasoning 的 BM25 column weights为 `1.0 / 8.0 / 3.0 / 4.0 / 1.2`。

source、root、cwd、date、exact session 与 exclude-session 尽量直接进入 SQL `WHERE`，避免先召回全局大集合再在 app 层过滤。跨 source `find` 对单源结果做 deterministic merge。

### FFF 调研转化出的硬约束

FFF 的收益来自常驻内存 index 与 watcher，不适合照搬到 Sherlog 的短命 CLI。Sherlog 只吸收三条架构约束：

1. 任何未来快速预过滤器只能排除“可证明不匹配”的记录，必须输出 conservative candidate superset，不能制造 false negative；tokenizer、delta 或 source 状态不确定时保守纳入。
2. append delta 是优化，不是第二语义；incremental 结果必须与 unsafe/full replay 相等。
3. selector/session/date/exclude 等约束在 SQL candidate generation 下推；candidate score 与最终 message evidence anchor 始终分离。

本次 cutover 不引入 watcher/daemon、LMDB、每进程内存 bigram 主索引、全正文 fuzzy 或 frecency。阶段计数与 `weakMatch`/`matchMode` 可观测性属于后续 eval-driven 工作，不是当前公共 contract。

### Rank 与 progressive read

storage 只返回 candidate evidence；`retrieval` 聚合到 session 后使用 FTS score、phrase/term coverage、message role、profile field、hit count、cwd signal 与有界 recency 等 deterministic signal 排序。

`find` 结果附带：

- `matchedFields`：message/title/summary/compact/reasoningSummary provenance；
- `sessionMessageCount`：继续读取的成本提示；
- `evidenceRead.command`：`executable:"inherit"` + 闭包 `--source/--db/--json` 的 `args`（`sideEffect:"read_index"`），应原样拼接执行的 `read-range` 或 `read-page`。

常规回答必须来自 `read-range` / `read-page` projection。只有 projection 明确缺少完整 tool call、patch、长代码或原始事件时，agent 才可先定位 session，再做 agent-side raw fallback；raw fallback 不是 `shlog` 查询能力。

## Coverage

coverage 是“某次成功 sync 对 canonical selector 完成了多少 projection”的存储证明：

- fresh `all(source, root)` 可覆盖同 source/root 的更窄 selector；
- coverage 从不跨 source/root；
- `find/list/read/stats` 只报告 index 中的 stored coverage，不用 raw source 伪造 freshness；`find/list` 的 `CoverageStatus.freshness` 是 `not_checked`，即使存在 covering record，`read/stats` 只返回 stored entries/rows；
- `status --cwd/--selector` 可 live 建立 privacy-filtered inventory snapshot，并把 stored coverage 与当前 snapshot 对比；cache miss 可能流式读取 raw bytes，但只让 allowlisted accepted records 影响 proof，cache hit 以 exact `mtime_ns`/checkpoint 避免重 parse；
- 未指定 selector 的 `list` 不把任意窄 coverage 当全局 complete；无显式 selector 的 `find` 则按各 source 默认 all-root 解释 coverage。

coverage 缺失或 stale 时，query 结果仍可能有用，但不能据此做完整性结论。需要 live proof 时先用同 selector 的 `status`；仅当 `recommendedAction=sync`，或答案明确依赖尚未索引的最新尾部时，才执行同范围 `sync`。

## v7 -> v8 migration

v7 index 可由 query-only reader 读取。只有授权 writer 路径需要升级时才执行 migration：

1. 获取与 sync 共用的 writer lock，检查 v7 schema，并严格读取旧版本留下的 regular/missing/已发布 legacy cold state；
2. 创建一致 v7 backup；
3. 把 stored projection 与一次性导入的 cold registrations 复制到私有 v8 staging，包括 hot raw 已不存在的 cold-only session；
4. 独立校验 counts、FTS、source proof 与 invariant，再 fsync/seal staging；
5. cold fence preflight 创建永久的 private `0700` state directory；regular JSON 以 `cold-roots.v7.json` hard link 保存在其中，同时重新验证 v7 与 legacy state 未变；
6. **先**把 canonical `cold-roots.json` 发布为指向该目录的单组件 relative symlink；missing path 使用 create-if-absent symlink，不能覆盖竞态中新出现的 JSON；
7. **再**原子发布 v8 DB、确认 durability，并复核 cold fence 与 v8 copy。失败时保留 backup/quarantine evidence；即使 post-publish verification 恢复 v7 DB，也不撤销已发布的 cold fence。

当前 native CLI 不创建或更新 legacy JSON；没有 v8 的 `cold add`（以及存在 legacy state 的 `cold remove`）直接创建 metadata-only v8。filesystem fence 只阻止旧 writer 重新按 canonical pathname 打开文件：发布前已经打开的旧 FD 仍可能在 post-check 后修改 hard-linked backup，这个窗口无法在用户态完全线性化。出现 fence/cutover error 时应先停止旧 writer 再重试，绝不能删除 canonical symlink、target directory 或 recovery backup。

read-only command 不会移动 legacy data dir 或触发上述流程。

## 发布状态

源码、native installer 与 release workflow 已 source-ready。声明的 archive target 只有：

- macOS arm64：`aarch64-apple-darwin`（仅 Apple Silicon）
- Linux x64 GNU：`x86_64-unknown-linux-gnu`（非 musl）

本次 cutover 尚未发布 native tag/assets，因此不能把现有 GitHub/npm release 或全局 `shlog` 当作上述 Rust build；本机全局 `shlog --version` 当前仍为旧发布版 `0.4.4`。详情见 [RUST_ARCHITECTURE.md](RUST_ARCHITECTURE.md)。
