# cxs Agent Guide

## 项目定位

`cxs` 是一个面向本机 Codex session 日志的渐进式检索 CLI，不是 GUI app，也不是实时同步守护进程。

当前接受的产品边界：

- 命令面固定为：`status`、`sync`、`find`、`read-range`、`read-page`、`list`、`stats`
- 主工作流固定为：`status -> sync --selector -> find/list -> read-range/read-page`
- `sync` 是唯一会修改索引的命令；其余命令只读 SQLite
- 默认接受手动增量同步，不做 watcher / daemon / realtime sync
- 这个仓库可以作为其他 sidecar / GUI 的 retrieval engine，但本仓库自身不以 GUI 为目标

## 当前实现真相

- 检索主链是 `message/session recall -> session heuristic rerank -> progressive read`
- `status` 只返回执行上下文、source inventory、index 状态与 coverage 状态；它可以扫描 raw session metadata，但不写 index、不回答内容问题
- 内容回答只能来自 cxs index；source inventory 只能用于构造 selector 和判断可能的同步范围，不能作为内容真相源
- `sync --selector` 是建立 coverage 的唯一入口；只读命令不得隐式触发 sync
- 候选召回来自 `messages_fts` 与 `sessions_fts(title + summary_text + compact_text + reasoning_summary_text)`；极少数零 token CJK query 在 message 侧回退到 LIKE
- `summary_text`、`compact_text`、`reasoning_summary_text` 已持久化，也会通过 `sessions_fts` 参与 session-level recall
- session-level FTS 使用显式字段权重：title 8.0、compact 4.0、summary 3.0、reasoning summary 1.2
- `classifyQueryProfile()` 仍存在，但当前评分没有按 `broad/exact` 做显式分权
- parser 只把 `event_msg` 里的 user / assistant 写入 `messages`；`type=compacted` 与 `response_item.reasoning.summary` 只进入 session-level 索引字段，不形成可回读 message projection

不要把下面这些说成已完成：

- 真正独立的 stage-2 / resource-level reranker
- richer projection / range cache / event-level replay
- duplicate family collapse / diversity control
- 强约束的 gold set / rubric / error taxonomy

## 代码地图

- [cli.ts](/Users/envvar/work/repos/cxs/cli.ts): CLI 命令面
- [indexer.ts](/Users/envvar/work/repos/cxs/indexer.ts): sync 与索引更新
- [parser.ts](/Users/envvar/work/repos/cxs/parser.ts): Codex JSONL 解析与 `summary_text` 生成
- [db.ts](/Users/envvar/work/repos/cxs/db.ts): SQLite schema、会话/消息存取
- [query.ts](/Users/envvar/work/repos/cxs/query.ts): find / list / read-range / read-page 查询编排
- [status.ts](/Users/envvar/work/repos/cxs/status.ts): status 输出编排
- [selector.ts](/Users/envvar/work/repos/cxs/selector.ts): selector 解析与覆盖蕴含规则
- [source-inventory.ts](/Users/envvar/work/repos/cxs/source-inventory.ts): raw sessions metadata inventory
- [types.ts](/Users/envvar/work/repos/cxs/types.ts): CLI JSON contract 与核心类型
- [ranking.ts](/Users/envvar/work/repos/cxs/ranking.ts): session heuristic rerank
- [eval/](/Users/envvar/work/repos/cxs/eval): manual eval、batch compare

## 文档规则

- 优先维护当前态文档，不保留“看起来像现状、其实只是目标态”的 research 长文
- 如果文档已经腐化，优先删除或重写，不要叠补丁式修辞
- `docs/` 里的文档要服务后续 agent 直接接手，而不是保留调研过程痕迹
- 任何涉及“当前已实现什么”的文档，都必须先对齐代码和测试

## Skill Package 边界

本仓库不维护项目级 `.agents/skills`。cxs 的 skill 是给用户安装后操作 CLI 的发行物，不是维护本仓库时给 Codex agent 自动加载的项目 workflow。

本仓库维护两条 skill 通道：

- `skill-packages/cxs`: 发布版 skill 源码，必须匹配将要发布的 `cxs` CLI 行为
- `skill-packages/cxsd`: 本机开发版 skill，必须使用 `cxsd` / `CXSD_BIN`，用于 dogfood 当前 checkout

### 发布版 cxs

`cxs` 永远代表线上安装版。不要把本地 dirty tree rsync 到全局 `cxs` skill。

对外推荐安装方式，也是本机更新全局线上 skill 的方式：

```bash
npx skills add catoncat/cxs --full-depth --skill cxs -g -a codex -y
```

注意这个 skill 不会自动安装 `cxs` CLI 本体。默认约定：

- 优先使用 `CXS_BIN`
- 未设置时回退到 `PATH` 里的 `cxs`

### 开发版 cxsd

`cxsd` 永远代表本地 checkout。它用于验证未发布代码和未发布 skill，不用于验证 npm/npx 线上版本。

本机约定：

- dev bin: `/Users/envvar/.local/bin/cxsd`
- dev bin 指向：`/Users/envvar/work/repos/cxs/cli.ts`
- global dev skill: `/Users/envvar/.agents/skills/cxsd -> /Users/envvar/work/repos/cxs/skill-packages/cxsd`
- Claude exposure: `/Users/envvar/.claude/skills/cxsd -> /Users/envvar/.agents/skills/cxsd`

维护规则：

- 改 CLI 行为时，先更新 `skill-packages/cxs`，再同步调整 `skill-packages/cxsd`
- `skill-packages/cxsd` 只能把入口从 `cxs` 改成 `cxsd`，不能发明另一套产品语义
- `skill-packages/cxsd` 内不要出现 `CXS_BIN`、`${CXS_BIN:-cxs}` 或指向发布版 `cxs` 的示例
- 全局 `cxs` 通过 `npx skills add` 更新；全局 `cxsd` 通过 symlink 跟随本地 repo
- 若 `cxs` 与 `cxsd` 行为不一致，先判断是“线上尚未发布”还是“dev skill 漂移”，不要直接覆盖任一通道

## 默认验证

涉及实现或文档真相变更时，至少做与改动直接相关的验证：

- `npm run check`
- 必要时补一条 CLI 烟测，例如 `cxsd status --json` 或 `cxsd find "<query>" --json`
- 涉及 skill 通道时，验证 `npx skills ls -g --json`、`readlink /Users/envvar/.agents/skills/cxsd` 和 `cxsd --help`

没有验证证据，不要声称“已对齐”“已完成”“文档正确”。

## 当前近端优先级

1. 先把 eval 从弱提示升级成更可信的 acceptance gate
2. 继续观察 session-level 字段召回是否引入排序噪音，并补 eval 覆盖
3. 更重的 reranker / projection / diversity 控制放后面

具体 roadmap 见 [docs/ROADMAP.md](/Users/envvar/work/repos/cxs/docs/ROADMAP.md)。
