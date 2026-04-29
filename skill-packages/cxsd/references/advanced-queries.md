# Advanced Queries

## 实际 query 语义

`cxs` 不是把用户输入原样透传给 SQLite FTS。当前行为是：

- 先把 query 做 tokenizer 处理
- 每个 term 都会被双引号包住
- term 与 term 之间一律用 `AND`

这意味着：

- 不要指望用户输入里的 `OR`、`NEAR`、`*`、引号按原生 FTS 运算符生效
- 空格分开的多词查询，本质上是“这些词都要进候选”
- 原始整句仍会参与 rerank，所以像 `health check` 这种自然短语仍然值得原样查询

对 agent 的含义：

- 先用自然关键词查询
- 关键词太宽时，增加第二个稳定词，而不是发明 FTS 运算符

## CJK / 中文行为

当前 tokenizer 对 CJK 的策略是：

- 中文/日文/韩文连续串按重叠 bigram 切分
- 单个 CJK 字不会成为有效 FTS term
- 如果 query 含 CJK 但 token 结果为空，会回退到有界 LIKE 扫描

实务建议：

- 单个汉字命中不稳，尽量用至少两字中文词
- 更稳的是“中文短词 + 英文标识符/报错”
- 中文零结果时，先换：
  - 至少两字中文
  - 英文关键词
  - 项目名 / cwd 过滤

## 缩范围：什么时候 `list` 胜过 `find`

优先 `list` 的情况：

- 用户给了项目名、repo、cwd
- 用户给了大致日期或“前几天 / 那周 / 昨天”
- 用户只记得“在那个项目里做过”，却没有强关键词

典型做法：

```bash
"${CXSD_BIN:-cxsd}" list --cwd hammerspoon --since 2026-04-15 --json
```

然后对候选 session 再跑：

```bash
"${CXSD_BIN:-cxsd}" read-range <sessionUuid> --query "IME" --json
```

## 同 title 的多变体 session

Codex resume/fork 可能产生多个 title 很像、但 `sessionUuid` 不同的 session。当前 `find` 会保留这些 distinct sessions，不会按 title 折叠。

不要做的事：

- 不要假设 title 一样就是同一场会话
- 不要自己先按 title 去重再看内容

应该做的事：

- 按 `cwd`
- 按 `startedAt` / `endedAt`
- 按 `matchCount`
- 再决定是否继续 `read-range`

## `snippet` 高亮

- FTS path 的 `snippet` 会带 `<mark>...</mark>`
- LIKE fallback 也会自己补 `<mark>...</mark>`
- 如果下游需要纯文本，自己 strip
- 如果你在回答里要引用命中词，高亮保留也可以

## 来源

- 仓库内 `src/query/search.ts`
- 仓库内 `src/query/snippet.ts`
- 仓库内 `src/tokenize.ts`
- 仓库内 `src/ranking.ts`
