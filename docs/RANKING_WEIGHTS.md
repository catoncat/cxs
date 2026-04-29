# cxs ranking 权重说明

本文是 [ranking.ts](../src/ranking.ts) 与 [query/search.ts](../src/query/search.ts) 与 [ranking.ts](../src/ranking.ts) 中所有 magic constant 的“为什么是这个值”说明，受众是未来要调权重的维护者(人或 agent)。

每个权重都需要在三个层次的相对量级里活下去：

1. **bm25 row-level 分数**(从 `src/query/search.ts:120` 或 `messages_fts` 的 `bm25(...)` 来)。被 `-row.score` 翻成正向后，单行通常落在 `2 ~ 15`。
2. **row-level signal bonus** (`scoreRow`)。叠加在 bm25 之上,常见区间 `0 ~ 16`。
3. **session-level metadata bonus** (`scoreSession`)。是一个 session 维度的“补强”加层,常见区间 `0 ~ 80`。

“调权” = 在这三层之间挪动相对优先级。先有这个心智模型,再读下面每个常量。

---

## SQL 列权重: `bm25(sessions_fts, 8.0, 3.0, 4.0, 1.2)`

位置: [query/search.ts:120](../src/query/search.ts)。

`sessions_fts` 的索引列顺序固定为 `(title, summary_text, compact_text, reasoning_summary_text, session_uuid)`,`session_uuid` 是 UNINDEXED,所以 bm25 的四个权重对应前四列。SQLite FTS5 的 bm25 输出是 *负数*,**值越小越好**;权重越大表示该列匹配应该被放大。

| 列 | 权重 | 角色 |
|---|---|---|
| `title` | 8.0 | 高浓度信号:标题是人写/生成的概括,几乎没噪声 |
| `summary_text` | 3.0 | session 摘要,信息密度中等,长度也中等 |
| `compact_text` | 4.0 | compact handoff 文本,通常比 summary 更覆盖原文术语 |
| `reasoning_summary_text` | 1.2 | reasoning summary,噪声最大、最容易泛匹配 |

**为什么是这个量级**:

- title 与其他列拉开 ~2x,是希望 *标题恰好命中* 的 session 不需要 row-level signal 也能进入候选集。session-level 还有一个独立的 `titlePhrase=30` 在更高层面再加,所以这里 8.0 不是终值,只是把 title hit 推到 `sessions_fts` 候选的前列。
- compact > summary 是经验:compact handoff 倾向于完整保留代码/路径/工具名,搜“某个具体函数名”时它的命中含金量更高。
- reasoning summary 给到 1.2 是因为它最长、最易抢分,如果给 4.0 会让“agent 在思考里随口提过的词”压过真正的内容命中。

**改动它会影响什么**:

- 整体放大(比如全乘 2)不改变 row 间相对顺序,只把 session 路径的 row 在 row-level signal 加完后压制 `messages_fts` 路径。**几乎没意义,不建议**。
- 单独抬高 reasoning_summary 是高风险动作:reasoning 文本里高频出现 "user said", "the code does",会把 session 推到全局头部又没真信息。改之前必须有 P1-2 mixed match 对照测试做回归。
- 单独抬高 title 收益小、风险也小,但要记得 `scoreSession` 那一层已经有 `titlePhrase=30 / titleTermHits×10`,改这里等于双重计入,改一处就好。

---

## scoreRow: 单 row 信号

位置: [ranking.ts:166-178](../src/ranking.ts)。

```
normalizedBm25
  + (contentPhrase ? 8 : 0)
  + termCoverage * 2
  + (matchSource === "message" ? 4 : 0)
  + (matchRole === "user" ? 2 : 0)
```

四项的设计意图是:**bm25 + 三个 token-free 的硬证据**。bm25 处理“词义相关性”,这三项处理 bm25 看不到的元信息。

### `contentPhrase ? 8 : 0`

整条 normalizedQuery(已 trim+lower)作为子串出现在 row 文本里时加 8。

