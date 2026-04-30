# Progressive Workflow

## 默认流程

1. `status --json` 拿 source inventory 和 coverage
2. 选择明确 selector,用 `status --selector '<json>' --json` 检查 `requestedCoverage`
3. 如果 `recommendedAction` 是 `"sync"` 才 `sync --selector`;如果是 `"query"` 直接查
4. `find` 或 `list` 拿候选 session 和命中锚点
5. `read-range` 在最佳候选周围扩局部上下文
6. `read-page` 只在局部窗口仍不够时翻整页

硬规则：

- 没有 `sessionUuid` 时，不要冷启动 `read-page`
- `sync` 只负责更新 index/coverage;查找不需要每次 sync
- 用户给了 `cwd` 或时间窗口:构造同范围 selector;先确认 coverage;缺失/stale 才同步;查询时继续带同一个 selector
- 用户问"最新/最近 + 关键词":不要用默认 `find` 当时间结论;用 `find <query> --sort ended`,并用 `--exclude-session <current_uuid>` 排除当前会话/self-hit
- 已锁定 session 但锚点不对时，用 `read-range --query`
- `cwd` 只是候选过滤，不是主题真相；还要再看 `title`、`summaryText` 和开头几条 message

## Worked Scenario 1

用户说：`上次我配 cf tunnel 是怎么弄的`

```bash
"${CXSD_BIN:-cxsd}" status --json
"${CXSD_BIN:-cxsd}" status --selector '{"kind":"all","root":"/Users/me/.codex/sessions"}' --json
"${CXSD_BIN:-cxsd}" sync --selector '{"kind":"all","root":"/Users/me/.codex/sessions"}' --json
"${CXSD_BIN:-cxsd}" find "cf tunnel" --json -n 5
```

如果 `status --selector` 返回 `recommendedAction: "query"`，跳过 `sync`。

然后：

```bash
"${CXSD_BIN:-cxsd}" read-range <sessionUuid> --seq <matchSeq> --before 4 --after 8 --json
```

只有 `read-range` 还缺前情后果时，再：

```bash
"${CXSD_BIN:-cxsd}" read-page <sessionUuid> --offset 0 --limit 40 --json
```

## Worked Scenario 2

用户说：`我记得前几天在 hammerspoon 那个 repo 里试过 IME 切换`

先按 cwd + 时间缩范围：

```bash
"${CXSD_BIN:-cxsd}" status --json
"${CXSD_BIN:-cxsd}" status --selector '{"kind":"cwd_date_range","root":"/Users/me/.codex/sessions","cwd":"/Users/me/work/hammerspoon","fromDate":"2026-04-15","toDate":"2026-04-30"}' --json
"${CXSD_BIN:-cxsd}" sync --selector '{"kind":"cwd_date_range","root":"/Users/me/.codex/sessions","cwd":"/Users/me/work/hammerspoon","fromDate":"2026-04-15","toDate":"2026-04-30"}' --json
"${CXSD_BIN:-cxsd}" list --selector '{"kind":"cwd_date_range","root":"/Users/me/.codex/sessions","cwd":"/Users/me/work/hammerspoon","fromDate":"2026-04-15","toDate":"2026-04-30"}' --json
```

如果 `status --selector` 返回 `recommendedAction: "query"`，跳过 `sync`。

再在候选 session 内局部重定位：

```bash
"${CXSD_BIN:-cxsd}" read-range <sessionUuid> --query "IME" --before 4 --after 8 --json
```

## Worked Scenario 3

用户说：`最近本项目有做过什么讨论`

先按当前 repo 路径列最近 session：

```bash
"${CXSD_BIN:-cxsd}" status --json
"${CXSD_BIN:-cxsd}" status --selector '{"kind":"cwd","root":"/Users/me/.codex/sessions","cwd":"/absolute/path/to/current/repo"}' --json
"${CXSD_BIN:-cxsd}" sync --selector '{"kind":"cwd","root":"/Users/me/.codex/sessions","cwd":"/absolute/path/to/current/repo"}' --json
"${CXSD_BIN:-cxsd}" list --selector '{"kind":"cwd","root":"/Users/me/.codex/sessions","cwd":"/absolute/path/to/current/repo"}' --sort ended -n 8 --json
```

如果 `status --selector` 返回 `recommendedAction: "query"`，跳过 `sync`。

不要把 `cwd` 直接当主题真相。至少再看：

- `title`
- `summaryText`
- 开头几条 message
- 结尾几条 message

## Worked Scenario 4

用户说：`最新的一次 xsearch 是哪个 session`

这类是"最近 + 关键词"，先按时间语义查，不要把默认相关性排序当最新：

```bash
"${CXSD_BIN:-cxsd}" status --json
"${CXSD_BIN:-cxsd}" status --selector '{"kind":"cwd","root":"/Users/me/.codex/sessions","cwd":"/absolute/path/to/current/repo"}' --json
# 如果 recommendedAction 是 "sync":
"${CXSD_BIN:-cxsd}" sync --selector '{"kind":"cwd","root":"/Users/me/.codex/sessions","cwd":"/absolute/path/to/current/repo"}' --json
"${CXSD_BIN:-cxsd}" find "xsearch" --selector '{"kind":"cwd","root":"/Users/me/.codex/sessions","cwd":"/absolute/path/to/current/repo"}' --sort ended --exclude-session <current_session_uuid> --json -n 5
```

如果不知道当前 session uuid，先从最近列表识别当前 self-hit，再把它传给 `--exclude-session`：

```bash
"${CXSD_BIN:-cxsd}" list --selector '{"kind":"cwd","root":"/Users/me/.codex/sessions","cwd":"/absolute/path/to/current/repo"}' --sort ended -n 5 --json
```

## 来源

- 仓库内 `README.md`
- 仓库内 `src/query.ts`
- 仓库内 `src/query/read.ts`
- 仓库内 `src/types.ts`
