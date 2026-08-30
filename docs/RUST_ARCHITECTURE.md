# Rust cutover architecture

## 状态

当前 checkout 已完成 production runtime cutover：`shlog` 是 standalone Rust CLI，bundled SQLite/FTS5，不要求用户安装 Node.js。TypeScript 保留在 `src/` 仅用于 differential oracle、旧 v7 fixture 与 eval harness。

源码、installer、Homebrew formula template 与 native release workflow 已 source-ready；**本次 cutover 尚未发布 native tag 或 native assets**。因此：

- `target/release/shlog` 代表当前本地 Rust build；
- 本机当前 `PATH` 上的 global `shlog --version` 实测为旧发布版 `0.4.4`，不是此 checkout 的 Rust build；
- 现有 GitHub/npm release 不能被描述为这次 native cutover；
- 只有 tag workflow 成功并回读 assets 后，才能声称 native release 已发布。

## 决策

Rust 重写的目标不是把原 TypeScript 逐文件翻译，而是把产品 contract 收敛为：

```text
one short-lived binary
+ explicit sync
+ one persistent SQLite truth
+ source adapters with privacy projection
+ query-only reads
+ progressive evidence retrieval
```

保留：

- 固定命令面与主要 JSON contract；
- manual scoped sync 与 coverage；
- Codex、experimental Claude Code/Pi source；
- cold-only historical projection；
- source-aware `sessionRef`；
- message evidence 与 session-profile recall 的区分。

删除或降级为 development-only：

- Node.js production runtime；
- npm CLI packaging/publishing；
- Node / `node:sqlite` oracle runtime loading；
- metadata sidecar；
- 两套 production command entrypoint。

明确不引入：watcher/daemon、LMDB/第二 truth、vector store、默认 fuzzy search、每次 CLI 启动重建内存 bigram index。

## Package 与 binary

根 `Cargo.toml` 就是 production package `sherlog-cli`，binary：

```text
name: shlog
path: src/main.rs
```

关键依赖：

- `rusqlite` + `bundled`：把 SQLite/FTS5 随 binary 构建；
- `clap`：固定 CLI parser；
- `serde` / `serde_json`：public contract；
- `rayon` / `crossbeam-channel`：bounded parallel projection；
- `blake3` / `sha2`：source/migration proof；
- `unicode-segmentation` / `unicode-script`：deterministic tokenizer；
- `walkdir`：source/cold inventory。

生产模块：

```text
src/
  app/          command orchestration, output, status
  sources/      raw adapters and privacy projection
  sync/         lock, transition, stage, commit, cold retention
  index/        v7 reader, v8 reader/writer/schema
  retrieval/    candidate/ranking/read/evidence guidance
  migration/    v7 -> v8 copy/verify/atomic publish
  cli.rs        command surface
  runner.rs     parse/dispatch/error routing
  model.rs      JSON/data contracts
  identity.rs   source-aware session identity
  selector.rs   scope and implication
  coverage.rs   stored/live proof evaluation
  tokenizer.rs  index/query token contract
```

## v8 storage contract

`PRAGMA user_version = 8`。关键 object：

- `meta`
- writable `session_rows`
- read-only compatibility view `sessions`
- `source_files`
- `documents`
- contentless `documents_fts`
- `coverage`
- `cold_roots`

四个 version axis 不得混用：

- schema version；
- projection epoch；
- analyzer epoch；
- coverage epoch / index version。

Reader 对 schema/projection/analyzer/index mismatch fail closed。coverage epoch 过旧不应使兼容 content 不可读，但所有 stale coverage 必须被 suppress。Writer 要求全部 axis 当前，不能“顺手修 meta”后继续写。

物理 table 使用 `session_rows`，公共 SQL 使用 `sessions` view。view 没有 write trigger，既保留 advanced read compatibility，又阻止旧 TypeScript writer 静默写 v8。

## Read/write fence

| path | raw access | schema/migration | SQLite mode |
| --- | --- | --- | --- |
| `--version`/help | 无 | 无 | 不打开 DB |
| `find/read/list/stats/cold list` | 无 | 无 | query-only |
| `status` | cache-aware allowlisted inventory；miss 可流式读取 raw | 无 | query-only（若 index 存在） |
| `sync` | bounded transcript read | 可建 v8 / migrate v7 | single writer transaction |
| `cold add/remove` | root validation | 写 `cold_roots`；无库 `add` 或 legacy-backed `remove` 可创建 metadata-only v8 | same writer lock |

