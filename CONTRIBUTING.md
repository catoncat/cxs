# Contributing

## 开发环境

- Bun `>= 1.3`
- macOS 或其他能读取本机 Codex session 数据的环境

安装依赖：

```bash
bun install
```

## 常用命令

运行测试：

```bash
bun run check
```

跑手工评测导出：

```bash
bun run eval:manual
```

对比两次评测批次：

```bash
bun run ./eval/compare-eval-batches.ts data/cxs-eval/<before-batch> data/cxs-eval/<after-batch>
```

## 贡献边界

- `sync` 是唯一会写索引的命令；其余命令应保持只读
- 不要把“目标态建议”写成“当前实现”
- 优先补强 eval，再继续扩 retrieval 能力
- 不要提交 `data/` 或 `node_modules/`

## 提交前

至少运行：

```bash
bun run check
```

如果改动涉及查询、排序、评测语义，建议补一次：

```bash
./bin/cxs stats --json
```

以及相关 CLI 烟测。
