# koishi-plugin-atri-journal-dreams

HDS-Interlude（rc57 起）扩展。Atri 每晚按剧情入睡时，会写一篇只有她自己知道的分节日记，按日期归档。日记的记忆会随时间变模糊。每一觉只抽一次签，决定醒来后是否还记得一个梦。

## Atri 子项目与 HDS 的关系

本项目是 **Atri 项目的子项目**，属于非官方扩展，不是独立聊天核心，也不属于 HDS 官方发行。

- [HDS-Interlude](https://github.com/ISEKAI-MomoiCore/HDS-Interlude) 是剧情、人设、关系、记忆和叙事发送链路的基础；各插件只在各自职责范围内接入，不打包或替代 HDS 核心。HDS 自身许可保持不变。
- [Atri Bili](https://github.com/kf15884/atri-bili-plugins)：只读视频资料、HDS 观看节奏和 QQ 卡片。
- [Atri Album](https://github.com/kf15884/atri-album)：剧情拍照、异步生成、看照片与相册回忆。
- [Atri Journal Dreams](https://github.com/kf15884/atri-journal-dreams)：按剧情主要睡眠生成私有日记与梦境。
- [旧 Atri Diary](https://github.com/kf15884/koishi-plugin-atri-diary) 是另一个包名与工作流；本次不覆盖它，也不自动迁移数据。

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

## 与其他 HDS 扩展共存

插件会挂在 HDS 原生叙述器的最内层，atri-bilibili、atri-bili-eyes、atri-album 等包装叙述器的扩展会在外层照常工作；Atri 自己想到日记、同一回合重写时只重调原生叙述器，不会让外层扩展重复执行。若加载时叙述器已被包装，会自动退回外层挂载并在日志里提示，此时建议在插件配置里把本插件排在 `hds-interlude` 之后。

## 安装（离线包）

如果你的HDS rc57使用本地vendor安装，安装时请加 `--legacy-peer-deps`，避免 npm 去公共源解析 peer 依赖：

```bash
npm install ./vendor/koishi-plugin-atri-journal-dreams-0.4.1-beta.1.tgz --legacy-peer-deps
```

## Beta 发布与填写提示

本仓库是Atri睡眠日记与梦境子项目的0.4.1-beta.1预发布，基于用户提供的0.4.1附件整理；并非旧包 `koishi-plugin-atri-diary` 的原地升级，不覆盖旧项目或自动迁移其数据。

- `storyId`：默认空，按插件规则处理所有活动故事；仅处理一个故事时请填写自己的故事ID。
- 默认 `source=hds`，复用HDS压缩/侧端模型路由，人设及剧情也来自HDS。
- `source=custom` 时：`endpoint` 填 `https://<请填写接口域名>/<请填写完整chat/completions路径>`；`apiKey` 填 `<请填写自己的API Key>`；`model` 填 `<请填写模型名>`。三个默认均空，提示文字不是可用配置。
- 需Koishi数据库与interlude服务、Node20+，HDS声明rc57起；本轮只对公开包做默认值、工具函数和语法测试，未完成rc57实机端到端验收。详细结果见VALIDATION.md。

## 隐私与模型边界

“只有Atri知道”是角色行为设计，不是加密或绝对保密保证。日记原文、记忆及梦境会进入自己配置的HDS侧端或custom模型；被回忆时也可能进入HDS主模型。请确认服务商的数据处理政策。模型可能误述或泄露提示上下文，其他插件、日志、服务器管理员或备份也可能读取内容。

数据库与Markdown文件为本地明文，gzip/base64不是加密；权限600不能防止拥有服务器权限的人读取。公开仓库不含你的真实日记、故事、关系、数据库、日志、账号或Key。运行状态与错误可能包含故事标识或远端信息，排障前另行脱敏。

本插件的管理员命令只报告状态/触发写作/删除，不提供聊天显示日记正文的命令。对话中自动回忆仍受模型表现、参与者归属及HDS设置影响，不能当作安全隔离边界。