read-only path 不移动 legacy state。只有显式 `sync` / `cold add` / `cold remove` writer path 可以发布 legacy cold fence；native CLI 从不创建或更新 legacy JSON。

v8 的持久 journal policy 是 `DELETE + synchronous=FULL`，不是 WAL。外层 writer lock 已提供产品需要的串行写语义；这个选择让发布态 index 保持单文件，也让所有 query-only command 能在 DB `0444`、目录 `0555` 下工作且不产生 SQLite sidecar。`immutable=1` 不适用：Sherlog index 会被后续显式 sync 更新，并发时 immutable reader 可能忽略已提交 WAL 内容。

## Source 与 projection

`SourceCatalog` 提供固定 adapter registry；adapter 输出共享 `ParsedSession` / `ParsedMessage` model。每个 adapter 必须：

- bounded read；
- 将 source/native id 规范化为 `sessionKey` / `sessionRef`；
- 只投影 allowlisted user/assistant text 与允许的 profile field；
- malformed/filtered record 遵守 source contract；
- 不把 tool result、thinking、attachment、diagnostic 等默认写入搜索面。

`claude-code`、`pi` 与 `dsh` 是 experimental raw reader，不是上游格式稳定承诺。

## Incremental sync

`source_files` 把 stable base projection 与 append state 连起来：

- `mtime_ms` + nullable exact `mtime_ns` / `size` / source generation；
- `indexed_bytes`；
- head/boundary digest；
- next seq；
- reducer checkpoint；
- projection/analyzer/coverage epoch。

Transition：

- exact proof unchanged -> no-op；
- verified prefix + append -> resume reducer；
- truncate/prefix rewrite/uncertain identity -> full replay；
- mid-sync unsafe change -> strict failure或 conservative deferral。

projection 先写 private stage，再在单一 SQLite transaction 中 apply 与检查 invariant。stage/DB 在 Unix 上使用 private permissions。

硬验收属性：对相同最终 raw input，incremental result 与 full replay result 必须完全等价。当前聚焦测试已经覆盖关键 append/truncate/cold/migration/fence 场景；完整 property/state-machine 矩阵仍是近端工作。

## Retrieval

v8 将 message/profile 统一为 document：

- message document 是可回读 evidence；
- session-profile document 提供 title/summary/compact/reasoning recall signal；
- profile hit 不生成虚构 seq。

Query 使用同一 Rust tokenizer构造 quoted-term AND FTS；zero-token CJK 可走 literal LIKE。source/root/cwd/date/session/exclude constraint 下推到 SQL candidate generation。storage 输出 `CandidateEvidence`，retrieval 才做 session aggregation、ranking、snippet 与 `evidenceRead`。

### 从 FFF 吸收但不照搬

FFF 说明高速搜索的关键常常是 persistent base + incremental delta + conservative prefilter，而不只是语言。Sherlog 采用以下约束：

1. 新增快速候选层时，candidate 必须是 conservative superset，不能 false-negative；状态不确定就交给更精确层。
2. append cursor 只是 delta optimization，最终 projection semantics 由 full replay 定义。
3. scope constraint 尽量 SQL pushdown，candidate score 与 message evidence anchor 分离。

FFF 的常驻 watcher、内存 bigram bitset、LMDB、frecency 主排序不适合当前短命 CLI；本 cutover 不实现。未来若探索 typo fallback，只限 title/cwd/model/identifier 且由 eval 证明；未来若探索 evidence-read frecency，只能有上限、短半衰期并防 self-hit/feedback loop。

## Coverage

coverage 与 content projection 分离：

- sync 只有在 snapshot proof 完整时写 complete record；
- best-effort errors 不产生虚假 complete coverage；
- find/list/read/stats 只讲 v8 并只看 stored index proof；v7 库上内容命令 fail-closed 返回 typed `index_schema_upgrade_required`（nextAction 为显式 `shlog sync`），只有 migration 把 v7 当 import 格式消费；
- 无 `--root/--cwd/--selector` 的 find 解析为各 source 的 canonical default `all(root)`，recall scope == scanned count scope == coverage scope；
- status 不返回/检索正文、不写 index；inventory cache miss 可流式读取 raw，但仅以 privacy-allowlisted accepted projection 派生 live proof，exact `mtime_ns`/checkpoint cache hit 不重 parse；同 file-set 的 `source_content_changed` 会用持久化 `boundary_digest` 前缀证明区分 proven append（继续 advisory query）与 truncate/prefix/same-size rewrite（`recommendedAction: sync`）；
- `--prune` 遇 registered cold root missing/unmount/permission 时 fail closed，绝不把不可达当作空集删除 cold-only projection；
- `read-range --query` 在 session 内无 message anchor 时返回 typed `anchor_not_found`（含 `matchedProfileFields` 与闭包 read-page nextAction），不回退 seq 0；read payload 的 SessionRecord 暴露 `compactText`/`reasoningSummaryText`，profile 命中可精确读回；
- find 的 `evidenceRead.command` 以 `executable:"inherit"` + 闭包 `--source/--db/--json` 的 `args` + `sideEffect:"read_index"` 输出，custom DB 下原样执行可读回原 candidate；
- `all(root)` implication 只在同 source/root 内成立；
- analyzer/index 不兼容或 coverage epoch stale 时 suppress coverage。

