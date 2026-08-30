# Sherlog Agent Guide

## 项目定位

`Sherlog`（CLI 命令 `shlog`）是一个面向本机 agent session 日志的渐进式检索 CLI。生产 runtime 已切换为 standalone Rust binary，内置 SQLite/FTS5；使用者运行 CLI 不需要 Node.js。当前公开 source 包括 `codex`、experimental `claude-code`、experimental `pi` 和 experimental `dsh`。

当前接受的产品边界：

- 命令面固定为：`status`、`sync`、`cold`、`find`、`read-range`、`read-page`、`list`、`stats`
- 主工作流固定为：先按问题选择 metadata projection / semantic recall / content read / coverage diagnosis；首次安装可用 `sync` 初始化默认 Codex index，coverage 不足时才做同范围 sync
- `sync` 是唯一 content/index writer；`cold add/remove` 只写 cold retention state；其余命令只读
- `find` / `read-*` / `list` / `stats` 只读 SQLite index，不扫描 raw transcript；`status` 不返回/检索正文且不写 index，但 inventory cache miss 会流式读取 raw，仅按 privacy allowlist 派生 inventory/fingerprint
- 默认接受手动增量同步，不做 watcher / daemon / realtime sync
- 这个仓库可以作为其他工具或 GUI 的 retrieval engine，但本仓库自身不以 GUI 为目标

## 当前实现真相

- 当前生产代码在仓库根 crate：`src/` 是 Rust，生成单个 `shlog` binary。`eval/` 是 TypeScript 评测 harness，只 fork `shlog`，不再保留第二套 TypeScript CLI。
- v8 SQLite 是唯一持久化真相源：`meta`、物理表 `session_rows`、只读兼容 view `sessions`、`source_files`、统一 `documents`、contentless `documents_fts`、`coverage`、`cold_roots`。没有 metadata sidecar。
- v8 writer 固定使用 rollback `journal_mode=DELETE` 与 `synchronous=FULL`。这是短命 CLI + 显式 single-writer 的有意识取舍：发布态 index 保持单文件，所有只读命令在 DB `0444`、目录 `0555` 时也不会创建 `-wal` / `-shm`；不要改成 `immutable=1` 或 close-time WAL seal，它们在并发 writer/reader 下会读旧数据或留下转换竞态。
- `sessions` view 故意没有 `INSTEAD OF` trigger：高级只读 SQL 保持兼容，旧 TypeScript writer 对 v8 写入时会 fail closed。
- 检索主链是 `SQLite candidate recall -> deterministic session ranking -> evidenceRead -> read-range/read-page`。真实 message 与 session profile 是两类 document；profile 命中不得伪装成 message evidence。`read-range --query` 无 message anchor 返回 typed `anchor_not_found`（含 `matchedProfileFields` 与闭包 read-page nextAction），不回退 seq 0；read payload 的 session 记录含 `compactText`/`reasoningSummaryText`。
- 查询面单分支：find/read/list 等内容命令只讲 v8；legacy v7 是 import 格式。v7 库上内容命令返回 typed `index_schema_upgrade_required` + nextAction `shlog sync`；`status` 正常工作并报告 `index.layout: legacy_v7`（升级 nudge）。迁移只发生在显式 writer 命令，副作用是 coverage 清空（需重新 sync 各 root）、保留 `*.v7.bak.*` 备份、legacy cold-roots.json tombstone、旧 TS writer fail-closed。
- `find` 的 `evidenceRead.command` 是 `executable:"inherit"` + 闭包 `--source/--db/--json` 的 `args` + `sideEffect:"read_index"`，custom DB 下原样执行必须读回原 candidate。无 `--root/--cwd/--selector` 的 find 解析为各 source 的 canonical default `all(root)`，recall/coverage/scanned 三 scope 一致。
- 有确切 source 或显式 `--root/--cwd/--selector` 的内容命令，`index_unavailable.nextAction.commands[].command` 闭包该 scope 的 sync（多 source 时每 source 一条，Codex 为 recommended），标记 `sideEffect:"write_index"`；兼容 `argv` 只作镜像。无显式 scope 的跨 source find 仍保留默认 Codex `all`+`cwd` alternatives。
- v8 tokenizer 使用 UAX #29 lowercase word 与重叠 CJK Unicode-scalar bigram。FTS column 权重为 body 1.0、title 8.0、summary 3.0、compact 4.0、reasoning summary 1.2。
- `source` / root / cwd / date / session / exclude 约束尽量在 SQL candidate generation 阶段下推，不先召回大集合再在 app 层过滤。
- 任何新增的快速候选层都必须返回 conservative superset：只能排除可证明不匹配的记录，tokenizer、delta 或 source 状态不确定时必须保守纳入并交给精确层；不得制造 false negative。
- `source_files` 保存 append cursor、digest、checkpoint 与 epoch。可证明 append 走增量 projection；truncate、prefix rewrite、identity/epoch 不安全时走 full replay。设计验收不变量是 `incremental projection == full replay projection`。
- `status` 返回 execution context、source inventory、index 状态与可选 requested coverage；它不返回或检索 raw content、不写 index。inventory cache miss 会流式解析 raw accepted records/body，仅按 privacy allowlist 派生 cwd/time/session identity 与 fingerprint；rejected/private record 不影响 proof。exact `mtime_ns`/checkpoint cache hit 不重 parse。
- coverage 只由成功的 `sync` 写入。裸 `sync` 是默认 Codex `all(root)` bootstrap；只读命令不会隐式 sync 或 migrate。
- strict sync 遇到选中输入错误时不发布部分 coverage；`--best-effort` 可提交成功文件，但不会伪造 complete coverage。`--prune` 只删除 hot 与 registered cold 都不存在的同 source 投影。
- v8 `cold_roots` 表是 cold registration 真相。legacy `cold-roots.json` 只作为首次 v7/v8 cutover 的一次性导入输入；导入后使用 tombstone 阻止旧 writer 复活配置。
- v7 -> v8 migration 只发生在授权 writer 路径，采用 copy/verify/backup/atomic publish；read-only commands 不迁移。cold-only projection 必须保留。
- native release pipeline 声明 `aarch64-apple-darwin`、`x86_64-unknown-linux-gnu` 两个目标（仅 Apple Silicon macOS）。tag 只发 GitHub Release；Homebrew tap 与 sherlog.net 都要另走一步，步骤见「发布 / 更新闭环」。

