# cxs Agent Guide

## 项目定位

`cxs` 是一个面向本机 Codex session 日志的渐进式检索 CLI，不是 GUI app，也不是实时同步守护进程。

当前接受的产品边界：

- 命令面固定为：`status`、`sync`、`find`、`read-range`、`read-page`、`list`、`stats`
- 主工作流固定为：`status -> ensure selector coverage -> find/list -> read-range/read-page`
- `sync` 是唯一会修改索引的命令；其余命令只读 SQLite
- 默认接受手动增量同步，不做 watcher / daemon / realtime sync
- 这个仓库可以作为其他 sidecar / GUI 的 retrieval engine，但本仓库自身不以 GUI 为目标

## 当前实现真相

- 检索主链是 `message/session recall -> session heuristic rerank -> progressive read`
- `status` 只返回执行上下文、source inventory、index 状态与 coverage 状态；`status --selector` 只读地报告目标 selector 的 coverage/freshness 和 recommendedAction；它可以扫描 raw session metadata，但不写 index、不回答内容问题
- 内容回答只能来自 cxs index；source inventory 只能用于构造 selector 和判断可能的同步范围，不能作为内容真相源
- `sync --selector` 是建立 coverage 的唯一入口；只读命令不得隐式触发 sync
- 查找前不要求无条件 sync；只有目标 selector coverage 缺失或 stale 时才同步。fresh `all(root)` coverage 可以覆盖同 root 下更窄 selector
- `find` 默认按 relevance 排序；“最新/最近 + 关键词”应使用 `find <query> --sort ended`，必要时 `--exclude-session` 排除当前会话/self-hit
- 候选召回来自 `messages_fts` 与 `sessions_fts(title + summary_text + compact_text + reasoning_summary_text)`；极少数零 token CJK query 在 message 侧回退到 LIKE
- `summary_text`、`compact_text`、`reasoning_summary_text` 已持久化，也会通过 `sessions_fts` 参与 session-level recall
- session-level FTS 使用显式字段权重：title 8.0、compact 4.0、summary 3.0、reasoning summary 1.2
- `classifyQueryProfile()` 仍存在，但当前评分没有按 `broad/exact` 做显式分权
- parser 只把 `event_msg` 里的 user / assistant 写入 `messages`；`type=compacted` 与 `response_item.reasoning.summary` 只进入 session-level 索引字段，不形成可回读 message projection

不要把下面这些说成已完成：

- 真正独立的 stage-2 / resource-level reranker
- richer projection / range cache / event-level replay
- duplicate family collapse / diversity control
- 强约束的 gold set / rubric / error taxonomy

## 代码地图

- [cli.ts](/Users/envvar/work/repos/cxs/src/cli.ts): CLI 命令面
- [indexer.ts](/Users/envvar/work/repos/cxs/src/indexer.ts): sync 与索引更新
- [parser.ts](/Users/envvar/work/repos/cxs/src/parser.ts): Codex JSONL 解析与 `summary_text` 生成
- [db.ts](/Users/envvar/work/repos/cxs/src/db.ts): SQLite facade；具体 schema / store / coverage 模块在 `src/db/`
- [query.ts](/Users/envvar/work/repos/cxs/src/query.ts): 查询 facade；find / read / list / stats / search / snippet 模块在 `src/query/`
- [status.ts](/Users/envvar/work/repos/cxs/src/status.ts): status 输出编排
- [selector.ts](/Users/envvar/work/repos/cxs/src/selector.ts): selector 解析与覆盖蕴含规则
- [source-inventory.ts](/Users/envvar/work/repos/cxs/src/source-inventory.ts): raw sessions metadata inventory
- [types.ts](/Users/envvar/work/repos/cxs/src/types.ts): CLI JSON contract 与核心类型
- [ranking.ts](/Users/envvar/work/repos/cxs/src/ranking.ts): session heuristic rerank
- [eval/](/Users/envvar/work/repos/cxs/eval): manual eval、batch compare

## 文档规则

- 优先维护当前态文档，不保留“看起来像现状、其实只是目标态”的 research 长文
- 如果文档已经腐化，优先删除或重写，不要叠补丁式修辞
- `docs/` 里的文档要服务后续 agent 直接接手，而不是保留调研过程痕迹
- 任何涉及“当前已实现什么”的文档，都必须先对齐代码和测试

## Skill Package 边界

本仓库不维护项目级 `.agents/skills`。cxs 的 skill 是给用户安装后操作 CLI 的发行物，不是维护本仓库时给 Codex agent 自动加载的项目 workflow。

本仓库只维护一份 skill 源码：

- `skill-packages/cxs`: 发布版 skill 源码，必须匹配将要发布的 `cxs` CLI 行为

### 发布版 cxs

`cxs` 永远代表线上安装版。不要把本地 dirty tree rsync 到全局 `cxs` skill。

对外推荐安装方式，也是本机更新全局线上 skill 的方式：

```bash
npx skills add catoncat/cxs --full-depth --skill cxs -g -a codex -y
```

