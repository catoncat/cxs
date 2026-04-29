# cxs 代码质量审查报告（2026-04-27）

## 结论

当前 `cxs` 代码质量中上，已经是可接手的小型 CLI 项目；主要风险不在代码结构本身，而在工程化、异常路径和少数边界防御还需要补强。

综合评分：**7.5 / 10**。

## 审查范围

本次审查基于当前工作区状态，而不是 clean `main`。审查覆盖：

- `src/cli.ts`
- `src/parser.ts`
- `src/db.ts`
- `src/query.ts`
- `src/ranking.ts`
- `src/indexer.ts`
- `src/sync-lock.ts`
- `src/types.ts`
- 测试文件与项目文档

验证命令：

```bash
npm run check
```

结果：

```text
48 pass
0 fail
```

## 优点

### 1. 项目边界清楚

`cxs` 明确定位为本机 Codex session 日志的渐进式检索 CLI，不把 GUI、watcher、daemon、realtime sync 混进来。

当前主工作流保持为：

```text
sync -> find -> read-range/read-page
```

### 2. 模块拆分健康

当前代码地图比较清晰：

- `src/cli.ts`：CLI 命令面
- `src/indexer.ts`：sync 与索引更新
- `src/parser.ts`：Codex JSONL 解析与 session summary 生成
- `src/db.ts` + `src/db/`：SQLite facade、schema、session/message/coverage/store 模块
- `src/query.ts` + `src/query/`：查询 facade、find/list/read-range/read-page/stats/search/snippet 模块
- `src/ranking.ts`：session 级 heuristic rerank
- `eval/`：manual eval 与 batch compare

这对一个本地 CLI 来说是健康结构；后续已进一步把 db/query 大文件拆成 facade + 子模块。

### 3. 当前改动方向合理

本轮实现方向整体正确：

- 增加 `current` 命令，从 Codex state DB 按 cwd 找候选 session。
- 增加 session-level recall，把 `title + summary_text + compact_text + reasoning_summary_text` 纳入 `sessions_fts`。
- 引入 `matchSource = "session"` 与 `matchSeq = null` 语义，避免把 summary/compact 伪造成可回读 message。
- 保持 `messages` 只表示真实可回读 transcript。
- 增加 sync single-writer lock 与 read busy timeout。
- 同步更新 README、AGENTS、architecture、roadmap、skill JSON schema 等文档。

尤其值得保留的是：**不把 compact/summary 写成 `seq = -1` 的虚拟 message**。这个设计比把 session-level signal 混入 message stream 更干净。

### 4. 测试覆盖不差

现有测试已经覆盖：

- CLI help/current/find/list/stats/read-page/sync fail
- parser 对 compacted handoff 与 reasoning summary 的抽取
- query 的 title-only recall、field weights、compact recall、snippet density、parallel read lock
- indexer 的 strict/best-effort、writer lock、stale lock
- eval predicate 语义

## 主要问题与风险

### P0-1：缺少真正的 TypeScript 类型检查 ✅ 已修复

> 状态：已在 commit `be75d87 chore: add TypeScript check` 修复（写本报告之后）。`tsconfig.json` 已就绪、`check` 后续已对齐为 `tsc --noEmit && vitest run`。

原文（保留作为背景）：`package.json` 中 `check` 当时只是 runner 测试，没有 `tsc --noEmit`。执行 TypeScript 不等于有完整类型检查。

当前类型已经开始变复杂，例如：

- `matchSeq: number | null`
- `matchSource: "message" | "session"`
- `FindMatchRole`

建议补：

- `tsconfig.json`
- `npx tsc --noEmit`
- 把 `check` 改成 `tsc --noEmit && vitest run`

### P0-2：DB 连接在异常路径上可能泄漏

部分 query 函数当前是：

```ts
const db = openReadDb(dbPath);
const session = getSessionRecord(db, sessionUuid);
if (!session) throw new Error(...);
db.close();
```

如果中间 throw，`db.close()` 不会执行。

建议把 query 层所有 open/close 统一改成：

```ts
const db = openReadDb(dbPath);
try {
  // work
} finally {
  db.close();
}
```