不要把下面这些说成已完成：

- 真正独立的 stage-2 / resource-level reranker
- richer projection / range cache / event-level replay
- duplicate family collapse / diversity control
- 强约束的 gold set / rubric / error taxonomy
- 完整的 incremental/full-replay property/state-machine test 矩阵；当前只有聚焦 transition/migration tests
- candidate/filter/exact 各阶段完整可观测性与 `weakMatch`/`matchMode` 公共 contract
- 全正文 typo-tolerant fuzzy、evidence-read frecency
- Linux arm64、musl 或 Windows native archive
- watcher / daemon、LMDB 或第二状态真相源

## 代码地图

- [main.rs](src/main.rs): native binary entrypoint
- [cli.rs](src/cli.rs): fixed CLI surface and flags
- [app/](src/app): command orchestration, output and status
- [runner.rs](src/runner.rs): parse/dispatch/error routing
- [sources/](src/sources): source adapters, inventory and privacy projection
- [sync/](src/sync): lock, scan/project/stage, append/full transitions, cold retention and publish
- [index/](src/index): v8 reader/writer/schema/SQL invariants；v7 仅作为 migration 的 import 格式（内容命令 fail-closed）
- [retrieval/](src/retrieval): query analysis, candidate aggregation, ranking, snippets and evidence-read plans
- [migration/](src/migration): v7 -> v8 copy/verify/atomic publication
- [selector.rs](src/selector.rs), [coverage.rs](src/coverage.rs), [tokenizer.rs](src/tokenizer.rs): shared invariants
- [model.rs](src/model.rs): public JSON/data contracts
- [eval/](eval): eval harness（fork `shlog`、acceptance/contract/perf/dogfood）
- [site/](site): sherlog.net 静态站；Cloudflare Pages 项目 `sherlog-site`，不接 Git

## 文档规则

