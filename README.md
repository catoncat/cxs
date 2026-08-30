# Sherlog

[https://sherlog.net](https://sherlog.net)

`shlog` is a local-first CLI for searching your agent session history — Codex, Claude Code, and Pi transcripts. It's built for agents (and humans) that investigate: find the right session first, then read only the relevant range.

## Why Sherlog

Agent sessions accumulate fast. When you need to recall a past decision, debug a configuration, or recover context from last week's work, `shlog` lets you search across sessions without opening each transcript by hand. It indexes your session logs into a local SQLite database with full-text search, and gives you progressive retrieval: metadata scan → candidate search → targeted read.

## Install

```bash
curl -fsSL https://github.com/catoncat/sherlog/releases/latest/download/install.sh | sh
```

Or via Homebrew:

```bash
brew tap catoncat/sherlog
brew install sherlog
```

The installer places `shlog` in `$HOME/.local/bin`, verifies SHA-256, and never runs `sudo`. Set `SHLOG_INSTALL_DIR` to pick another directory. Upgrading from 0.4.x? Run `shlog sync` once to migrate your index.

Prebuilt archives for macOS (arm64 only) and Linux (x64 GNU). Node.js is not required to run Sherlog.

## Quick Start

```bash
shlog sync                          # index your default Codex sessions
shlog find "health check"           # search across sessions
shlog read-range <sessionRef> --seq <matchSeq>   # read around a match
shlog read-page <sessionRef> --offset 0 --limit 20  # read from the top
```

If `find` suggests a coverage gap, run the suggested `sync` and retry. For project-scoped work:

```bash
shlog status --cwd /Users/you/work/project --json
shlog sync --cwd /Users/you/work/project
```

## Commands

| Command | What it does |
|---|---|
| `status` | Show index state, source inventory, and coverage |
| `sync` | Index new sessions (the only command that writes to the index) |
| `find` | Full-text search across sessions with ranked results |
| `read-range` | Read a window of messages around a match |
| `read-page` | Read a page of messages from a session |
| `list` | List sessions matching filters |
| `stats` | Summary statistics about the index |
| `cold` | Manage cold storage retention (add/remove roots) |

All read commands operate on the SQLite index — they never scan raw transcripts.

## Agent Skill

Install the optional agent skill so your agent can invoke Sherlog directly:

```bash
npx skills add -g catoncat/sherlog
```

This uses an external skill manager; it does not add a Node.js dependency to Sherlog itself.

## Documentation

- [Usage Guide](docs/USAGE.md) — Full command reference, selectors, sync details, and storage.
- [Design Philosophy](docs/PHILOSOPHY.md) — Why FTS? Why not ripgrep or embeddings?
- [Architecture](docs/ARCHITECTURE.md) — Retrieval model and how it works.
- [Roadmap](docs/ROADMAP.md) — What's coming next.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).
