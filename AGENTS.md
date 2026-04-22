# cxs Agent Guide

## 项目定位

`cxs` 是一个面向本机 Codex session 日志的渐进式检索 CLI，不是 GUI app，也不是实时同步守护进程。

当前接受的产品边界：

- 命令面固定为：`sync`、`find`、`read-range`、`read-page`、`list`、`stats`
- 主工作流固定为：`sync -> find -> read-range/read-page`
- `sync` 是唯一会修改索引的命令；其余命令只读 SQLite
- 默认接受手动增量同步，不做 watcher / daemon / realtime sync
- 这个仓库可以作为其他 sidecar / GUI 的 retrieval engine，但本仓库自身不以 GUI 为目标

## 当前实现真相

- 检索主链是 `message recall -> session heuristic rerank -> progressive read`
- 候选召回来自 `messages_fts`，极少数零 token CJK query 会回退到 LIKE
- `summary_text` 已持久化，也会参与结果展示和 rerank，但还没有进入 recall 面
- `classifyQueryProfile()` 仍存在，但当前评分没有按 `broad/exact` 做显式分权
- parser 只入库 `event_msg` 里的 user / assistant message；其他 event 不形成 projection

不要把下面这些说成已完成：

- 真正独立的 stage-2 / resource-level reranker
- `summary_text` 或 session/resource 级独立 FTS recall
- richer projection / range cache / event-level replay
- duplicate family collapse / diversity control
- 强约束的 gold set / rubric / error taxonomy

## 代码地图

- [cli.ts](/Users/envvar/work/repos/cxs/cli.ts): CLI 命令面
- [indexer.ts](/Users/envvar/work/repos/cxs/indexer.ts): sync 与索引更新
- [parser.ts](/Users/envvar/work/repos/cxs/parser.ts): Codex JSONL 解析与 `summary_text` 生成
- [db.ts](/Users/envvar/work/repos/cxs/db.ts): SQLite schema、会话/消息存取
- [query.ts](/Users/envvar/work/repos/cxs/query.ts): find / list / read-range / read-page 查询编排
- [ranking.ts](/Users/envvar/work/repos/cxs/ranking.ts): session heuristic rerank
- [eval/](/Users/envvar/work/repos/cxs/eval): manual eval、batch compare

## 文档规则

- 优先维护当前态文档，不保留“看起来像现状、其实只是目标态”的 research 长文
- 如果文档已经腐化，优先删除或重写，不要叠补丁式修辞
- `docs/` 里的文档要服务后续 agent 直接接手，而不是保留调研过程痕迹
- 任何涉及“当前已实现什么”的文档，都必须先对齐代码和测试

## 项目共享 Skill

仓库内维护项目共享 skill：

- `.agents/skills/cxs`

对外推荐安装方式：

```bash
npx skills add catoncat/cxs --skill cxs -g -a codex -y
```

注意这个 skill 不会自动安装 `cxs` CLI 本体。默认约定：

- 优先使用 `CXS_BIN`
- 未设置时回退到 `PATH` 里的 `cxs`

## 默认验证

涉及实现或文档真相变更时，至少做与改动直接相关的验证：

- `bun test`
- 必要时补一条 CLI 烟测，例如 `./bin/cxs stats --json` 或 `./bin/cxs find "<query>" --json`

没有验证证据，不要声称“已对齐”“已完成”“文档正确”。

## 当前近端优先级

1. 先把 eval 从弱提示升级成更可信的 acceptance gate
2. 再决定是否推进 `summary/projection` 独立 recall 面
3. 更重的 reranker / projection / diversity 控制放后面

具体 roadmap 见 [docs/ROADMAP.md](/Users/envvar/work/repos/cxs/docs/ROADMAP.md)。