- 优先维护当前态文档，不保留“看起来像现状、其实只是目标态”的 research 长文
- 如果文档已经腐化，优先删除或重写，不要叠补丁式修辞
- `docs/` 里的文档要服务后续 agent 直接接手，而不是保留调研过程痕迹
- 任何涉及“当前已实现什么”的文档，都必须先对齐代码和测试

## Skill Package 边界

本仓库不维护项目级 `.agents/skills`。Sherlog 的 skill 是给用户安装后操作 CLI 的发行物，不是维护本仓库时给 Codex agent 自动加载的项目 workflow。

本仓库只维护一份 skill 源码：

- `skill-packages/sherlog`: 发布版 skill 源码，必须匹配将要发布的 `shlog` CLI 行为
- production description 用一种自然语言说明 capability 与 invocation branch，保留稳定领域词，不维护中英口语 trigger 清单；跨语言召回不足必须先由 invocation eval 的失败样本证明，再调整 description

### 发布版 Sherlog

`shlog` 代表当前 `PATH` 上的安装版 CLI，`sherlog` 代表安装版 skill。不要把 dirty tree rsync、symlink 或本地 build 冒充已发布版本。

对外推荐安装方式，也是本机更新全局线上 skill 的方式：

```bash
npx skills add -g catoncat/sherlog
```

这个 skill 不会安装 `shlog` CLI 本体。发布版 skill 直接调用安装在 `PATH` 上的 `shlog`，不再维护 `SHLOG_BIN` / `CXS_BIN` 环境变量 resolver，也不在 skill 内解析绝对 executable 路径。开发期间的 candidate binary 选择是 dev-only 关注点，通过既有 eval/dev 机制（如 `SHLOG_BIN_UNDER_TEST`、`--cli-argv-json`）处理，不属于生产 skill 文案。

### 发布 / 更新闭环

对外生效的改动不要停在源码。closeout 必须逐层写明已更新还是未更新：

1. 源码：Rust、`skill-packages/sherlog`、`site/` 版本文案、tests、commit / push。
2. Native release：`v<version>` tag 触发 `.github/workflows/release.yml`，GitHub Release 上有三目标 archive、对应 SPDX、`SHA256SUMS`、`install.sh`、`sherlog.rb`。没有这些 assets 就不能说 native 已发布。
3. Homebrew tap：`catoncat/homebrew-sherlog` 已拉到该版渲染后的 `sherlog.rb`。
4. 官网：https://sherlog.net 已部署同一 commit 的 `site/`。
5. 本机 PATH：`which -a shlog` 与 `shlog --version` 是该发布版。`target/release/shlog` 只代表本地 build。
6. Skill（可选）：`npx skills add -g catoncat/sherlog`。skill 不是 CLI runtime dependency。

发布步骤，每步做完再走下一步：

1. 同步 bump `Cargo.toml` / `Cargo.lock` / `package.json`，并改 `site/index.html` 横幅与 footer、`site/changelog.html` 新条目。
   完成：三处版本号一致，changelog 有本版条目。
2. Rust gates 与 `npm run check` 过后再合进 `main`。
   完成：CI 绿，`origin/main` 含 bump。
3. 在该 commit 打 annotated tag `v<version>` 并 push。已有同名 tag 但 `gh release view v<version>` 仍是 release not found 时，把 tag 改挂到修完 release 门的 commit 再 force-push。
   完成：`gh release view` 看得到该 tag，且 assets 齐全。
4. 盯 release 工作流直到 **Publish native GitHub Release** 成功。Linux **Validate Linux archive contract** 只解包 candidate；checkout 里没有 `target/release/shlog` 时，contract gate 的 reference 必须复用 candidate。
   完成：workflow success，三 archive + SBOM + checksums + installer + formula 都在 Release 上。
5. 立刻更新 tap，不要等次日 cron：

   ```bash
   gh workflow run "Update formula" --repo catoncat/homebrew-sherlog
   ```

   完成：tap `Formula/sherlog.rb` 的 `version` 与 sha256 对应该 Release。
