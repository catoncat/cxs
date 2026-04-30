# cxs

`cxs` is a local-first CLI for searching Codex session logs. It is designed for
progressive retrieval: find the right session first, then read only the relevant
range or page.

Core workflow:

```text
status -> ensure selector coverage -> find/list -> read-range/read-page
```

## What It Is

- A CLI for indexed search over local Codex JSONL sessions.
- A retrieval backend for agents, sidecars, and local tools that need session recall.
- A manual-sync tool: `sync` is the only command that writes the SQLite index.

## What It Is Not

- Not a GUI.
- Not a watcher, daemon, or realtime sync service.
- Not a live in-flight thread attachment layer.
- Not a default full-transcript dumper.

## Install

Requirements:

- macOS or Linux. Windows users should use WSL.
- Node.js `>= 22`.
- Read access to `~/.codex/sessions`.

Install the CLI globally:

```bash
npm i -g @act0r/cxs
cxs --help
```

The installed command is `cxs`. The package is scoped because the unscoped
`cxs` package name is already taken on npm. The current distribution is the npm
package only; no standalone binary is published.

For one-off usage:

```bash
npx @act0r/cxs@latest --help
npx @act0r/cxs@latest status --json
```

## Quick Start

Inspect available sources and index coverage:

```bash
cxs status --json
```

Check coverage for a project:

```bash
cxs status --selector '{"kind":"cwd","root":"/Users/you/.codex/sessions","cwd":"/Users/you/work/project"}' --json
```

If `requestedCoverage.recommendedAction` is `"sync"`, build or refresh coverage:

```bash
cxs sync --selector '{"kind":"cwd","root":"/Users/you/.codex/sessions","cwd":"/Users/you/work/project"}'
```

Replace the example paths with your own absolute paths.

Search and read progressively:

```bash
cxs find "health check"
cxs read-range <sessionUuid> --seq <matchSeq>
cxs read-page <sessionUuid> --offset 0 --limit 20
```

You can run the same flow without global installation:

```bash
npx @act0r/cxs@latest sync --selector '{"kind":"all","root":"/Users/you/.codex/sessions"}'
npx @act0r/cxs@latest find "health check"
```

## Commands

| Command | Purpose |
| --- | --- |
| `cxs status` | Show execution context, source inventory, index state, and coverage. `--selector` checks whether a target range is fresh. Does not write the index. |
| `cxs sync --selector <json>` | Scan selected Codex sessions and update the SQLite index. This is the only write command. |
| `cxs find <query>` | Search indexed sessions and return ranked session candidates with minimal snippets. Use `--sort ended` for "latest + keyword" queries. |
| `cxs read-range <sessionUuid>` | Read a small message window around a matched sequence or in-session query. |
| `cxs read-page <sessionUuid>` | Read a session page by offset and limit. |
| `cxs list` | List indexed sessions without full-text search. |
| `cxs stats` | Show index statistics. |

All commands that read indexed content support `--json`. Read commands fail
cleanly if the index has not been created yet.

## Selectors

`sync` requires an explicit selector. Query commands can also accept selectors to
constrain already-indexed results.

```text
{"kind":"all","root":"/Users/you/.codex/sessions"}
{"kind":"date_range","root":"/Users/you/.codex/sessions","fromDate":"2026-04-01","toDate":"2026-04-30"}
{"kind":"cwd","root":"/Users/you/.codex/sessions","cwd":"/Users/you/work/project"}
{"kind":"cwd_date_range","root":"/Users/you/.codex/sessions","cwd":"/Users/you/work/project","fromDate":"2026-04-01","toDate":"2026-04-30"}
```

Example list query scoped to one project:

```bash
cxs list --selector '{"kind":"cwd","root":"/Users/you/.codex/sessions","cwd":"/Users/you/work/project"}' --sort ended -n 10
```

Example latest keyword query, excluding the current self-hit:

```bash
cxs find "xsearch" --selector '{"kind":"cwd","root":"/Users/you/.codex/sessions","cwd":"/Users/you/work/project"}' --sort ended --exclude-session <current_session_uuid> -n 5 --json
```

`find` defaults to relevance sorting. Do not treat default `find` order as time
order.

## Sync And Storage

By default, `cxs` reads Codex sessions from `~/.codex/sessions` and stores its
index at:

```text
~/.local/state/cxs/index.sqlite
```

`$XDG_STATE_HOME` is respected, and `CXS_DATA_DIR` has the highest priority:

```bash
export CXS_DATA_DIR="$HOME/.config/cxs"
```

Sync is strict by default. If any selected file fails to parse or write, `sync`
exits non-zero with per-file diagnostics and does not commit partial coverage.
On success, strict sync reconciles the selected index slice to the current source
snapshot: selected sessions whose source JSONL no longer exists are removed
before complete coverage is written.
Pass `--best-effort` only when you explicitly want successful files written
despite failures; best-effort sync does not record complete coverage.

`sync` is not required before every query. Use `status --selector` to check
coverage first. A fresh `{"kind":"all", ...}` coverage record covers narrower
selectors under the same root; a high `stats.sessionCount` only means rows exist
and is not itself a freshness proof.

Indexes created before `cxs-v6-selector-provenance` should be refreshed with
`sync --selector` so date selectors and read coverage use the current
`path_date` and source-root provenance fields.

Older `cxs <= 0.2.0` indexes stored under `~/.cache/cxs/` are migrated
automatically on first run when the new state directory is empty. If the new
directory already has data, migration is skipped and the old cache is left in
place.

## Retrieval Model

The current retrieval chain is:

```text
message/session recall -> session heuristic rerank -> read-range/read-page
```

Implemented recall surfaces:

- `messages_fts` over real user and assistant messages.
- `sessions_fts` over `title + summary_text + compact_text + reasoning_summary_text`.
- Session-level FTS weights: title `8.0`, compact `4.0`, summary `3.0`, reasoning summary `1.2`.
- A small LIKE fallback for rare zero-token CJK message queries.

`find` returns enough context to choose the next read step. If a result only
matches session-level fields, it is marked with `matchSource = "session"` and
has no message anchor; use `read-page` for those results.

Not implemented yet:

- Resource-level reranking.
- Richer projection or event replay.
- Range cache.
- Duplicate-family collapse or diversity control.
- Strong gold-set acceptance suite.

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Roadmap:
[docs/ROADMAP.md](docs/ROADMAP.md).

## Development

Run from source:

```bash
git clone https://github.com/catoncat/cxs.git
cd cxs
npm install
npm run cxs -- --version
```

Common checks:

```bash
npm run check
npm run eval:manual
npm run eval:compare -- data/cxs-eval/<before-batch> data/cxs-eval/<after-batch>
```

`npm run check` runs TypeScript and Vitest. `eval:manual` exports manual eval
results; `eval:compare` compares two eval batches.

Project rules and contribution notes:

- [AGENTS.md](AGENTS.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)

## Agent Skill Package

This repository also publishes an installable agent skill package:

```text
skill-packages/cxs
```

Install or update it with:

```bash
npx skills add catoncat/cxs --full-depth --skill cxs -g -a codex -y
```

List available skills in the repository:

```bash
npx skills add catoncat/cxs --full-depth --list
```

Important boundaries:

- `npx skills add` installs the agent skill only; it does not install the `cxs` CLI.
- Install the CLI with `npm i -g @act0r/cxs`, use `npx @act0r/cxs@latest`, or set `CXS_BIN` for the skill.
- Restart Codex or open a new session after installing or updating the skill.
