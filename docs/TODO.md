# Sherlog TODO

本页只列当前 checkout 之后的可执行工作；总体排序见 [ROADMAP.md](ROADMAP.md)。Production CLI 已是 standalone Rust，Node/TypeScript 只保留开发期 differential oracle。

## P0: Native acceptance 与首次发布

- [x] dogfood / eval runner 默认绑定 checkout 的 `shlog`；可用 `--cli-argv-json`、`SHLOG_CLI_ARGV_JSON` 或 `SHLOG_BIN_UNDER_TEST` 覆盖。
- [ ] 用 release binary 跑 synthetic acceptance、contract differential、isolated perf 与 multi-source end-to-end fixture。
- [ ] 覆盖 initial/no-op/append sync、strict/best-effort failure、status coverage、find/read/list/stats、cold add/remove/prune 和 v7 -> v8 migration。
- [ ] 固化 macOS arm64、Linux x64 GNU 的 release asset、checksum、SBOM、attestation 与 installer verification。
- [ ] native tag/assets 发布前保持 source-ready 表述；发布后再验证安装态 `shlog --version`。本机全局 `shlog` 当前仍是旧发布版 `0.4.4`。

## P1: `incremental == full replay`

- [ ] 建立 property/state-machine tests，对每条操作序列比较 `session_rows`、`sessions` view、`source_files`、`documents`、`documents_fts`、`coverage` 与 `cold_roots` 最终状态。
- [ ] 覆盖 append、truncate、same-size/prefix rewrite、unterminated tail、rename/path identity change。
- [ ] 覆盖 hot -> cold、cold remove + prune、migration crash、残留 `.next`/WAL/SHM 与旧 writer 竞争。
- [ ] Codex delta 与 full replay 必须等价；Claude Code/Pi 的 `DeltaUnsupported` full replay 仍需同一 final-state invariant。

## P2: Retrieval 诊断

- [ ] 增加 candidate -> SQL filter -> exact verify -> grouped session -> returned result 各阶段计数。
- [ ] 增加明确的 `matchMode`、`weakMatch`/reason 与 zero-result reason，区分 coverage、candidate、filter、ranking、evidence-read 问题。
- [ ] 保持默认 payload 精简，并确保 debug 计数不暴露 privacy-filtered projection 之外的 raw 内容。
- [ ] 在测试里锁定 conservative candidate superset、SQL filter pushdown 与 ranking/evidence anchor 分离。

## P3: Source 与 eval hardening

- [ ] 为 Codex、Claude Code、Pi 增加 source-specific negative privacy fixtures 与 upstream format drift cases。
- [x] 补 title/summary/compact/reasoning-only hit、`matchSource=session`、`matchSeq=null` 与 `evidenceRead` 可执行性断言（anchor_not_found + 闭包 command，见 app/tests 与 contract gate）。
- [ ] 持续验证 default cross-source find、selector isolation、coverage 不跨 source、sessionRef round-trip。
- [ ] private dogfood 只由用户显式触发 dev-only skill 采集；不通过改 golden 或 hardcode query 修实现。

## Eval 证明收益后再做

- 仅对 title/cwd/model/identifier 的 zero-result 路径探索受控 typo fallback；不对正文做无界 fuzzy。
- evidence-read frecency 只能是有上限、短半衰期的 tie-breaker，并防 self-hit 与反馈循环。
- 独立 stage-2/resource reranker、richer projection、duplicate family collapse/diversity、vector retrieval。

不做 watcher/daemon/realtime sync，不引入 LMDB 或第二持久化真相源，也不把 FFF 的常驻内存索引生命周期搬进短命 CLI。