6. 立刻部署官网。Pages 项目 `sherlog-site`（自定义域 `sherlog.net`）**没有接 Git**，push tag 不会更新站点。用 wrangler OAuth，账号必须是拥有该项目的 `1x02790@gmail.com`：

   ```bash
   wrangler whoami
   cd site && wrangler pages deploy . --project-name sherlog-site --branch main --commit-hash "$(git rev-parse HEAD)"
   ```

   完成：`curl` https://sherlog.net 与 `/changelog` 显示新版本；`wrangler pages deployment list --project-name sherlog-site` 的 Production 行是本次 commit。
7. 用户明确要求更新本机 PATH 时再装：`brew update && brew upgrade catoncat/sherlog/sherlog`，或跑 Release 里的 `install.sh`。未要求则保持全局 CLI 不动。
   完成：`shlog --version` 对得上，或 closeout 写明仍是旧版。

只完成源码时写：native source ready；尚无本次 tag/assets；sherlog.net / tap / PATH 仍是旧版。

### 本地开发验证

不再维护 `cxsd` 开发入口、`cxsd` skill alias 或 Claude 暴露链接。它制造第二套命令面，容易让 agent 在发布版、本地 checkout 和 skill 文案之间误判漂移。

维护规则：

- 改 CLI 行为时，同步更新 `skill-packages/sherlog`，并判断是否需要正式 native release；未 release 前只验证 checkout binary，不要更新或覆盖全局 CLI
- 验证当前 checkout 的未发布 production code 时，优先用 `cargo run --locked --bin shlog -- <args>`；`npm run shlog -- <args>` 只是该命令的开发包装
- 验证已安装 / 已发布行为时，用 `shlog <args>`，并先核对 `command -v shlog` 与 `shlog --version`
- 全局 `sherlog` skill 通过 `npx skills add` 更新；不要再创建 `cxsd` skill 或 symlink

## Dogfood eval 边界

Dogfood golden 是开发者本机的真实历史检索验收集，不是普通用户功能。

- 通用 runner / schema 可以维护在 `eval/`，例如 `npm run eval:dogfood -- <goldens.local.jsonl>`
- 私有 golden 默认放在 ignored 路径：`data/cxs-dogfood/goldens.local.jsonl`
- 添加 / promote dogfood golden 只能在用户显式触发 dev-only skill 时进行
- dev-only skill 源码在仓库内：`dev/skills/sherlog-dogfood/source.md`；本机安装路径 `~/.agents/skills/sherlog-dogfood/SKILL.md` 应通过 `scripts/install-dev-skills.sh` 指向该源码文件
- 不要把 dogfood capture 流程或私有 golden 放进 `skill-packages/sherlog`
- 不要把 dogfood skill 放进 repo-local `.agents/skills`，也不要在仓库内把维护者 skill 源文件命名为 `SKILL.md`；`npx skills add` 会扫描 `SKILL.md` 并可能把维护者 workflow 暴露给普通用户
- 普通代码实现任务可以运行已有 dogfood gate，但不能自行新增 golden，也不能自行把 `candidate` promote 为 `hard`
- `skill-packages/sherlog` 只面向最终用户：自评保持为可观察标准（结论是否有 read 证据、范围结论是否有 coverage proof、不确定是否已说明），不出现 dogfood、私有 golden 或维护者路径
- dogfood 发现与采集属于 dev-only skill（`dev/skills/sherlog-dogfood/source.md`）：维护者在 dev skill 内决定是否记录、eval 与 promote；生产 skill 不引用它

## Dogfood 驱动修复流程

用户让 agent 根据 dogfood test 改进 Sherlog 时，先复现和分层，不要直接改实现：

1. 构建 native candidate，并用 `SHLOG_BIN_UNDER_TEST=./target/debug/shlog npm run eval:dogfood -- data/cxs-dogfood/goldens.local.jsonl`（或等价 `--cli-argv-json`）运行 eval
2. 对失败 case 用 `cargo run --locked --bin shlog -- find ... --json`、`read-range` 或 `read-page` 复现
3. 先判断问题层级：
   - index/coverage stale → 修同步/selector 使用流程，不改排序代码
   - skill guidance 问题 → 改 `skill-packages/sherlog`，不改 CLI
   - CLI recall/ranking/context 真问题 → 写通用测试和通用修复
   - golden 期望不稳 → 保持 `candidate` 或请用户确认 stale，不硬凑实现