- 量级取舍:8 大致等于一条“标题级”单列 bm25。意思是“整词组完整命中” ≈ “标题里出现过这个词”,这是一个故意做高的赌注,因为 bm25 在 token 切分后看不到“两个词必须挨着”这种用户意图。
- 改高(>=12):对引号式查询会更准,但中文长 query 会几乎自动满分,失去区分度。
- 改低(<=4):多 token 查询会被 bm25 单词命中淹没,“`hash collision`” 这种短语和 “`hash` 在 X、`collision` 在 Y”同分。改低之前先做 P1-2 mixed match 对照测试。

### `termCoverage * 2`

`countMatchedTerms(content, terms)`,即 query 里多少个 token 在这一行出现过。

- 量级取舍:每个 token 加 2,3-token query 满覆盖 = 6,差不多和 user-bump+message-bump 加起来一个量级,保证“覆盖更全的行”能压过“偶然命中一个高频词的行”,但不至于盖住 contentPhrase 的 8。
- 改高(>=4):短 query 没影响,长 query 会让“凑齐了所有词但散得很开的长行”赢,这通常不是搜索者想要的——bm25 已经在做这件事了,这一项是“补强”不是“主信号”。
- 改低(<=1):多 token query 的覆盖度退化为可有可无,大概率出现“两词都命中但只命中一次的行 < 一词命中三次的行”这种反直觉结果。

### `matchSource === "message" ? 4 : 0`

session-level 召回(来自 `sessions_fts`)拿不到这 4 分,只有 `messages_fts` / LIKE 路径来的 row 才有。

- 量级取舍:4 表示“可回读的真实消息证据”比“只在 session 元数据里命中”值多大约半个 contentPhrase。这是一个产品价值判断:用户能 `read-range` 进去看到原文的命中,价值远高于只在 summary 里出现的命中。
- 改高(>=8):会让 session-level 命中几乎永远沉底,尤其是“title 完全命中但没有 message 命中”的 session 会被压到看不见,跟 `scoreSession.titlePhrase=30` 的初衷打架。
- 改低或去掉:read-range 体验劣化——用户 `cxs find` 看到结果,点进去 read-range 经常发现没有可定位的消息,要被迫去 read-page。

### `matchRole === "user" ? 2 : 0`

user-authored content 比 agent 输出多 2 分。

- 量级取舍:2 是几个权重里最小的,因为这是一个“轻偏好”而不是“强信号”。前提假设:用户搜索时心里想的更多是“我之前说过什么”而不是“agent 答了什么”。但 agent 答案里也常含有用户问的同样的词,所以不能给太高,否则 user 复述一次就压掉 agent 的完整答复段。
- 改高(>=4):适合 “主要回忆自己问过什么” 的人;副作用是 agent 总结性的命中(常常正是用户要找的)被压低。
- 改低(=0):退化为不区分 role,适合“两边都重要”的工作流。

---

## scoreSession: session 级补强

位置: [ranking.ts:186-197](../src/ranking.ts)。

```
bestRowSignalScore
  + (titlePhrase ? 30 : 0)
  + titleTermHits * 10
  + cwdTermHits * 18
  + min(userHitCount, 3) * 4
  + min(sessionHitCount, 2) * 2
  + min(hitCount, 6) * 1.5
  + recencyBonus
```

这一层的目的:**让“证据稍弱但 session 整体强相关”的 session 也能赢**。bestRowSignalScore 是 `scoreRow` 出来的最大值,后面所有项是“session 才能看到的信号”。

### `titlePhrase ? 30 : 0`

整条 normalizedQuery 作为子串出现在 title 里加 30。

- 量级取舍:30 是全文档最大的单项 bonus,故意做高。bm25 + scoreRow 满分大约 25-30,这一项一旦命中就足以让一个 row-level 弱命中的 session 进前列。
- 直觉:用户搜的词如果完整出现在 session 标题里,几乎可以肯定是同一件事,任何 row 级证据都不必再压它。
- 改高(>=50):很少会让结果更好,反而让“标题恰好包含但内容已不相关”的旧 session 浮起来。
- 改低(<=15):title-only 命中失去优先级,搜索短语类 query 时退化明显。

### `titleTermHits * 10`

token 维度的 title 命中,每命中一个 query token 加 10。

