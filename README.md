# cxs

`cxs` 是一个面向本机 Codex 会话日志的渐进式检索 CLI。

它的目标不是“返回整场对话全文”，而是给 agent 或人一个低噪音的读取路径：

`sync -> find -> read-range/read-page`

## 适用场景

- 查“之前那个 session 里是怎么修的”
- 按关键词找最近的 Codex 历史
- 先拿候选 session，再围绕命中点局部展开
- 给 sidecar / GUI 工具提供本地 session retrieval engine

## 非目标

- 不做实时 watcher / daemon / 自动 sync
- 不做 GUI
- 不直接绑定 live in-flight thread
- 不返回未裁剪的全文默认输出

当前命令面：

- `cxs sync`
- `cxs find <query>`
- `cxs read-range <sessionUuid>`
- `cxs read-page <sessionUuid>`
- `cxs list`
- `cxs stats`
- `cxs current`

## 安装

```bash
bun install
```

## CLI Install Guide

```bash
git clone https://github.com/catoncat/cxs.git
cd cxs
bun install
export CXS_BIN="$PWD/bin/cxs"
```

要求：

- Bun `>= 1.3`
- 本机可读取 `~/.codex/sessions`
- 默认会在仓库内使用 `./data/index.sqlite` 作为索引库

## 用法

默认会读取：

- Codex sessions：`~/.codex/sessions`
- 标题索引：`~/.codex/session_index.jsonl`
- SQLite 索引：项目内 `./data/index.sqlite`

先建立索引：

```bash
./bin/cxs sync
```

`sync` 默认是严格模式：任一文件解析或写库失败都会带着 per-file 诊断非零退出，并且不会提交半截索引。只有显式传 `--best-effort` 时，才会继续写入成功部分。

搜索会话：

```bash
./bin/cxs find "health check"
```

`find` 会返回标题、派生的 session summary，以及当前锚点 snippet，方便先做轻量筛选再决定是否 `read-range`。如果命中只来自 session-level title/summary/compact/reasoning summary，结果会标为 `matchSource = "session"`，这时先用 `read-page` 浏览整场会话。

围绕命中点读取局部上下文：

```bash
./bin/cxs read-range <sessionUuid> --seq 12
./bin/cxs read-range <sessionUuid> --query "health check"
```

分页读取整场会话：

```bash
./bin/cxs read-page <sessionUuid> --offset 0 --limit 20
```

列出已索引 session（不做全文检索）：

```bash
./bin/cxs list --limit 20
./bin/cxs list --cwd hammerspoon --since 2026-04-01 --sort ended
```

索引状态：

```bash
./bin/cxs stats
```

## 快速开始

首次使用建议按下面顺序：

```bash
bun install
./bin/cxs sync
./bin/cxs find "health check"
./bin/cxs read-range <sessionUuid> --seq <matchSeq>
```

如果你已经知道当前项目路径，也可以先缩范围：

```bash
./bin/cxs list --cwd /Users/you/work/project --sort ended -n 10
```

## 当前实现边界

当前 retrieval 主链是：

`message/session recall -> session heuristic rerank -> read-range/read-page`

已经落地的能力：

- `messages_fts` 驱动的候选召回
- `sessions_fts(title + summary_text + compact_text + reasoning_summary_text)` 驱动的 session-level 召回
- `summary_text` 派生摘要
- JSONL `type=compacted` handoff 与 `response_item.reasoning.summary` 低成本接入
- session-level FTS 字段权重：title 8.0、compact 4.0、summary 3.0、reasoning summary 1.2
- session 级 heuristic rerank
- manual eval 导出与 batch compare

还没落地的能力：

- 真正的 resource-level reranker
- duplicate collapse / diversity control

更完整的实现说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，后续路线见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 常见问题

### 为什么 `find` 没搜到我刚刚的 session？

先看索引时间：

```bash
./bin/cxs stats --json
```

如果 `lastSyncAt` 很旧，先重新同步：

```bash
./bin/cxs sync
```

### 为什么有些中文短 query 命中不稳定？

当前主召回仍以 message FTS 为主，极少数零 token CJK query 才会回退到 LIKE。短 query 本身信息量低，建议换成更长的词组或加项目上下文。

### 为什么不做自动实时同步？

这是刻意的产品边界。当前接受“手动触发的增量 sync”，而不是 watcher/daemon。

## 开发

运行测试：

```bash
bun test
```

跑手工评测：

```bash
bun run eval:manual
```

`eval:manual` 的 pass 判定现在采用 “Top-K 窗口内所有已配置 predicate 都必须命中” 的语义，并会把 predicate 级别结果写进导出 README/scorecard，避免单个弱命中把整条 query 误记为通过。

对比两次评测批次的 Top1 变化：

```bash
bun run ./eval/compare-eval-batches.ts data/cxs-eval/<before-batch> data/cxs-eval/<after-batch>
```

## 开源协作

- 项目规则见 [AGENTS.md](AGENTS.md)
- 协作说明见 [CONTRIBUTING.md](CONTRIBUTING.md)
- 当前公开目标是“可接手、可验证、可继续演进”的源码仓库，不承诺 npm 发布流程稳定

## 配套 Skill

仓库内自带一个项目共享 skill：

- `.agents/skills/cxs`

推荐用 `npx skills add` 安装，而不是手动复制：

```bash
npx skills add catoncat/cxs --skill cxs -g -a codex -y
```

如果只想先看仓库里有哪些 skill：

```bash
npx skills add catoncat/cxs --list
```

CLI install guide:

`https://github.com/catoncat/cxs#cli-install-guide`

注意：

- 最稳的做法是先让 `cxs` 命令可执行，或设置 `CXS_BIN=/absolute/path/to/bin/cxs`