4. 如果是从 `$sherlog-dogfood` 交接来的修复 handoff，先按 handoff 里的 case id、命令、期望 session/context 复现；handoff 是入口，不是结论
5. 禁止为了通过 dogfood 直接改 golden、hardcode 某个 query/session/id、或新增不必要实体；修复必须能解释成通用 Sherlog 改进
6. 收口至少跑 Rust gates、`npm run check`、focused native repro 和 dogfood eval。eval 默认使用 checkout 的 `target/release/shlog`（否则 debug）。涉及 skill 行为时再验证全局 skill 安装状态

## 默认验证

涉及实现或文档真相变更时，至少做与改动直接相关的验证：

- `cargo fmt --all -- --check`
- `cargo test --workspace --all-targets --all-features --locked`
- `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`
- `cargo build --release --locked --bin shlog`
- `npm run check`（eval harness TypeScript）
- 必要时补一条 release binary 烟测，例如 `target/release/shlog status --json` 或 sanitized fixture sync/find/read
- 涉及 skill 通道时，验证 `npx skills ls -g --json` 和 `shlog --help`
- 涉及发布 / 安装态时，回读 GitHub Release assets、tap `Formula/sherlog.rb`、https://sherlog.net 版本文案、`which -a shlog`、`shlog --version`，并按「发布 / 更新闭环」逐层说明

没有验证证据，不要声称“已对齐”“已完成”“文档正确”。

## 当前近端优先级

1. 先把 eval 从弱提示升级成更可信的 acceptance gate
2. 把 `incremental == full replay` 扩成 property/state-machine acceptance，覆盖 append、truncate、prefix rewrite、rename、hot/cold/prune、migration crash 与旧 writer 竞争
3. 增加 candidate -> filter -> exact/read 各阶段计数与 match mode 可观测性
4. 继续观察 session-level 字段召回是否引入排序噪音，并补 eval 覆盖
5. 只在 eval 证明收益后探索 metadata typo fallback 或有上限的 evidence-read frecency；不做无界正文 fuzzy
6. 更重的 reranker / projection / diversity 控制放后面

具体 roadmap 见 [docs/ROADMAP.md](docs/ROADMAP.md)。

<!-- mainline:agents:start version=12 checksum=sha256:62ee66d15a420f45eb3c1403cffe332072b56e14044597a18ddcc71fa14a0d83 -->
## Mainline

<!-- mainline-agents-md-version: 12 -->

**Mainline is a git-native intent memory layer for AI-assisted engineering.**
It gives coding agents the historical *why* before they inspect the
current *what*.

