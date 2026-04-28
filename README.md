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

## CLI Install Guide

> **平台支持**:**macOS / Linux only**(`darwin-arm64` / `darwin-x64` / `linux-x64` / `linux-arm64`)。Windows 走 WSL,我们没原生测过 Windows path。

### npm 全局安装(推荐,需要 Node 22+)

```bash
npm i -g @act0r/cxs
```

装出来的命令是 `cxs`。当前唯一发布形态是 Node.js npm 包,不再发布 standalone binary。

也可以一次性用 npx:

```bash
npx @act0r/cxs --help
```

> 包名是 scoped 的,因为 npm 上 `cxs` 已被 css-in-js 库占用。

### 从源码(开发者 / 需要 PR)

```bash
git clone https://github.com/catoncat/cxs.git
cd cxs
npm install
npm run cxs -- --version    # 通过 tsx 直接跑 cli.ts
```

完整工程命令:`npm run check`(tsc + vitest)、`npm run build`(esbuild bundle 出 `dist/cli.js`)、`npm run eval:perf`(真实大库基准)。

### 首次使用建立索引

```bash
cxs sync
cxs stats --json
```

没有单独的 `init` 命令；`sync` 会创建并更新索引。若直接用 `npx` 试跑:

```bash
npx @act0r/cxs sync
npx @act0r/cxs find "health check"
```

`--help` 应列出 `sync` / `find` / `read-range` / `read-page` / `list` / `stats` / `current`。

### 数据目录

索引默认写到 `~/.local/state/cxs/index.sqlite`(XDG state 约定;`$XDG_STATE_HOME` 也尊重)。`CXS_DATA_DIR` 环境变量优先级最高:

```bash
export CXS_DATA_DIR="$HOME/.config/cxs"
```

**自动迁移**:之前装过 cxs 0.2.0 及以下、索引在 `~/.cache/cxs/` 的用户,首次跑新版 `cxs sync` 会自动 `rename` 整个目录到 `~/.local/state/cxs/`,**不需要重 sync**(240 MB 索引不会重建)。如果新位置已有数据,迁移跳过,旧 cache 留在原地等用户手动处理。

### 要求

- 本机可读 `~/.codex/sessions`
- Node.js `>= 22`

## 用法

默认会读取：

- Codex sessions：`~/.codex/sessions`
- 标题索引：`~/.codex/session_index.jsonl`
- SQLite 索引：项目内 `./data/index.sqlite`

先建立索引：

```bash
cxs sync
```

`sync` 默认是严格模式：任一文件解析或写库失败都会带着 per-file 诊断非零退出，并且不会提交半截索引。只有显式传 `--best-effort` 时，才会继续写入成功部分。

搜索会话：

```bash
cxs find "health check"
```

`find` 会返回标题、派生的 session summary，以及当前锚点 snippet，方便先做轻量筛选再决定是否 `read-range`。如果命中只来自 session-level title/summary/compact/reasoning summary，结果会标为 `matchSource = "session"`，这时先用 `read-page` 浏览整场会话。

围绕命中点读取局部上下文：

```bash
cxs read-range <sessionUuid> --seq 12
cxs read-range <sessionUuid> --query "health check"
```

分页读取整场会话：

```bash
cxs read-page <sessionUuid> --offset 0 --limit 20
```

列出已索引 session（不做全文检索）：

```bash
cxs list --limit 20
cxs list --cwd hammerspoon --since 2026-04-01 --sort ended
```

索引状态：

```bash
cxs stats
```

## 快速开始

下面以已安装的 `cxs` 命令为例；源码 checkout 中可把 `cxs` 替换成 `npm run cxs --`。

首次使用建议按下面顺序：

```bash
cxs sync
cxs find "health check"
cxs read-range <sessionUuid> --seq <matchSeq>
```

如果你已经知道当前项目路径，也可以先缩范围：

```bash
cxs list --cwd /Users/you/work/project --sort ended -n 10
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
cxs stats --json
```

如果 `lastSyncAt` 很旧，先重新同步：

```bash
cxs sync
```

### 为什么有些中文短 query 命中不稳定？

当前主召回仍以 message FTS 为主，极少数零 token CJK query 才会回退到 LIKE。短 query 本身信息量低，建议换成更长的词组或加项目上下文。

### 为什么不做自动实时同步？

这是刻意的产品边界。当前接受“手动触发的增量 sync”，而不是 watcher/daemon。

## 开发

运行测试：

```bash
npm run check
```

跑手工评测：

```bash
npm run eval:manual
```

`eval:manual` 的 pass 判定现在采用 “Top-K 窗口内所有已配置 predicate 都必须命中” 的语义，并会把 predicate 级别结果写进导出 README/scorecard，避免单个弱命中把整条 query 误记为通过。

对比两次评测批次的 Top1 变化：

```bash
npm run eval:compare -- data/cxs-eval/<before-batch> data/cxs-eval/<after-batch>
```

## 开源协作

- 项目规则见 [AGENTS.md](AGENTS.md)
- 协作说明见 [CONTRIBUTING.md](CONTRIBUTING.md)
- 当前公开目标是“可接手、可验证、可继续演进”的源码仓库；发布流程以 npm 包为唯一分发面

## 可安装 Skill Package

仓库内保留一个发行用 skill package，刻意不放在 `.agents/skills` 下，避免 clone 本仓库后被当前项目的 agent runtime 当成本项目 workflow 自动加载：

- `skill-packages/cxs`

推荐用 `npx skills add` 安装，而不是手动复制：

```bash
npx skills add catoncat/cxs --full-depth --skill cxs -g -a codex -y
```

如果只想先看仓库里有哪些 skill：

```bash
npx skills add catoncat/cxs --full-depth --list
```

CLI install guide:

`https://github.com/catoncat/cxs#cli-install-guide`

注意：

- `npx skills add` 只安装 agent skill，不安装 CLI 本体
- 安装或更新 skill 后，需要重启 Codex / 开新 session 才会被 agent 发现
- 推荐先按 CLI install guide 让 `cxs` 可执行，或设置 `CXS_BIN=/absolute/path/to/bin/cxs`