`getCurrentSessions()` 已经采用这种结构，其他函数应对齐。

### P0-3：sync lock stale 清理存在竞争窗口 ⚠️ best-effort mitigation

> 状态：已在 commit `187c5d9` 部分缓解 — 引入 `tryRemoveStaleLock` 在删除前二次比对 `pid + createdAt`。但这是 best-effort,**不是原子 TOCTOU 修复**：在二次读取与 path-based `rmSync` 之间仍有残余 race 窗口,另一个进程可能在该窗口内删除并替换 lock,导致当前进程仍可能 `rmSync` 别人的新 lock。Node 层没有 inode-pinned unlink,要做真正原子需引入 OS-level flock(native bindings)。
>
> 工程决策：cxs 的 sync 是低并发异常路径,残余 race 窗口极窄,接受 best-effort 表述并在 `src/sync-lock.ts:tryRemoveStaleLock` 注释里明确标注。如未来观察到锁损坏,再考虑引入 flock 或换 rename-based 抓取。

原文（保留作为背景）：当前逻辑遇到已有 lock 后会读 lock info，判断 pid 不存在就删除 lock 文件。这里有一个竞态：读到 stale lock 之后、删除之前，另一个进程可能已经创建了新 lock；当前进程可能误删别人的新 lock。

建议删除前重新读取并比对 `pid + createdAt`，只删除自己刚判断过的那份 lock。

另外，损坏的 lock file 当前会被解析为 `null`，然后等到 timeout 报 unknown owner。可以增加基于 mtime 的过期清理或更明确的错误信息。

### P0-4：`current` 命令对 Codex state DB schema 假设偏硬

`current` 直接依赖 `threads` 表和字段：

- `id`
- `rollout_path`
- `cwd`
- `title`
- `updated_at_ms`

这对当前本机可用，但作为开源 CLI，Codex state DB schema 可能变化。建议：

- 先检查 table/columns 是否存在。
- schema 不匹配时输出友好错误。
- `--json` 模式返回结构化 error，而不是 SQLite 原始异常。

## 次级问题

### P1-1：ranking 逻辑开始堆 magic constants

当前 ranking 使用多组启发式权重，例如 title phrase、title term、cwd term、message bump、user bump、session hit、hit count、recency 等。

这对轻量 retrieval CLI 是合理的，但继续堆会变难调。下一步不建议继续盲目加权重，应优先补 manual eval acceptance gate。

### P1-2：mixed match 展示策略需要专门测试

当前展示行优先选择 message hit，避免用户拿到 `matchSeq = null` 后无法 `read-range`。这是合理产品取舍，但可能掩盖真正强的 session-level 命中。

建议增加 mixed case 测试：同一个 session 里同时有强 session-level hit 和弱 message hit 时，确认展示策略符合预期。

### P1-3：缺少真实大库性能基准

现有单元测试较好，但还缺：

- 几千 session 下的 sync/find p95
- 大型 `sessions_fts` 的 query 噪音评估
- real-world manual eval regression gate

## 建议优先级

### P0：发前必须做

1. 补 `tsc --noEmit`。
2. query 层所有 DB open 改成 `try/finally close`。
3. 修 sync lock 删除 stale lock 的 race。
4. 对 `current` 做 state DB schema 检查和友好错误。

### P1：增强可信度

1. 把 session-level recall 的 mixed cases 加进 eval。
2. 给 ranking magic constants 写一页短说明，避免后续 agent 乱调。
3. 跑一次真实库 smoke：`sync -> stats -> find -> read-range/read-page`。
4. 把当前大工作区改动拆成 focused commits。

### P2：长期演进

1. eval 从人工报告升级为 regression gate。
2. 再考虑 duplicate collapse / diversity control。
3. 再考虑真正 resource-level reranker。

## 结语

`cxs` 当前已经不是玩具脚本，结构、测试和文档同步意识都比较像一个正经小型 CLI。下一阶段最值得投入的是类型检查、异常路径资源释放、lock race 和 state DB schema 防御，而不是继续堆检索权重。