This project uses Mainline to record the intent behind every AI-driven
change and to surface conflicts between intents before they reach a PR
review. The agent is expected to both **read** team intents (for context)
and **write** its own intent (for the work it's doing). Both halves
matter — intents capture *why* changes were made, which is information
the diff alone cannot give you.

> **v0.3 invariant**: every commit on `main` is in exactly one of three
> states — `covered` (sealed intent claims it), `skipped` (`Mainline-Skip:`
> trailer or matched config pattern), or `uncovered` (neither). Run
> `mainline status` to see the rollup; `mainline gaps` to see uncovered
> commits with rescue suggestions.

### At the start of a task

```
mainline status --json
```

If there is no `active_intent`, start one (use the user's goal verbatim
when possible — it becomes the headline in `mainline log`):

```
mainline start "<short description of the user's goal>" --json
```

### Intent-first workflow (the load-bearing rule)

Before making any non-trivial code change, retrieve relevant intent
context **before** searching the codebase directly.

The default agent order is:

1. `mainline status` — overall state, identity, sync staleness, suggestions.
2. `mainline context --current --json` — historical intents relevant to
   your current branch + active draft + diff vs main.
3. If the task names files: `mainline context --files <path>... --json`.
4. If the task is semantic: `mainline context --query "<task summary>" --json`.
5. Read the returned intents' `summary`, `decisions`, `risks`,
   `anti_patterns`, and `fingerprint`.
6. **Only then** grep / read code to verify against the current
   implementation.
7. Edit.
8. When sealing, reference relevant prior intent IDs in your
   decisions, and record any new `anti_patterns` future agents must
   avoid in this area.

Do not lead with `grep`, `rg`, or broad file reads for non-trivial
changes unless Mainline is unavailable or the task is purely mechanical.

`mainline context` does NOT replace code inspection. It provides the
historical *why* before the agent inspects the current *what*.

**Reading the retrieval output** — every returned intent carries a
`status` field that tells you how to use it RIGHT NOW (distinct from
its lifecycle status):

| status | how to read it |
|---|---|
| `current` | the current effective decision; verify against current code, then apply |
| `superseded` | replaced — read `superseded_by` instead and use this only for context |
| `abandoned` | this approach was tried and abandoned; do not repeat without understanding why |
| `stale` | files have churned or the intent is old; verify decisions still hold |

Each intent also carries:

- `risks` — soft warnings to weigh.
- `anti_patterns` — **hard constraints**. Each one carries a `what`,
  a `why`, and a `severity`. Do not violate them. The retrieval API
  never truncates `anti_patterns`, so if you see one, it is in scope.
- `guidance` — a single-line reminder derived from `status`.

### Pre-edit checklist for agents

Before editing code, answer:

- Did I run `mainline status`?
- Did I run `mainline context --current --json`?
- If files are involved, did I run `mainline context --files ... --json`?
- Did I read the relevant prior decisions and risks?
- Did I verify those intents against the current code?
- Am I about to repeat an abandoned or superseded approach?

### Task priority — when intent-first matters most

| Always mainline-first | Mainline-first preferred | Direct code OK |
|---|---|---|
| architecture changes / refactors | bug fixes | typo / formatting fixes |
| migrations / deletions | new feature additions | one-line obvious syntax fixes |
| auth / billing / data-model / permissions | API behaviour changes | mechanical rename, scoped |
| test-strategy changes | config / CI / release tweaks | user explicitly asks to view ONE file |
| any cross-file change | | |
| user asks "why is this here?" | | |
| user asks "can we delete this?" | | |
| user asks "did we try this before?" | | |

### Read team intents for context (do this aggressively)

Before working on anything non-trivial, scan recent intents for prior
work in the area you're about to touch. Each intent's `summary`
(what / why / decisions / risks / followups) plus `fingerprint`
(subsystems, files_touched, tags) is **strictly richer than the diff** —
it tells you *why* the code looks the way it does, which decisions
were considered and rejected, and what the author flagged as a risk
or follow-up.

```
mainline log --json --limit 30
```

Filter by goal/title keywords matching the user's task. For each
relevant hit, pull the full record:

```
mainline show <intent_id> --json    # decisions / risks / fingerprint
mainline trace <intent_id> --json   # turn timeline (when each turn
                                    # was added, how long it took)
```

`show` answers *what* the intent decided. `trace` answers *how* it
unfolded over time — useful when you're trying to understand why a
PR looks the way it does, or whether the agent got stuck and looped.

Before designing a change, also see what is currently in flight so
your work does not collide with someone else's proposed intent:

```
mainline list-proposals --json
```

`mainline context --json` is a quick agent-consumption snapshot of
the same data (current actor, active intent, recent merged) — useful
for orientation but does not replace the targeted log/show calls.

Use this aggressively. The cost is one or two CLI calls; the payoff
is correct architectural decisions and not duplicating someone's
just-finished work.

### Turns and intent history

Turns are a lightweight thinking scaffold used to prepare a good
seal. They are **not** expected to be a real-time activity log.

It is normal for several turns to be recorded together near seal
time, especially when an agent summarizes its work before sealing.
`mainline trace` will surface this honestly via the
`append_turns_recorded_together` flag — that is informational, not a
warning.

Use:

```
mainline show <intent_id> --json
```

to inspect the structured conclusion of an intent: summary,
decisions, risks, and fingerprint.

Use:

```
mainline trace <intent_id> --json
```

to inspect how an intent unfolded over time: start, append, seal,
abandon, or supersede events.

`show` answers: *"What did this intent decide?"*
`trace` answers: *"How did this intent unfold?"*

### While working

Record turns at points that will help you write a good seal — when
a meaningful subtask completes, when you pivot, when a discovery
changes the plan. Many short turns or a few long turns are both
fine; what matters is that the seal author (you, later) has the
material to compose a faithful summary:

```
mainline append "<what changed and why>" --json
```

Turns are append-only. Don't try to amend or delete them — describe
the next state in a new turn.

### When the task is complete

1. Commit your code changes the normal way:

   ```
   git add <files> && git commit -m "<message>"
   ```

2. Ask Mainline to prepare a seal package:

   ```
   mainline seal --prepare --json > .ml-cache/seal.json
   ```

   The package includes a `seal_result_starter` field — a partially-
   filled `SealResult` with the deterministic bits (intent_id,
   fingerprint.files_touched, fingerprint.subsystems) pre-populated.
   Patch in the agent-judgment fields rather than typing the JSON
   from scratch.

   Why `.ml-cache/`? Init writes that directory to `.gitignore`, so
   the temporary seal file stays out of git and does not trip the
   v0.3 worktree-clean snapshot contract on submit.

3. Generate a `SealResult` JSON matching the schema returned by
   `--prepare`. Populate the fingerprint generously — primary subsystem,
   synonyms, parent concepts, related technologies — so phase-1
   conflict detection has signal:

   ```
   "tags": ["auth", "authentication", "security", "jwt", "session"]
   ```

   When the work establishes constraints future agents must respect,
   record them as `anti_patterns` (NOT as `risks`). Each entry MUST
   carry both `what` and `why`; empty `why` is rejected at seal time.

   ```json
   "anti_patterns": [
     {
       "what": "Removing legacy session middleware on /oauth path",
       "why":  "OAuth callback handler still requires session state",
       "severity": "high"
     }
   ]
   ```

   Use `risks` for soft warnings the reviewer should weigh; use
   `anti_patterns` for hard constraints the next agent must not
   violate. Anti-patterns are surfaced uncapped in `mainline context`,
   so future agents will always see them.

4. Submit it:

   ```
   mainline seal --submit --json < .ml-cache/seal.json
   ```

   Submit auto-syncs with the team and runs phase-1 conflict detection
   against every other proposed/merged intent. If the JSON response
   carries a `conflicts` array, **surface those conflicts to the user
   verbatim** before continuing. Do not silently move on.

5. (Optional but encouraged) Quality-check the seal:

   ```
   mainline lint <intent_id> --json
   ```

   `lint` runs deterministic checks against the sealed payload —
   empty / boilerplate `what`, missing decisions, decision without
   rationale, missing risks/anti_patterns, broken supersedes refs.
   Errors mean the seal will be hard for future retrieval to use;
   warnings are advisory. Lint is **not** wired into submit, so a
   bad seal still goes through — but a low-quality seal pollutes
   future `mainline context` results, which is the whole loop this
   workflow exists to keep healthy.

### When the user asks you to phase-2 check an intent

Phase 1 is automatic; phase 2 is invoked deliberately when phase 1
flags an overlap (`[check:~]` in `mainline log`) and the user wants a
real semantic judgment.

```
mainline check --prepare --intent <id> --json
```

Read each `judgment_task` in the package, judge whether it is a real
semantic conflict, and submit a `CheckJudgmentResult`:

```
mainline check --submit --json < judgment.json
```

The verdict surfaces in `mainline log`'s `[check:X]` column.

### Optional: agent hooks (opt-in context provider)

If `mainline hooks install <agent>` has been run for your agent
runtime (Cursor today; Codex / Claude Code reserved), the hook layer
runs **two mechanical operations** at session start and injects a
**status snapshot** into your system context — nothing more:

- At `sessionStart` the hook runs `mainline sync` (refreshes the team
  view) and `mainline status` (active intent, proposed count, synced
  head). It feeds that snapshot back to you as system-prompt context
  along with a pointer to this document. You no longer need to run
  `mainline status` as the very first call of a session — it has
  already run.
- At every other lifecycle event (turn start, turn end, subagent
  end, session end) the hook is a **no-op** for your reasoning. It
  fires webhook notifications for external observers (CI dashboards,
  pager integrations) and exits. It does NOT call `mainline start`,
  `mainline append`, `mainline seal --prepare`, or any other command
  that requires deciding what counts as a goal / a meaningful change /
  a fingerprint — those are LLM judgments and you remain the only
  party qualified to make them.

Concretely: every step described above (start when there is real
work, append after each meaningful logical change, commit, seal
--prepare, fill SealResult, seal --submit, surface conflicts) you do
yourself, hooks installed or not. The hook layer is a **context
provider**, not a workflow driver.

Run `mainline hooks status` to confirm whether hooks are wired and
whether `auto_sync_on_session_start` is on (the only mechanical
toggle). Disable it with `mainline hooks disable` if your network
makes the session-start sync painful — you can still drive the rest
of the workflow by hand.

### Hub: human reader surface (you don't run this; you suggest it)

`mainline hub export <dir>` and `mainline hub open` build a static
HTML site over the local synced intent view. It is for **humans**, not
agents — agents use `context` / `show` / `trace` / `gaps`.

You should suggest the hub when the user asks one of:

- *"What's the history of `<file>`?"* → hub's per-file page lists
  every intent that touched it.
- *"Who's been working on what lately?"* → hub's index shows the
  recent intents table; the actor pages give per-author rollups.
- *"Are there any conflicts or risky changes I should review?"* →
  hub's risks page and graph (supersessions, conflicts_with,
  shares_file edges) put the answer one click away.