## v7 -> v8 cutover

Migration 是独立 writer module，不在 reader open 时发生：

1. 获取 legacy-compatible writer lock，preflight v7，并严格读取旧版本留下的 regular/missing/已发布 legacy cold state；
2. 建立一致 v7 backup；
3. copy stored session/message/profile 与 one-shot imported cold roots，不能依赖 raw still-hot；
4. 独立 verify counts、documents、FTS、representative recall 与 invariant；
5. seal/fsync staging；
6. cold fence preflight 创建永久的 private `0700` `cold-roots.json.v8-tombstone.<nonce>/`；regular JSON 通过同 inode hard link 保存为 `cold-roots.v7.json`，然后重新验证 v7 与 legacy state；
7. **先**将 canonical `cold-roots.json` 发布为指向 state directory 的单组件 relative symlink；missing path 用 create-if-absent symlink，不能覆盖竞态中新出现的 JSON；
8. **再**atomic publish v8 DB 并确认 durability；
9. post-publish 复核 fence 与 v8 copy；失败则保留 diagnostic copy 并从 backup 恢复 v7 DB，但永久 fence 不回滚。

迁移必须保留 cold-only session。旧/新 DB 或 WAL/SHM/`.next` 冲突不会被静默覆盖，而是 quarantine 或 fail closed。没有 v8 时，`cold add`（以及存在 legacy state 的 `cold remove`）也复用同一 fence protocol 创建 metadata-only v8，而不是写 legacy JSON。

fence 的 threat boundary 是 pathname：发布前已打开原 JSON inode 的旧 FD 仍可能在 post-check 后写入 hard-linked backup，用户态无法完全线性化该窗口。出现 fence/cutover error 时先停止旧 writer 再重试；canonical symlink、target directory、transition marker 与 recovery backup 都必须保留，不能作为“清理失败产物”删除。

## Native distribution

release workflow 只构建：

| Platform | Rust target | 备注 |
| --- | --- | --- |
| macOS arm64 | `aarch64-apple-darwin` | archive + SBOM |
| Linux x64 GNU | `x86_64-unknown-linux-gnu` | Ubuntu 22.04 build，GLIBC ceiling check |

Archive 包含 executable `shlog`、`sherlog` symlink、README 与 LICENSE。release assets 还包含 SPDX SBOM、`SHA256SUMS`、installer 与 rendered Homebrew formula，并生成 provenance/SBOM attestation。

`scripts/install.sh`：

- 不调用 Node/npm/sudo；
- 默认写 `$HOME/.local/bin`；
- 校验 SHA-256；
- 可选使用 `gh attestation verify`；
- 只接受上述两类 target；
- Linux musl fail closed；
- 覆盖已有 command 需要显式 `SHERLOG_FORCE=1`。

## 四层 closeout

每次涉及行为/contract/release 的工作必须分别报告：

1. **源码层**：Rust、skill、docs、tests 是否完成/commit/seal/push；
2. **native release 层**：tag workflow 与 assets 是否真实成功；
3. **本机安装层**：`which -a shlog` / `shlog --version` 指向什么；
4. **skill 发布层**：`npx skills add -g catoncat/sherlog` 是否从 GitHub 更新。

当前状态：第 1 层 source-ready；第 2 层尚未执行；因此第 3 层不能声称已切换；第 4 层也未由这次源码修改自动更新。

## 验证 gate

Production gates：

```bash
cargo fmt --all -- --check
cargo test --workspace --all-targets --all-features --locked
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo build --release --locked --bin shlog
```

Development oracle/eval：

```bash
npm run check
npm run eval:contract -- --require-candidate --candidate-argv-json '["./target/release/shlog"]'
```

Release-sensitive changes additionally validate workflow syntax、installer shell syntax/dry-run、archive manifest 与 target-specific smoke。没有这些证据，不得写“已发布”或“全局 CLI 已更新”。
