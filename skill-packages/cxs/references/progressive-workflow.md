# Progressive Workflow

## 默认流程

1. `status --json` 拿 source inventory 和 coverage
2. 选择明确 selector 并 `sync --selector`
3. `find` 或 `list` 拿候选 session 和命中锚点
4. `read-range` 在最佳候选周围扩局部上下文
5. `read-page` 只在局部窗口仍不够时翻整页

硬规则：

- 没有 `sessionUuid` 时，不要冷启动 `read-page`
- 用户给了 `cwd` 或时间窗口:构造同范围 selector;先同步这个 selector;查询时继续带同一个 selector
- 已锁定 session 但锚点不对时，用 `read-range --query`
- `cwd` 只是候选过滤，不是主题真相；还要再看 `title`、`summaryText` 和开头几条 message

## Worked Scenario 1

用户说：`上次我配 cf tunnel 是怎么弄的`

```bash
"${CXS_BIN:-cxs}" status --json
"${CXS_BIN:-cxs}" sync --selector '{"kind":"all","root":"/Users/me/.codex/sessions"}' --json
"${CXS_BIN:-cxs}" find "cf tunnel" --json -n 5
```

然后：

```bash
"${CXS_BIN:-cxs}" read-range <sessionUuid> --seq <matchSeq> --before 4 --after 8 --json
```

只有 `read-range` 还缺前情后果时，再：

```bash
"${CXS_BIN:-cxs}" read-page <sessionUuid> --offset 0 --limit 40 --json
```

## Worked Scenario 2

用户说：`我记得前几天在 hammerspoon 那个 repo 里试过 IME 切换`

先按 cwd + 时间缩范围：

```bash
"${CXS_BIN:-cxs}" status --json
"${CXS_BIN:-cxs}" sync --selector '{"kind":"cwd_date_range","root":"/Users/me/.codex/sessions","cwd":"/Users/me/work/hammerspoon","fromDate":"2026-04-15","toDate":"2026-04-30"}' --json
"${CXS_BIN:-cxs}" list --selector '{"kind":"cwd_date_range","root":"/Users/me/.codex/sessions","cwd":"/Users/me/work/hammerspoon","fromDate":"2026-04-15","toDate":"2026-04-30"}' --json
```

再在候选 session 内局部重定位：

```bash
"${CXS_BIN:-cxs}" read-range <sessionUuid> --query "IME" --before 4 --after 8 --json
```

## Worked Scenario 3

用户说：`最近本项目有做过什么讨论`

先按当前 repo 路径列最近 session：

```bash
"${CXS_BIN:-cxs}" status --json
"${CXS_BIN:-cxs}" sync --selector '{"kind":"cwd","root":"/Users/me/.codex/sessions","cwd":"/absolute/path/to/current/repo"}' --json
"${CXS_BIN:-cxs}" list --selector '{"kind":"cwd","root":"/Users/me/.codex/sessions","cwd":"/absolute/path/to/current/repo"}' --sort ended -n 8 --json
```

不要把 `cwd` 直接当主题真相。至少再看：

- `title`
- `summaryText`
- 开头几条 message
- 结尾几条 message

## 来源

- 仓库内 `README.md`
- 仓库内 `src/query.ts`
- 仓库内 `src/query/read.ts`
- 仓库内 `src/types.ts`