- 量级取舍:乘 10 让 “3-token 全命中标题” = 30,与 phrase 命中持平。即“词都在标题里、只是顺序对不上”可以达到 phrase 的水平。
- 改高(>=15):多 token query 里只要有几个词出现在标题就压顶,即使语义未必相关——容易被高频词带偏。
- 改低(<=4):短 phrase 更倾向 phrase 命中而不是 token 命中,中文 query bigram 切分后 token 多、容易因为打折而退化。

### `cwdTermHits * 18`

每命中一个 query token 在 session 的 `cwd` 中,加 18。

- 量级取舍:18 比 titleTermHits×10 更大,这是因为 cwd 的“噪声密度”远低于 title——title 是自然语言、可能和 query 同词不同意,而 cwd 是文件路径,query token 命中 cwd 几乎一定意味着用户当时在那个仓库/目录。
- 比 titlePhrase=30 略低,但单 token 命中就给 18,意味着“在某个 repo 名里出现过的 query token” = 半个 phrase 命中,这是给“按项目找”的工作流量身定的。
- 改高:几乎所有 query 都会被 cwd 主导,严重的话两条同 repo 的不相关 session 比一条跨 repo 的精准命中还高,这是错的。
- 改低或去掉:跨仓库使用 cxs 找“在哪个项目里讨论过 X”体验会变差,这是当前 cxs 的核心使用场景之一。

### `min(userHitCount, 3) * 4`

session 里 user-role 的 row 命中数,先 clamp 到 3,再乘 4(满分 12)。

- clamp=3 的意义:防止“用户在同一 session 里反复提同一个词”就把这个 session 推到顶。3 次 user 命中以上视为饱和——再多没有更多信息量。
- 量级取舍:满分 12 大致 = bm25 一行的中等命中,不会压过 title 信号但能在两条 row-level 旗鼓相当时做 tiebreak。
- 改高 clamp(>=5):适合“用户经常多轮 follow-up”的工作流,但要警惕日志里的复读机式 session 抢顶。
- 改高乘数(>=6):4*5=20 接近 cwd 量级,会让“只是用户提到过几次”的 session 升得太高。

### `min(sessionHitCount, 2) * 2`

session-level row(`matchSource === 'session'`)的命中条数, clamp 到 2,乘 2(满分 4)。

- 为什么这么小:session-level 命中本身已经在 `bm25(sessions_fts, ...)` 里被打过分,scoreSession 里再算一次只是保证“title + summary + compact 多列同时命中”能比“只命中其中一列”略好。
- clamp=2 的意义:`sessions_fts` 一个 session 最多产 1 行(去重过),实际能到 2 的情况很少;clamp 在 2 是为了未来如果路径里产生多 session-level row 时的封顶。
- 改这个权重的收益很低,通常不要动它,先看 SQL 列权重那一节。

### `min(hitCount, 6) * 1.5`

session 内总命中行数,clamp 到 6,乘 1.5(满分 9)。

- clamp=6 的意义:总命中行数饱和点。一个 session 里 6 条以上 row 命中,几乎可以肯定是相关的;再多反而可能是噪声(冗长 session 沾边了几个高频词)。
- 1.5 是“最弱信号”的乘数:命中数本身已经被 bm25 / scoreRow 算过,这里只是“量上的小补强”。
- 改高 clamp(>=10):长 session 永远比短 session 优势大,惩罚“一次精准命中的短 session”。clamp 在 6 是为了把“质”和“量”的权衡偏向质。
- 改低乘数(<=0.5):没什么副作用,但也没什么收益,不建议动。

---

## recencyDecay: 时间衰减

位置: [ranking.ts:205-210](../src/ranking.ts)。

```
max(0, 18 - days_since_ended * 0.15)
```

| 参数 | 值 | 含义 |
|---|---|---|
| 起始 bonus | 18 | 当 `endedAt = now` 时的最大加分 |
| 每日衰减 | 0.15 | 每过 1 天减 0.15 |
| 截断窗口 | 120 天 | `18 / 0.15 = 120`,超过后归零 |

**18 的量级取舍**:

- 18 设计成“接近 cwd 单 token 命中(也是 18)”但仍小于 `titlePhrase=30`。意思是:今天的 session 即使没有 cwd/title 命中,也大约相当于一次 cwd 命中的优先级——但永远不超过明确语义命中。
- 这是反“最近就是最相关”的:cxs 的搜索更偏召回历史而不是 timeline 浏览,所以 recency 不能压过内容信号。

