# cxs

`cxs` 是一个面向本机 Codex 会话日志的渐进式检索 CLI。

当前命令面：

- `cxs sync`
- `cxs find <query>`
- `cxs read-range <sessionUuid>`
- `cxs read-page <sessionUuid>`
- `cxs list`
- `cxs stats`

## 安装

```bash
bun install
```

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

`find` 会返回标题、派生的 session summary，以及当前锚点 snippet，方便先做轻量筛选再决定是否 `read-range`。

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
