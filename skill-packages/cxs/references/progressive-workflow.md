# Progressive Workflow

## 默认三步

1. `find` 拿候选 session 和命中锚点
2. `read-range` 在最佳候选周围扩局部上下文
3. `read-page` 只在局部窗口仍不够时翻整页

硬规则：

- 没有 `sessionUuid` 时，不要冷启动 `read-page`
- 用户给了 `cwd` 但**不知道是否 sync 过**:先 `current --cwd ...`(直读 state DB,零索引依赖)
- 用户给了 `cwd` 或时间窗口且 cxs 已 sync,优先 `list`
- 已锁定 session 但锚点不对时，用 `read-range --query`
- `cwd` 只是候选过滤，不是主题真相；还要再看 `title`、`summaryText` 和开头几条 message

## Worked Scenario 1

用户说：`上次我配 cf tunnel 是怎么弄的`

```bash
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
"${CXS_BIN:-cxs}" list --cwd hammerspoon --since 2026-04-15 --json
```

再在候选 session 内局部重定位：

```bash
"${CXS_BIN:-cxs}" read-range <sessionUuid> --query "IME" --before 4 --after 8 --json
```

## Worked Scenario 3

用户说：`最近本项目有做过什么讨论`

先按当前 repo 路径列最近 session：

```bash
"${CXS_BIN:-cxs}" list --cwd /absolute/path/to/current/repo --sort ended -n 8 --json
```

不要把 `cwd` 直接当主题真相。至少再看：

- `title`
- `summaryText`
- 开头几条 message
- 结尾几条 message

## Worked Scenario 4

用户说：`本项目最近的对话` 或 `刚换的机器还没来得及跑 sync`,但你需要立刻拿到当前 repo 的候选 session。

先 `current` 直读 Codex state DB(不需要 cxs 自己的索引):

```bash
"${CXS_BIN:-cxs}" current --json
```

输出顶层是 `{ cwd, candidates: [...] }`,每个 candidate 已经按 `updatedAtMs` 倒序。拿最近一条的 `sessionUuid` 直接抽样:

```bash
"${CXS_BIN:-cxs}" read-page <sessionUuid> --offset 0 --limit 20 --json
```

**何时选 current 而不是 list**:

- `cxs sync` 没跑过或久没 sync(`stats.lastSyncAt` 很旧/为 null)时,`list` 会拿到陈旧或空结果;`current` 直读 state DB,反映的是 Codex 当前的 thread 列表
- 只想要"当前 cwd 下最新的 session",不需要全文检索
- state DB 不存在/缺 `threads` 表/缺必需列时,`current --json` 会返回结构化 `{ error: { code: "state_db_unavailable", message } }`,**不要重跑 sync 试图修复**——那是 Codex 端的问题,提示用户检查 codex 安装即可

## 来源

- 仓库内 `README.md`
- 仓库内 `query.ts`
- 仓库内 `types.ts`