**0.15/day 的量级取舍**:

- 一周衰减 ~1 分,一个月 ~4.5 分。意味着“最近一周内的差异基本可忽略”,但 1 个月外开始让位给真正的内容命中。
- 这条是经验取值,代表“记忆里‘最近’的边界”大概是几周不是几天。

**120 天截断的含义**:

- 4 个月之外的 session,recency 完全不参与排序,纯靠内容信号。这是一个有意为之的“记忆边界”——如果你在搜半年前的事情,recency 不应该再帮倒忙地把无关的近期 session 推上来。
- 改窗口的影响:窗口越长,timeline 偏好越长尾;窗口越短,排序在窗口之外彻底变成内容驱动。120 天是个折衷,不建议轻易动。

**改动它会影响什么**:

- 抬高 18 → recency 接近内容信号,适合“几乎只搜最近”的人,但会让 cxs 退化成时间倒序 + 内容过滤。
- 抬高 0.15 → 旧 session 更快沉底,适合搜短期记忆;副作用是“两个月前那次配置”这类长跨度回忆变难。
- 把整个函数换成指数衰减:技术上可行,但目前没有数据支持指数比线性更好,而且会损失这套权重和别的常量之间清晰的“几分等于一次命中”的对应关系。

---

## shouldUseDisplayRow: message 优先于 session

位置: [ranking.ts:148-157](../src/ranking.ts)。

```ts
if (candidate.matchSource === "message" && current.matchSource !== "message") return true;
if (candidate.matchSource !== current.matchSource) return false;
return candidateScore > currentScore;
```

这不是一个数字权重,而是一个**硬规则**:对 *显示用* 的 best row,**只要候选是 `message` 而当前不是,立刻替换,不比较分数**。

**为什么这样选**:

- `bestRow` 决定 ranking,`bestDisplayRow` 决定用户在 `cxs find` 列表里看到的 snippet/seq/role/timestamp。两个故意拆开。
- 一个 session 可能同时有 `messages_fts` row(score 偏低,但来自真实消息)和 `sessions_fts` row(score 偏高,但只命中标题/摘要)。如果 display 跟着分数走,用户会看到 `matchSeq=null` + 一个 session-level snippet,而 `cxs read-range <uuid>` 必须显式带 `--seq` 或 `--query` 才能锚定,空 `matchSeq` 直接断了直接重锚链路,被迫回退 `cxs read-page` 翻全 session。
- 显示层的真正决策是 **read-range 可用性**:有 anchor 的 row(message)永远优先,即便 session-level row 分数更高。

**改动它会影响什么**:

- 如果改成“按分数走”:列表里 snippet 更可能反映“为什么排第一”(因为常常是 title 命中导致它进了前列);代价是用户点进去发现 read-range 没法直接定位,UX 退步。
- 如果反过来 `session > message` 优先:对短查询友好(会显示标题命中),对长查询/具体问题查询灾难,因为用户其实最想看到他/agent 的原话。
- 当前选择是经过权衡的:**ranking 用全部信号,展示偏向 read-range 友好**。如果将来引入独立的 “preview” 系统(比如每个 session 给一段 LLM 生成的命中解释),这条规则可以放松,但现在不要改。

---

## 调权 checklist

在动任何一个数字之前,先问自己:

1. 这个改动属于 SQL 列权重 / row signal / session signal / recency 哪一层?
2. 它和同一层的其他常量有没有量级冲突?(例如改 `titlePhrase` 必须和 `titleTermHits` 一起看,因为 3-token 全命中标题的总分是 `30 + 30`)
3. 它和其他层的常量有没有量级冲突?(例如 `cwdTermHits=18` 和 `recency 起始=18` 是故意持平的)
4. 有没有 P1-2 mixed match 对照测试做回归?contentPhrase / SQL 列权重这种改动尤其需要。
5. 改动是为了一个具体的搜索 case 还是一个 *分类* 的搜索 case?为单 case 调权基本一定会让平均体验变差,先确认这是一个 pattern。

如果这五条里有一条答不上来,**不要改**。