Concretely:

```
mainline hub open                     # build + open in the default browser
mainline hub export ./hub-snapshot    # write a portable copy elsewhere
```

Both commands default the output to `<os-temp>/mainline-hub/<repo>`
so the static site never enters git.

Hub is read-only and rebuildable from the synced view; it never
modifies repo files outside the user-chosen output directory.

### What you do NOT need to run

- `mainline sync` — runs automatically inside `seal --submit` and
  whenever a fresh-data command (`check`, `pin`) needs it.
- `mainline pin` — runs automatically after every sync; the strategy
  cascade (tree_hash → commit_hash → goal_text) catches GitHub
  squash-merges with near-100 % reliability.
- `mainline merge` — humans merge via the GitHub PR UI; the next
  `mainline sync` auto-pins the squash commit.

### Do not run unless the user explicitly asks

```
mainline pin <intent> <commit>      # manual fallback
mainline merge --intent <id>        # non-PR pipeline only
mainline init --rewire              # repo setup repair
mainline doctor --setup --fix       # repo setup repair
```

### Encountering an uncovered commit (v0.3 rescue)

If `mainline status` or `mainline gaps` flags an uncovered commit (one
that landed on main with no intent), pick the **best** path you still
can — ordered by reversibility, cheapest first:

1. **Unpushed** — undo and redo via the proper flow:

   ```
   git reset --soft HEAD^         # un-commit, keep changes
   mainline start "<goal>"
   <continue normal flow>
   ```

