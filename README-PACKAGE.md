## 本次节奏优化 Beta

这是 Atri 子项目，与 [HDS-Interlude](https://github.com/ISEKAI-MomoiCore/HDS-Interlude) 协同，沿用原人设与剧情，不重建故事、不清理原数据。完整部署以整包 README.md 为准。

- 后台日记、压缩、梦境与其他新版Atri插件共用后台模型通道；前台忙、原生分段未发完、暂停时持续等待，不到一分钟就抢跑。
- 排队不扣尝试次数；首次实际派发前持久化尝试，已有阶段断点继续保留。
- selfRecallRedecide 默认改为 false，自发想到日记留待后续回合。已显式保存 true 的用户需要在Console手动关闭，安装器不改配置。
- 新增 recallBudget 默认3200字符，只限制本轮新增日记/梦境上下文，不改日记原文、归档、HDS现有记忆或隐私标签。按完整带标签块取舍，不跨隐私边界拼接。
- 自发回忆提示需正式剧本提交才生效，草稿作废不留下假回忆；读取后也在正式提交时消费。

---

# Atri Journal & Dreams 0.4.3-beta.1

Atri的日记与梦境子项目，与[HDS-Interlude](https://github.com/ISEKAI-MomoiCore/HDS-Interlude)配合，非HDS官方项目。MIT仅适用于本扩展；HDS自身许可不变。

可选Beta，基于用户交付的0.4.3重新打包；日记、压缩、梦境每阶段持久化断点，多周期顺序队列，阶段前让位前台回合，并包含0.4.2宿主查找兼容修复。生产已安装0.4.3，真实睡眠周期完整生成/归档/同日去重尚待验收。

沿用现有人设、演化、记忆和故事，不另起人格模型。升级前一致性备份，不删除数据库/归档，不重建故事；不要用旧数据库覆盖新聊天。源TGZ未附0.4.3内部QA，本次只报告实际执行的检查；既有0.4.1公开测试不充当0.4.3六项内部测试。

---

# koishi-plugin-atri-journal-dreams

HDS-Interlude（rc57 起）扩展。Atri 每晚按剧情入睡时，会写一篇只有她自己知道的分节日记，按日期归档。日记的记忆会随时间变模糊。每一觉只抽一次签，决定醒来后是否还记得一个梦。

## 日记

- **人设**：只用 HDS 自己的资料，与 HDS 后台压缩看到的投影一致：故事 canon `setting`、演化状态 `settingOverlay`（不一致时以它为准）、perspective，以及各参与者的 relationship / relationshipOverlay。插件不另加人设。
- **何时写**：读取 HDS 的 `lifeRhythm`（`lifeStatus` 兜底）。
  - 在 `nightWindow` 内入睡、持续 20 分钟，就确认为主要睡眠；其他时段需要睡满 3 小时（排除午睡）。
  - 夜里醒来 90 分钟以内仍算同一觉。
- **归属日期**：凌晨 05:00（`dayBoundaryHour`）之前入睡，算前一天的日记。
- **版式**：标题、心情，1–4 个带小标题的小节，末尾是“还惦记着”和梦。每节标注涉及的人和依据的剧本条目。
- **私密标注**：每节由模型按 HDS 人设标为“可以说”或“只有我知道”。
- **记忆压缩（HDS 格式）**：每篇日记另存一份压缩版，字段与 HDS 压缩器的 durable facts 一致：`scope / content / importance / confidence / unresolved / sourceEntryIds / knowledge`，另加 `about`、`privacy`，以及 `episodeTags`（people / places / objects / topics…，必须是原文子串，用于日后定位那一天）。由 HDS 压缩路由低温生成；失败时用确定性兜底。

## 什么时候读日记

| 回合 | 做法 |
|---|---|
| 对方专门提到日记（“日记 / 写了什么”…） | 检索那一天（按日期词或 episodeTags 定位，默认最近一篇），按下表注入 |
| 没提到日记（聊天或 HDS 日常推进） | 不检索、不发送。推进回合只附一句约 40 字、不含内容的习惯提示（`habitHint`，可关） |
| Atri 在剧本里自己想到日记（“翻开日记”“想起日记里写的”…） | 同一回合带着日记重写一次剧本（多一次主模型调用）；HDS 正在流式提前回复时改为下一回合 |

回忆格式沿用 HDS 自己的两层：

| 日记年龄 | 注入位置 | 内容 |
|---|---|---|
| 7 天内 | `recalledHistory`（HDS 的原文回忆，“historical-original-excerpt”） | 当天日记原文，每节标“可以说 / 只有我知道”，由她按人设决定说不说、说多少 |
| 7 天以上 | `memories`（HDS 的派生记忆） | 压缩后的 facts，“好像、大概” |
| 30 天以上 | `memories` | 重要度 ≥0.5 的至多 3 条截短 facts，想不太起来 |
| 找不到 | `memories` | 想不太起来了，不编 |

- 日期写法：昨天 / 前天 / N 天前 / 周X / 上周X / M月D日 / YYYY-MM-DD。
- “还记得昨天吗”这类没提日记的问题交给 HDS 自己的回忆，插件不介入。
- 问梦（“做梦了吗”）只回忆梦，不打开日记。梦醒后才能被回忆，36 小时后淡忘。

## 只有 Atri 知道

- 标“只有我知道”的部分只放在她心里：不说出口、不暗示、不念原文、不把日记给对方看。
- 涉及别人的小节不会给当前聊天对象看，标题也一起隐藏（除非 HDS 开启 `shareParticipantDetails`）。没有当前参与者的推进回合只看不属于任何人的部分，与 HDS 自己的回忆可见性一致。
- 日记内容不写入 HDS 记忆表；模型想把日记抄成新记忆时会被拦下。
- 默认只在私聊生效；HDS 删除某段剧本后，以它为依据的小节、记忆和梦不再被回忆。
- 没有任何聊天指令会显示日记内容。

## 存储

- 数据库表：`atri_journal_cycle`、`atri_journal_runtime`。
- 文件（权限 600）：

```
data/atri-journal-dreams/<故事>/<年>/<月>/
  目录.md            当月索引：日期 · 标题 · 心情 · 有无梦 · 清晰/模糊/已归档
  2026-10-21.md      当天日记（同一天睡两次会分篇）
  2026-09-10.md.gz   超过 30 天后压缩归档
```

超过 30 天的日记，数据库里只保留标题、心情和至多 3 条截短的 facts；完整内容以 gzip 形式存进 `archive` 列。

## 指令（仅管理员）

权限沿用 HDS 的 `sharedStory.managerAccounts`。

- `interlude.journal.status`：睡眠检测状态，以及各状态的日记篇数和日期（不显示内容）
- `interlude.journal.run`：验收用，把“现在”当作入睡，立即生成一轮（只回报结果状态）
- `interlude.journal.forget <YYYY-MM-DD>`：删除那一天的日记、梦和存档文件

## 前提

HDS 需要配置可用的压缩（侧端）模型；未配置时请把 `source` 改为 `custom`。

## 后台生成（0.4.3）

- 日记、记忆压缩、梦境每完成一个阶段就写入数据库；中途重启会从断点继续，不重新写已完成的部分（尝试次数照常累计）。
- 多个待处理的睡眠周期逐个排队，不同时向模型发多份请求。
- 每个阶段开始前，若 HDS 正在处理前台回合，最多让位 60 秒再继续；忙碌不算失败。

## 与其他 HDS 扩展共存

插件会挂在 HDS 原生叙述器的最内层，atri-bilibili、atri-bili-eyes、atri-album 等包装叙述器的扩展会在外层照常工作；Atri 自己想到日记、同一回合重写时只重调原生叙述器，不会让外层扩展重复执行。atri-bilibili 这类用 `Object.create` 包装的扩展无论排在前后都能识别。若加载时叙述器已被 Proxy 包装，会自动退回外层挂载并在日志里提示，此时建议在插件配置里把本插件排在 `hds-interlude` 之后。

## 安装（离线包）

HDS rc57 是本地 vendor 包，安装时请加 `--legacy-peer-deps`，避免 npm 去公共源解析 peer 依赖：

```bash
npm install ./vendor/koishi-plugin-atri-journal-dreams-0.4.3-beta.1.tgz --legacy-peer-deps
```