注意这个 skill 不会自动安装 `cxs` CLI 本体。默认约定：

- 优先使用 `CXS_BIN`
- 未设置时回退到 `PATH` 里的 `cxs`

### 开发版 cxsd

`cxsd` 永远代表本地 checkout。它用于验证未发布 CLI 代码，不用于验证 npm/npx 线上版本。

本仓库不再维护独立 `skill-packages/cxsd`。`cxsd` skill 只是本机 alias，直接软链接到同一份 `skill-packages/cxs`，避免两份 skill 文案漂移。需要用开发版 CLI 时，在执行命令时显式用 `cxsd`，或临时设：

```bash
export CXS_BIN=/Users/envvar/.local/bin/cxsd
```

本机约定：

- dev bin: `/Users/envvar/.local/bin/cxsd`
- dev bin 指向：`/Users/envvar/work/repos/cxs/src/cli.ts`
- global dev skill alias: `/Users/envvar/.agents/skills/cxsd -> /Users/envvar/work/repos/cxs/skill-packages/cxs`
- Claude exposure: `/Users/envvar/.claude/skills/cxsd -> /Users/envvar/.agents/skills/cxsd`

维护规则：

- 改 CLI 行为时，只更新 `skill-packages/cxs`
- 全局 `cxs` 通过 `npx skills add` 更新；全局 `cxsd` 通过 symlink 跟随本地 repo
- 若 `cxs` 与 `cxsd` 行为不一致，先判断是“线上尚未发布”还是“命令入口不同”，不要复制出第二份 skill

## Dogfood eval 边界

Dogfood golden 是开发者本机的真实历史检索验收集，不是普通用户功能。

- 通用 runner / schema 可以维护在 `eval/`，例如 `npm run eval:dogfood -- <goldens.local.jsonl>`
- 私有 golden 默认放在 ignored 路径：`data/cxs-dogfood/goldens.local.jsonl`
- 添加 / promote dogfood golden 只能在用户显式触发 dev-only skill 时进行
- 本机 dev-only skill 路径：`~/.agents/skills/cxs-dogfood`
- 不要把 dogfood capture 流程或私有 golden 放进 `skill-packages/cxs`
- 普通代码实现任务可以运行已有 dogfood gate，但不能自行新增 golden，也不能自行把 `candidate` promote 为 `hard`
- `skill-packages/cxs` 应引导 agent 在每次使用 cxs 后做轻量自评：结果可靠、需要 refine、coverage 问题、skill 使用问题，还是值得记录的 dogfood candidate
- 自评发现可复现的 recall/ranking/context 问题时，只能建议用户显式说 `$cxs-dogfood 记录这个 case`；不能自动写私有 golden
- `$cxs-dogfood` 与 `cxs` skill 是配套流程：`cxs` 负责发现 candidate 并留下 handoff 线索；`cxs-dogfood` 负责交互式采集、eval、以及最后询问是否启动修复或输出修复 handoff

## Dogfood 驱动修复流程

用户让 agent 根据 dogfood test 改进 cxs 时，先复现和分层，不要直接改实现：

1. 运行 `npm run eval:dogfood -- data/cxs-dogfood/goldens.local.jsonl`
2. 对失败 case 用 `cxsd find ... --json`、`cxsd read-range ... --json` 或 `cxsd read-page ... --json` 复现
3. 先判断问题层级：
   - index/coverage stale → 修同步/selector 使用流程，不改排序代码
   - skill guidance 问题 → 改 `skill-packages/cxs`，不改 CLI
   - CLI recall/ranking/context 真问题 → 写通用测试和通用修复
   - golden 期望不稳 → 保持 `candidate` 或请用户确认 stale，不硬凑实现
4. 如果是从 `$cxs-dogfood` 交接来的修复 handoff，先按 handoff 里的 case id、命令、期望 session/context 复现；handoff 是入口，不是结论
5. 禁止为了通过 dogfood 直接改 golden、hardcode 某个 query/session/id、或新增不必要实体；修复必须能解释成通用 cxs 改进
6. 收口至少跑 `npm run check` 和 dogfood eval；涉及 skill 行为时再验证全局 skill 安装/软链接状态

## 默认验证

涉及实现或文档真相变更时，至少做与改动直接相关的验证：

- `npm run check`
- 必要时补一条 CLI 烟测，例如 `cxsd status --json` 或 `cxsd find "<query>" --json`
- 涉及 skill 通道时，验证 `npx skills ls -g --json`、`readlink /Users/envvar/.agents/skills/cxsd` 和 `cxsd --help`

没有验证证据，不要声称“已对齐”“已完成”“文档正确”。

## 当前近端优先级

1. 先把 eval 从弱提示升级成更可信的 acceptance gate
2. 继续观察 session-level 字段召回是否引入排序噪音，并补 eval 覆盖
3. 更重的 reranker / projection / diversity 控制放后面

具体 roadmap 见 [docs/ROADMAP.md](/Users/envvar/work/repos/cxs/docs/ROADMAP.md)。

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