2. **Pushed** — backfill an intent that retroactively claims the commit:

   ```
   mainline start "<why this commit was made>" --commits <sha>
   mainline append "<turn-by-turn description, post-hoc>"
   mainline seal --prepare > .ml-cache/seal.json
   <fill .ml-cache/seal.json>
   mainline seal --submit < .ml-cache/seal.json
   ```

   The seal flow auto-pins the new intent to the listed commit on next
   `mainline sync`.

3. **Routine** (chore / format / version bump) — mark as deliberately
   skipped:

   ```
   git commit --amend             # add `Mainline-Skip: <reason>` trailer
   ```

   Or add a pattern in `.mainline/config.toml` under `[mainline.skip]`
   so future similar commits classify automatically:

   ```toml
   [mainline.skip]
   patterns = ["^chore: format", "^bump:"]
   ```

4. **Already distributed, regrettably** — accept uncovered. The
   mainline log is a record of reality, not aspiration.

### Seal snapshot contract (v0.3)

`mainline seal --prepare` snapshots the worktree state (HEAD, branch,
clean/dirty/untracked) and persists it. `mainline seal --submit`
validates the live repo against that snapshot — HEAD drift, branch
drift, or dirty worktree all fail by default with a typed error. The
escape hatch is the explicit CLI flag `--allow-dirty`; even then, the
sealed event permanently records `worktree_status` so reviewers see
the audit trail.

Always commit your code BEFORE `mainline seal --prepare`. Untracked
files (planning docs, scratch notes) do **not** enter sealed evidence.
<!-- mainline:agents:end -->
