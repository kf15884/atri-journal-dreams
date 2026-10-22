'use strict'

const { Schema } = require('koishi')
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const zlib = require('node:zlib')

exports.name = 'atri-journal-dreams'
exports.inject = { required: ['database', 'interlude'] }
exports.usage = [
  'HDS-Interlude 扩展：Atri 每次按剧情入睡时写一篇只有她自己知道的日记，按日期归档；每轮睡眠只抽一次签决定是否留下梦。',
  '人设完全取自 HDS 当前故事（canon + 演化状态 + 各关系分支），写作与记忆压缩都走 HDS 的压缩/侧端模型路由。',
  '日记另存一份 HDS 格式的记忆压缩（facts + episodeTags）。只有对方提到日记，或 Atri 在剧情里自己想到日记时才检索；其余回合不检索、不发送。',
  '回忆沿用 HDS 的两层格式：7 天内读原文（recalledHistory），7 天后只剩压缩记忆（memories），30 天后归档，只剩模糊印象。',
].join('\n')

const DEFAULT_KINDS = [
  'script', 'thinking', 'user-message', 'character-message', 'world-event',
  'group-message', 'character-group-message', 'qzone-post', 'web-observation', 'character-platform-action',
]
const DREAM_FLAVORS = ['日常场景轻微变形', '荒诞但温和', '怀旧', '安静的风景', '在找某样东西', '和熟人无关的陌生地方', '声音或光线特别清楚', '时间和地点不停跳换']

exports.Config = Schema.intersect([
  Schema.object({
    storyId: Schema.string().default('').description('只处理指定的 HDS 故事 ID；留空处理所有运行中的故事。'),
    checkIntervalMinutes: Schema.natural().min(1).max(60).default(2).description('检查 HDS 生活节奏的间隔（分钟）。'),
    nightWindow: Schema.string().default('21:00-05:00').description('夜间入睡时段（故事时区）。在此段入睡可较快确认为主要睡眠。'),
    nightConfirmMinutes: Schema.natural().min(1).max(240).default(20).description('夜间入睡后连续 asleep 多久确认为主要睡眠。'),
    mainSleepHours: Schema.number().min(1).max(12).default(3).description('非夜间入睡需持续多久才算主要睡眠（排除午睡）。'),
    wakeToleranceMinutes: Schema.natural().min(5).max(240).default(90).description('夜里短暂醒来多久以内仍算同一觉。'),
    cycleCooldownHours: Schema.number().min(4).max(48).default(12).description('两轮主要睡眠的最短间隔。'),
    dayBoundaryHour: Schema.natural().min(0).max(12).default(5).description('日记归属日期的分界点：凌晨此时刻之前入睡，算前一天的日记。'),
    initialLookbackHours: Schema.number().min(4).max(48).default(18).description('首次启用时回看多少小时。'),
    maxWindowHours: Schema.number().min(8).max(72).default(36).description('一篇日记最多覆盖多少小时。'),
    minimumEntries: Schema.natural().min(1).max(50).default(3).description('清醒期有效剧情少于此数时不写日记（梦境抽签不受影响）。'),
  }).description('睡眠周期'),
  Schema.object({
    entryKinds: Schema.array(String).default(DEFAULT_KINDS).description('可作为日记素材的 HDS 剧本条目类型。'),
    materialBudget: Schema.natural().min(2000).max(60000).default(14000).description('每次提交给模型的剧情素材字符上限。'),
    factLimit: Schema.natural().min(0).max(40).default(12).description('参考的 HDS 长期事实条数（只读）。'),
    maxSections: Schema.natural().min(1).max(6).default(4).description('一篇日记最多几个小节。'),
    maxDiaryChars: Schema.natural().min(150).max(4000).default(900).description('日记正文目标上限（平淡的日子可以很短）。'),
    dreamProbability: Schema.number().min(0).max(1).step(0.01).default(0.3).description('每轮主要睡眠留下可回忆梦境的概率；入睡确认时即持久化，不会重抽。'),
    nightmareProbability: Schema.number().min(0).max(1).step(0.01).default(0).description('梦境为轻度不安梦的概率。'),
    maxDreamChars: Schema.natural().min(80).max(2000).default(450).description('梦境正文目标上限。'),
  }).description('写作'),
  Schema.object({
    fadeDays: Schema.natural().min(1).max(30).default(7).description('超过此天数，原文不再能被她读到，只剩压缩后的大概（记忆模糊）。'),
    archiveDays: Schema.natural().min(7).max(365).default(30).description('超过此天数，日记归档压缩（.md.gz），只剩模糊印象。'),
    archiveFiles: Schema.boolean().default(true).description('在 Koishi 数据目录下按 年/月/日期 保存 Markdown 存档（权限 600）。'),
  }).description('存档与压缩'),
  Schema.object({
    recallEnabled: Schema.boolean().default(true).description('启用日记印象与回忆。'),
    diaryTriggers: Schema.array(String).default(['日记', '日志', '写了什么', '记下来了吗', '记了什么']).description('对方专门提到日记时的词语。只有命中时才检索日记（配合日期或话题定位到某天，默认最近一篇）。'),
    selfRecallPattern: Schema.string().default('(?:翻|打开|拿出|看|查|找|读)[^。！？\\n]{0,6}日记|日记(?:本)?里(?:写|记)|想起[^。！？\\n]{0,8}日记|日记上').description('Atri 在剧本里自己想到/翻开日记的写法（正则）。命中后才检索日记。'),
    selfRecallRedecide: Schema.boolean().default(true).description('她自己想到日记时，在同一回合带着日记重新生成一次剧本（多一次主模型调用；有流式提前回复时自动改为下一回合）。'),
    selfRecallMinutes: Schema.natural().min(1).max(720).default(180).description('改为下一回合读取时，等待的有效时长。'),
    habitHint: Schema.boolean().default(true).description('在 HDS 日常推进（advance）回合附一句不含内容的提示：她有写日记的习惯、最近一篇是哪天。约 40 字，便于她在剧情中自己想到日记。'),
    archiveKeepImportance: Schema.number().min(0).max(1).step(0.05).default(0.5).description('归档（30 天后）时只保留重要度不低于此值的记忆。'),
    dreamTriggers: Schema.array(String).default(['梦', '睡得好', '睡得怎么样', '睡得还好']).description('触发梦境回忆的词语。'),
    dreamFadeHours: Schema.natural().min(6).max(168).default(36).description('醒来多少小时后梦境基本淡忘。'),
    searchDays: Schema.natural().min(7).max(400).default(120).description('按话题找日记时最多回溯多少天。'),
    allowInGroups: Schema.boolean().default(false).description('是否在群聊回合中也使用（默认否）。'),
  }).description('回忆'),
  Schema.object({
    source: Schema.union([
      Schema.const('hds').description('复用 HDS 压缩/侧端模型路由'),
      Schema.const('custom').description('单独的 OpenAI 兼容接口'),
    ]).default('hds'),
    model: Schema.string().default('').description('覆盖模型名；留空使用路由默认模型。'),
    endpoint: Schema.string().default('').description('custom：完整 chat/completions 地址。'),
    apiKey: Schema.string().role('secret').default('').description('custom：API Key。'),
    temperature: Schema.number().min(0).max(1.5).default(0.85).description('日记与梦境的温度；记忆压缩固定使用低温。'),
    maxTokens: Schema.natural().min(512).max(16000).default(3000),
    timeout: Schema.natural().min(10000).max(600000).default(180000).role('ms'),
    maxAttempts: Schema.natural().min(1).max(6).default(3).description('一轮最多尝试几次；失败只记录，不影响聊天。'),
  }).description('模型'),
  Schema.object({
    debug: Schema.boolean().default(false).description('调试日志（不含日记内容）。'),
  }).description('调试'),
])

// ---------- helpers ----------
const MIN = 60000
const HOUR = 3600000
const DAY = 24 * HOUR
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
const clip = (value, n) => {
  const text = String(value ?? '').replace(/\r/g, '').trim()
  return text.length > n ? `${text.slice(0, n)}…` : text
}
const toDate = (value) => {
  if (!value) return undefined
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d
}
const sha = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 24)
const decode = (value) => {
  if (value && typeof value === 'object') return value
  try { const parsed = JSON.parse(String(value || '{}')); return parsed && typeof parsed === 'object' ? parsed : {} } catch { return {} }
}
const safeName = (value) => String(value || '').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120) || 'story'

function sleepSignal(state) {
  const rhythm = state?.lifeRhythm
  if (rhythm && typeof rhythm.attention === 'string') return { asleep: rhythm.attention === 'asleep', at: toDate(rhythm.assessedAt) }
  const status = state?.lifeStatus
  if (status && typeof status.status === 'string') return { asleep: status.status === 'asleep', at: toDate(status.updatedAt) }
  return { asleep: false, at: undefined }
}

function localParts(date, timeZone) {
  let parts
  try {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date)
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date)
  }
  const get = (type) => parts.find(p => p.type === type)?.value
  return { y: get('year'), m: get('month'), d: get('day'), hh: get('hour'), mm: get('minute') }
}
const localMinutes = (date, tz) => { const p = localParts(date, tz); return Number(p.hh) * 60 + Number(p.mm) }
const localClock = (date, tz) => { const p = localParts(date, tz); return `${p.hh}:${p.mm}` }
const localDateKey = (date, tz) => { const p = localParts(date, tz); return `${p.y}-${p.m}-${p.d}` }
const localStamp = (date, tz) => { const p = localParts(date, tz); return `${p.m}/${p.d} ${p.hh}:${p.mm}` }
function shiftKey(key, days) {
  const d = new Date(`${key}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
const keyWeekday = (key) => new Date(`${key}T00:00:00Z`).getUTCDay()
const keyLabel = (key) => `${Number(key.slice(5, 7))}月${Number(key.slice(8, 10))}日`
const keyAgeDays = (key, todayKey) => Math.round((Date.parse(`${todayKey}T00:00:00Z`) - Date.parse(`${key}T00:00:00Z`)) / DAY)
/** 日记归属日期：凌晨分界点之前入睡算前一天。 */
const diaryDateKey = (sleepAt, tz, boundary) => localDateKey(new Date(sleepAt.getTime() - boundary * HOUR), tz)

function inWindow(date, timeZone, spec) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(String(spec || ''))
  if (!m) return false
  const from = Number(m[1]) * 60 + Number(m[2])
  const to = Number(m[3]) * 60 + Number(m[4])
  const now = localMinutes(date, timeZone)
  return from <= to ? now >= from && now < to : now >= from || now < to
}

function observeSleep(runtime, signal, now, cfg, lastCycle, timeZone) {
  const next = { ...(runtime || {}) }
  const events = []
  let session = next.session ? { ...next.session } : null
  const t = now.getTime()
  const tolerance = cfg.wakeToleranceMinutes * MIN
  if (signal.asleep) {
    const start = signal.at && signal.at.getTime() <= t && t - signal.at.getTime() < 12 * HOUR ? signal.at : now
    if (session && session.endAt && t - Date.parse(session.endAt) > tolerance) session = null
    if (!session) session = { startAt: start.toISOString(), lastAsleepAt: now.toISOString() }
    else { session.lastAsleepAt = now.toISOString(); delete session.endAt }
    if (!session.cycleId && !session.ignored) {
      const startAt = new Date(session.startAt)
      const lastSleep = toDate(lastCycle?.sleepAt)
      if (lastSleep && startAt.getTime() - lastSleep.getTime() < cfg.cycleCooldownHours * HOUR) session.ignored = true
      else {
        const need = inWindow(startAt, timeZone, cfg.nightWindow) ? cfg.nightConfirmMinutes * MIN : cfg.mainSleepHours * HOUR
        if (t - startAt.getTime() >= need) events.push({ type: 'confirm', sleepAt: startAt })
      }
    }
  } else if (session) {
    if (!session.endAt) {
      const end = signal.at && signal.at.getTime() >= Date.parse(session.startAt) && signal.at.getTime() <= t ? signal.at : now
      session.endAt = end.toISOString()
    }
    if (t - Date.parse(session.endAt) > tolerance) {
      if (session.cycleId) events.push({ type: 'wake', cycleId: session.cycleId, wakeAt: new Date(session.endAt) })
      session = null
    }
  }
  next.session = session
  next.observedAt = now.toISOString()
  return { runtime: next, events }
}

function parseModelJson(text) {
  let raw = String(text ?? '').replace(/^\uFEFF/, '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim()
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('invalid JSON: no object')
  const parsed = JSON.parse(raw.slice(start, end + 1))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid JSON: not an object')
  return parsed
}

/** 统一的“带归属与依据”的文本块：{ text, heading?, about[], sources[] } */
function normalizeBlocks(raw, { participantIds, sourceIds, maxChars, maxItems = 8, textLimit = 1200, sourceKey = 'sources' }) {
  const out = []
  let used = 0
  for (const item of Array.isArray(raw) ? raw : []) {
    if (out.length >= maxItems || used >= maxChars * 1.4) break
    const text = clip(typeof item === 'string' ? item : item?.text, textLimit)
    if (!text) continue
    const block = {
      text,
      about: Array.isArray(item?.about) ? [...new Set(item.about.map(String).filter(id => participantIds.has(id)))] : [],
      sources: Array.isArray(item?.[sourceKey]) ? [...new Set(item[sourceKey].map(Number).filter(id => sourceIds.has(id)))] : [],
    }
    const heading = clip(item?.heading, 16)
    if (heading) block.heading = heading
    if (item?.privacy === 'private' || item?.private === true) block.private = true
    out.push(block)
    used += text.length
  }
  return out
}

/** HDS 压缩格式的记忆条目（与 HDS facts 字段一致，另加 about / privacy）。 */
const SCOPES = ['character', 'world', 'relationship', 'event', 'promise']
const MODES = ['observed', 'reported', 'belief', 'proposal', 'conditional', 'confirmed']
const unit = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : d }
function normalizeFacts(raw, { participantIds, sourceIds, maxItems = 6, textLimit = 80 }) {
  const out = []
  for (const item of Array.isArray(raw) ? raw : []) {
    if (out.length >= maxItems) break
    const content = clip(item?.content ?? item?.text, textLimit)
    if (!content) continue
    const sourceEntryIds = [...new Set((Array.isArray(item?.sourceEntryIds) ? item.sourceEntryIds : Array.isArray(item?.sources) ? item.sources : []).map(Number).filter(id => sourceIds.has(id)))]
    const fact = {
      scope: SCOPES.includes(item?.scope) ? item.scope : 'event',
      content,
      importance: unit(item?.importance, 0.5),
      confidence: unit(item?.confidence, 0.8),
      unresolved: item?.unresolved === true,
      about: Array.isArray(item?.about) ? [...new Set(item.about.map(String).filter(id => participantIds.has(id)))] : [],
      sourceEntryIds,
      knowledge: { mode: MODES.includes(item?.knowledge?.mode) ? item.knowledge.mode : 'observed', ...item?.knowledge?.topic ? { topic: clip(item.knowledge.topic, 30) } : {} },
    }
    if (item?.privacy === 'private' || item?.private === true) fact.private = true
    out.push(fact)
  }
  return out
}
const TAG_KEYS = ['people', 'places', 'objects', 'topics', 'commitments', 'outcomes', 'dates']
function normalizeTags(raw, text) {
  const out = {}
  for (const key of TAG_KEYS) {
    const values = Array.isArray(raw?.[key]) ? raw[key] : []
    const grounded = [...new Set(values.filter(v => typeof v === 'string' && v.trim().length >= 2 && v.length <= 30 && text.includes(v.trim())).map(v => v.trim()))].slice(0, 8)
    if (grounded.length) out[key] = grounded
  }
  return out
}

function grams(s) {
  const t = String(s || '').replace(/[\s，。！？、；：“”‘’（）《》,.!?;:'"()]+/g, '')
  const set = new Set()
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2))
  return set
}
function overlapRatio(draft, reference) {
  const a = grams(draft)
  if (a.size < 4) return 0
  const b = grams(reference)
  let hit = 0
  for (const g of a) if (b.has(g)) hit++
  return hit / a.size
}
function sharedGrams(a, b) {
  const x = grams(a); const y = grams(b)
  let hit = 0
  for (const g of x) if (y.has(g)) hit++
  return hit
}

const CN = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
function cnNumber(s) {
  if (/^\d+$/.test(s)) return Number(s)
  if (s === '十') return 10
  const m = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(s)
  if (m) return (m[1] ? CN[m[1]] : 1) * 10 + (m[2] ? CN[m[2]] : 0)
  return s.length === 1 && s in CN ? CN[s] : NaN
}
const WD = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }
/** 从一句话里解析她或对方指向的过去日期（故事时区的日期键）。 */
function parseDateRefs(text, todayKey) {
  const s = String(text || '')
  const keys = new Set()
  const add = (k) => { if (k && k <= todayKey) keys.add(k) }
  if (/大前天/.test(s)) add(shiftKey(todayKey, -3))
  else if (/前天/.test(s)) add(shiftKey(todayKey, -2))
  if (/昨[天晚日]|昨儿/.test(s)) add(shiftKey(todayKey, -1))
  for (const m of s.matchAll(/([0-9一二两三四五六七八九十]{1,3})\s*天(?:以)?前/g)) { const n = cnNumber(m[1]); if (n > 0 && n < 400) add(shiftKey(todayKey, -n)) }
  for (const m of s.matchAll(/(上+)(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/g)) {
    const weeks = m[1].length
    const today = keyWeekday(todayKey)
    const mondayThisWeek = shiftKey(todayKey, -((today + 6) % 7))
    add(shiftKey(mondayThisWeek, -7 * weeks + ((WD[m[2]] + 6) % 7)))
  }
  for (const m of s.matchAll(/(?<!上)(?<!上个)(?:周|星期|礼拜)([一二三四五六日天])/g)) {
    const back = (keyWeekday(todayKey) - WD[m[1]] + 7) % 7 || 7
    add(shiftKey(todayKey, -back))
  }
  for (const m of s.matchAll(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/g)) add(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`)
  for (const m of s.matchAll(/(?<![\d年/-])([0-9一二两三四五六七八九十]{1,3})月([0-9一二两三四五六七八九十]{1,3})[日号]/g)) {
    const mo = cnNumber(m[1]); const d = cnNumber(m[2])
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      let y = Number(todayKey.slice(0, 4))
      let k = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      if (k > todayKey) k = `${y - 1}${k.slice(4)}`
      add(k)
    }
  }
  return [...keys].sort().reverse()
}

// ---------- prompts ----------
const PERSONA_RULE = '人设权威：setting 是初始 canon；evolvingState.settingOverlay 是当前累积变化，二者不同时以 overlay 为准；setting.perspective / perspectives 是她看待世界的方式；participants 是各关系分支（relationship 与 relationshipOverlay 只描述与该人的关系）。完全按这些资料写，不得自行补充或改写人设。'
function diarySystem(cfg) {
  return [
    '你要以 HDS 故事主角本人的身份，写她这一天睡前的私人日记。资料中的 hds 字段是 HDS 当前故事的人设与状态。',
    PERSONA_RULE,
    '写作要求：',
    '1. 第一人称“我”，不用“你”称呼自己，也不写给任何读者——这本日记只有她自己知道。提到别人时用对方的名字。',
    '2. 只写素材里确实发生过的事。没发出的回复、计划和猜测不能写成已发生，可以写“我本来想……”。',
    `3. 分成 1–${cfg.maxSections} 个小节，每节一个简短小标题（2–10 字，像她自己会写的那样），按时间或心情的转折分节；平淡的日子一节、几句话即可。不要流水账，写感受、在意的地方、没说出口的话。`,
    '4. 感官细节（光线、声音、温度、气味、身体的疲惫等）只能来自素材里已有的描写或明确的环境信息，不编造天气、对方的动作或她没看到的东西。',
    '5. 语气、用词、习惯完全依据人设和 setting.style；不要文艺堆砌，不要每天都感动或顿悟。',
    '6. 每节 about 列出主要涉及的参与者 ID（只涉及她自己或世界时留空），sources 列出依据的素材编号。不同人的事分开写在不同小节。',
    '6b. 每节 privacy：按她的人设判断，这一节是她愿意在聊天里提起的（shareable），还是只想自己知道、不会说出口的（private，例如没说出口的心事、对某人的私下看法、难为情的事）。',
    '7. lingering 写 0–2 件还惦记、没结束的小事（只是惦记，不是计划），同样带 about 与 sources。',
    `正文总长不超过 ${cfg.maxDiaryChars} 字。`,
    '只输出 JSON：{"title":"这一天的标题","mood":"一两个词","sections":[{"heading":"小标题","text":"…","privacy":"shareable|private","about":[],"sources":[123]}],"lingering":[{"text":"…","about":[],"sources":[123]}]}',
  ].join('\n')
}
function memorySystem() {
  return [
    '你是 HDS Interlude 的低成本连续性编辑（记忆压缩）。把主角的一篇私人日记压缩成 HDS 记忆格式，用于日后低成本回忆。',
    '只压缩日记里已经写下的内容，不加入日记里没有的信息，不推测未来。',
    'summary：一句话的当天概要（≤40 字，类似 HDS 的 scene.summary），只写与她自己有关、不涉及他人隐私的部分。',
    'facts：最多 6 条，字段与 HDS durable facts 一致：scope 取 character|world|relationship|event|promise；content 是自包含的一句话（≤60 字），涉及某人时直接写出名字，不用“他/她/对方”；importance 与 confidence 为 0–1；unresolved 只在还惦记、尚未了结时为 true；sourceEntryIds 原样继承所依据小节的 sources。',
    '另外每条 facts 带 about（原样继承所依据小节的 about，不得合并不同人的事）和 privacy（继承所依据小节的 privacy）。',
    'knowledge：{"mode":"observed|reported|belief|proposal|conditional|confirmed","topic":"短主题"}。她的猜测或感受是 belief，别人告诉她的是 reported，想做的事是 proposal，不是承诺。',
    'episodeTags：{"people":[],"places":[],"objects":[],"topics":[],"commitments":[],"outcomes":[],"dates":[]}，每类最多几个，必须是日记原文里的短子串，省略空类。它们只是日后找回这一天的导航标签。',
    '保持她的第一人称视角与用词，但删去修辞与感官铺陈。',
    '只输出 JSON：{"summary":"…","facts":[{"scope":"event","content":"…","importance":0.5,"confidence":0.9,"unresolved":false,"privacy":"shareable","about":[],"sourceEntryIds":[123],"knowledge":{"mode":"observed","topic":"…"}}],"episodeTags":{"people":[],"topics":[]}}',
  ].join('\n')
}
function dreamSystem(cfg, draw) {
  return [
    '你要以 HDS 故事主角本人的身份，写她刚醒来时还记得的梦。资料中的 hds 字段是她的人设与状态。',
    PERSONA_RULE,
    '规则：',
    '1. 第一人称“我”，不用“你”称呼自己。它是梦，不是现实：不得为真实的人增加承诺、秘密、行为或关系变化。',
    `2. 形式：${draw.fragment ? '只剩零碎片段——一个画面、一种声音或一种情绪，几句话即可' : '一个简短但有起伏的梦，细节可以模糊、跳跃'}。`,
    `3. 基调：${draw.uneasy ? '有些不安，但不要血腥恐怖' : '普通的梦，可以平静、温和或荒诞'}；倾向：${draw.flavor || '随意'}。`,
    `4. ${draw.withPeople ? '可以出现熟悉的人，但样子或场景会走形' : '这次梦里最好没有熟人出现，以陌生场景、物件或她自己为主'}。`,
    '5. 意象来自最近经历、长期事实和人设，经过变形重组；要有感官质感，但不解释含义。',
    '6. aftertaste 写醒后残留的一点感觉，不写成对现实的判断。',
    '7. 每段 about 列出出现的参与者 ID（没有则留空），inspiredBy 列出启发意象的素材编号。',
    `正文总长不超过 ${cfg.maxDreamChars} 字。`,
    '只输出 JSON：{"paragraphs":[{"text":"…","about":[],"inspiredBy":[123]}],"aftertaste":"…"}',
  ].join('\n')
}

// ---------- archive rendering ----------
function renderDay(dateKey, cycles, tz) {
  const lines = [`# ${keyLabel(dateKey)} ${WEEKDAYS[keyWeekday(dateKey)]}`, '']
  cycles.forEach((cycle, index) => {
    const diary = cycle.diary || {}
    const meta = [diary.mood && `心情：${diary.mood}`, `${localClock(new Date(cycle.sleepAt), tz)} 入睡`, cycle.wakeAt && `${localClock(new Date(cycle.wakeAt), tz)} 醒来`].filter(Boolean).join(' ｜ ')
    if (cycles.length > 1) lines.push(`## 第${index + 1}篇${diary.title ? ` · ${diary.title}` : ''}`, '')
    else if (diary.title) lines.push(`## ${diary.title}`, '')
    lines.push(`> ${meta}`, '')
    const level = cycles.length > 1 ? '####' : '###'
    if (diary.skipped) lines.push(`*（这一天没有写日记：${diary.reason}）*`, '')
    for (const section of diary.sections || []) {
      if (section.heading || section.private) lines.push(`${level} ${[section.heading, section.private && '（只有我知道）'].filter(Boolean).join('')}`, '')
      lines.push(section.text, '')
    }
    if (diary.lingering?.length) lines.push(`${level} 还惦记着`, '', ...diary.lingering.map(x => `- ${x.text}`), '')
    if (cycle.dreamDrawn && cycle.dream) {
      lines.push('---', '', `${level} 梦${cycle.dreamDraw?.fragment ? ' · 片段' : ''}`, '', ...cycle.dream.paragraphs.flatMap(p => [p.text, '']))
      if (cycle.dream.aftertaste) lines.push(`> 醒来后：${cycle.dream.aftertaste}`, '')
    } else if (!cycle.dreamDrawn) {
      lines.push('---', '', '*这一觉没有留下清晰的梦。*', '')
    }
  })
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

// ---------- plugin ----------
exports.apply = (ctx, config) => {
  const logger = ctx.logger('atri-journal-dreams')
  const debug = (...args) => { if (config.debug) logger.info(...args) }
  const service = ctx.interlude
  let HDS = {}
  try { HDS = require('koishi-plugin-hds-interlude') } catch { /* fallback below */ }
  const decodeState = (value) => (typeof HDS.decodeStoryState === 'function' ? HDS.decodeStoryState(decode(value)) : decode(value))
  const stateForPrompt = (state) => (typeof HDS.storyStateForPrompt === 'function' ? HDS.storyStateForPrompt(state) : { settingOverlay: state.settingOverlay })

  ctx.model.extend('atri_journal_cycle', {
    id: 'unsigned',
    storyId: 'string(255)',
    dateKey: 'string(10)',
    sleepAt: 'timestamp',
    wakeAt: 'timestamp',
    windowFrom: 'timestamp',
    windowTo: 'timestamp',
    status: 'string(31)',
    tier: 'string(15)',
    attempts: 'unsigned',
    nextAttemptAt: 'timestamp',
    dreamRoll: 'double',
    dreamDrawn: 'boolean',
    dreamDraw: 'json',
    diary: 'json',
    memory: 'json',
    dream: 'json',
    sourceHashes: 'json',
    archive: 'text',
    error: 'text',
    createdAt: 'timestamp',
    updatedAt: 'timestamp',
  }, { autoInc: true, indexes: ['storyId', 'dateKey', 'sleepAt', 'status'] })
  ctx.model.extend('atri_journal_runtime', {
    storyId: 'string(255)',
    runtime: 'json',
    updatedAt: 'timestamp',
  }, { primary: 'storyId' })

  const db = ctx.database
  const settingOf = (story) => (story?.setting && typeof story.setting === 'object' ? story.setting : decode(story?.setting))
  const timezoneOf = (story) => settingOf(story).timezone || 'Asia/Shanghai'
  const archiveRoot = path.join(ctx.baseDir || process.cwd(), 'data', 'atri-journal-dreams')

  const stories = () => db.get('interlude_story', config.storyId ? { id: config.storyId } : { status: 'active' })
  async function lastCycle(storyId) {
    return (await db.get('atri_journal_cycle', { storyId }, { sort: { sleepAt: 'desc' }, limit: 1 }))[0]
  }
  const loadRuntime = async (storyId) => (await db.get('atri_journal_runtime', { storyId }))[0]?.runtime || {}
  const saveRuntime = (storyId, runtime) => db.upsert('atri_journal_runtime', [{ storyId, runtime, updatedAt: new Date() }])

  async function createCycle(story, sleepAt, now) {
    const previous = await lastCycle(story.id)
    const fromRaw = toDate(previous?.wakeAt) || toDate(previous?.sleepAt) || new Date(sleepAt.getTime() - config.initialLookbackHours * HOUR)
    const windowFrom = new Date(Math.max(fromRaw.getTime(), sleepAt.getTime() - config.maxWindowHours * HOUR))
    const roll = crypto.randomInt(0, 1_000_000) / 1_000_000
    const pick = (n) => crypto.randomInt(0, n)
    const row = await db.create('atri_journal_cycle', {
      storyId: story.id, dateKey: diaryDateKey(sleepAt, timezoneOf(story), config.dayBoundaryHour),
      sleepAt, wakeAt: null, windowFrom, windowTo: sleepAt, status: 'pending', tier: 'fresh', attempts: 0, nextAttemptAt: now,
      dreamRoll: roll, dreamDrawn: roll < config.dreamProbability,
      dreamDraw: { fragment: pick(100) < 45, uneasy: crypto.randomInt(0, 1_000_000) / 1_000_000 < config.nightmareProbability, withPeople: pick(100) < 50, flavor: DREAM_FLAVORS[pick(DREAM_FLAVORS.length)] },
      diary: null, memory: null, dream: null, sourceHashes: {}, archive: '', error: '', createdAt: now, updatedAt: now,
    })
    logger.info('已确认主要睡眠 故事=%s 日期=%s 梦境抽签=%s', story.id, row.dateKey, row.dreamDrawn ? '保留梦境' : '无清晰梦境')
    return row
  }

  // ----- HDS persona + material -----
  async function material(story, from, to) {
    const [entries, participants, scenes, facts] = await Promise.all([
      db.get('interlude_script_entry', { storyId: story.id, occurredAt: { $gte: from, $lte: to } }, { sort: { occurredAt: 'asc' }, limit: 1500 }),
      db.get('interlude_participant', { storyId: story.id }),
      db.get('interlude_scene', { storyId: story.id }).catch(() => []),
      config.factLimit ? db.get('interlude_fact', { storyId: story.id, status: 'active' }, { sort: { importance: 'desc' }, limit: config.factLimit }).catch(() => []) : [],
    ])
    const tz = timezoneOf(story)
    const kinds = new Set(config.entryKinds)
    const names = new Map(participants.map(p => [p.id, p.displayName || p.userId || p.id]))
    const usable = entries.filter(e => kinds.has(e.kind) && e.kind !== 'redacted' && !e.metadata?.redacted && String(e.content || '').trim())
    const lines = usable.map(e => ({ id: e.id, text: `#${e.id} [${localStamp(new Date(e.occurredAt), tz)}] ${e.kind}${e.participantId ? `·${names.get(e.participantId) || e.participantId}` : ''}：${clip(e.content, 500)}` }))
    let chosen = lines
    const size = (list) => list.reduce((n, l) => n + l.text.length + 1, 0)
    if (size(lines) > config.materialBudget) {
      const tail = []
      let used = 0
      for (let i = lines.length - 1; i >= 0 && used + lines[i].text.length < config.materialBudget * 0.45; i--) { tail.unshift(lines[i]); used += lines[i].text.length + 1 }
      const head = lines.slice(0, lines.length - tail.length)
      const keep = Math.max(1, Math.floor((config.materialBudget - used) / (head.length ? size(head) / head.length : 1)))
      const step = head.length / keep
      const sampled = []
      for (let i = 0; i < keep && Math.floor(i * step) < head.length; i++) sampled.push(head[Math.floor(i * step)])
      chosen = [...sampled, ...tail]
    }
    const byId = new Map(usable.map(e => [e.id, e]))
    const setting = settingOf(story)
    // 与 HDS 后台压缩相同的投影：故事 canon（去掉单一用户/关系默认值）+ 演化状态 + 各关系分支。
    const hds = {
      setting: { ...setting, user: { displayName: 'Multiple participants', profile: '' }, relationship: '' },
      evolvingState: stateForPrompt(decodeState(story.state)),
      participants: participants.map(p => ({ id: p.id, displayName: p.displayName, profile: p.profile, relationship: p.relationship, relationshipOverlay: decode(p.state).relationshipOverlay })),
      durableFacts: facts.map(f => ({ scope: f.scope, content: f.content })),
      sceneSummaries: scenes.filter(s => s.summary && new Date(s.startedAt) <= to && (!s.endedAt || new Date(s.endedAt) >= from)).slice(-8).map(s => ({ startedAt: localStamp(new Date(s.startedAt), tz), summary: s.summary })),
    }
    return {
      count: usable.length,
      lines: chosen.map(l => l.text),
      sourceIds: new Set(chosen.map(l => l.id)),
      sourceHashes: Object.fromEntries(chosen.map(l => [l.id, sha(byId.get(l.id).content)])),
      participantIds: new Set(participants.map(p => p.id)),
      hds,
      characterName: setting.character?.name || '',
      window: `${localStamp(from, tz)} — ${localStamp(to, tz)}（${tz}）`,
    }
  }

  // ----- model -----
  async function callModel(task, system, user, temperature = config.temperature) {
    const parse = (text) => { if (!text) throw new Error(`${task} empty response`); return parseModelJson(text) }
    if (config.source === 'custom') {
      if (!config.endpoint || !config.model) throw new Error('custom 模式需要填写 endpoint 与 model')
      const response = await ctx.http.post(config.endpoint, {
        model: config.model, temperature, max_tokens: config.maxTokens, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }, { headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}, timeout: config.timeout })
      const message = response?.choices?.[0]?.message
      return parse(message?.content || message?.reasoning_content)
    }
    const c = service.compactor
    if (!c || typeof c.sideTaskJson !== 'function' || !c.routing?.compaction) throw new Error('HDS 压缩/侧端模型不可用（请在 HDS 中配置压缩模型，或改用 custom）')
    const route = c.routing.compaction
    const assigned = typeof c.assignedProviders === 'function' ? c.assignedProviders('compaction') : []
    const providers = assigned.length ? assigned : c.selectRouteProviders(route, false)
    const provider = (route.target?.providerId ? providers.find(p => p.id === route.target.providerId) : undefined) ?? providers[0]
    const model = config.model || (assigned.length ? provider?.model : route.target?.model || provider?.model)
    if (!provider || !model) throw new Error('HDS 没有可用的压缩/侧端模型连接')
    const jsonMode = c.config?.compaction?.responseFormat !== 'prompt-only'
    return c.sideTaskJson(provider, model, task, config.timeout, (capped) => ({
      ...decode(provider.extraBody), model, temperature, top_p: 1,
      ...capped ? { max_tokens: config.maxTokens } : {},
      ...jsonMode ? { response_format: { type: 'json_object' } } : {},
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }), parse)
  }

  /** 压缩失败到上限时的确定性兜底：不再额外花调用。 */
  function fallbackMemory(diary) {
    const sections = diary.sections || []
    const first = (t) => clip(String(t).split(/(?<=[。！？!?])/)[0], 40)
    return {
      summary: first(sections.find(s => !s.about.length && !s.private)?.text || diary.title || ''),
      facts: sections.slice(0, 6).map(s => ({ scope: 'event', content: first(s.text), importance: 0.5, confidence: 0.6, unresolved: false, about: s.about, sourceEntryIds: s.sources, knowledge: { mode: 'observed' }, ...s.private ? { private: true } : {} })),
      episodeTags: { topics: [diary.title, ...sections.map(s => s.heading)].filter(Boolean).slice(0, 8) },
      fallback: true,
    }
  }

  // ----- archive files -----
  const dayDir = (storyId, dateKey) => path.join(archiveRoot, safeName(storyId), dateKey.slice(0, 4), dateKey.slice(5, 7))
  async function writePrivate(file, data) {
    await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    await fsp.writeFile(tmp, data, { mode: 0o600 })
    await fsp.rename(tmp, file)
  }
  async function writeDayArchive(story, dateKey) {
    if (!config.archiveFiles) return
    const cycles = await db.get('atri_journal_cycle', { storyId: story.id, dateKey }, { sort: { sleepAt: 'asc' } })
    const ready = cycles.filter(c => c.diary && c.tier !== 'archived')
    if (!ready.length) return
    const dir = dayDir(story.id, dateKey)
    await writePrivate(path.join(dir, `${dateKey}.md`), renderDay(dateKey, ready, timezoneOf(story)))
    await writeMonthIndex(story, dateKey)
  }
  async function writeMonthIndex(story, dateKey) {
    const month = dateKey.slice(0, 7)
    const rows = await db.get('atri_journal_cycle', { storyId: story.id, dateKey: { $gte: `${month}-01`, $lte: `${month}-31` } }, { sort: { sleepAt: 'asc' } })
    const lines = [`# ${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月`, '', '| 日期 | 标题 | 心情 | 梦 | 状态 |', '|---|---|---|---|---|']
    for (const r of rows) {
      if (!r.diary) continue
      const tier = r.tier === 'archived' ? '已归档压缩' : r.tier === 'faded' ? '记忆模糊' : '清晰'
      lines.push(`| ${r.dateKey} ${WEEKDAYS[keyWeekday(r.dateKey)]} | ${r.diary.title || (r.diary.skipped ? '（未写）' : '')} | ${r.diary.mood || ''} | ${r.dreamDrawn ? '有' : '—'} | ${tier} |`)
    }
    await writePrivate(path.join(dayDir(story.id, dateKey), '目录.md'), lines.join('\n') + '\n')
  }

  // ----- generation -----
  const running = new Map()
  let stopped = false
  ctx.on('dispose', () => { stopped = true })
  /** 让位 HDS 正在处理的前台回合：最多等 60 秒，之后照常继续（后台任务不因忙碌判失败）。 */
  async function yieldForeground(storyId, maxMs = 60000) {
    const busy = () => typeof service.hasPendingNarrative === 'function' && service.hasPendingNarrative(storyId)
    const start = Date.now()
    let step = 500
    while (!stopped && busy() && Date.now() - start < maxMs) {
      await new Promise(resolve => { const t = setTimeout(resolve, step); t.unref?.() })
      step = Math.min(4000, step * 2)
    }
    if (stopped) throw new Error('插件已停用')
  }
  /** 每完成一个阶段就落库，重启后从断点继续，不重复生成已完成的部分。 */
  async function checkpoint(id, fields) {
    await db.set('atri_journal_cycle', { id }, { ...fields, updatedAt: new Date() })
  }
  // 后台周期逐个排队处理，不同时向模型发起多份日记/梦境请求。
  const queued = new Set()
  let queue = Promise.resolve()
  function enqueue(id) {
    if (queued.has(id) || running.has(id)) return
    queued.add(id)
    queue = queue.then(async () => {
      if (stopped) return
      const [row] = await db.get('atri_journal_cycle', { id })
      if (row && row.status === 'pending') await processCycle(row)
    }).catch(error => logger.warn('后台生成异常：%s', error?.message || error)).finally(() => queued.delete(id))
  }
  async function processCycle(cycle, force = false) {
    if (running.has(cycle.id)) return running.get(cycle.id)
    const job = (async () => {
      const now = new Date()
      if (!force && cycle.status !== 'pending') return cycle
      if (!force && cycle.nextAttemptAt && new Date(cycle.nextAttemptAt) > now) return cycle
      const [story] = await db.get('interlude_story', { id: cycle.storyId })
      if (!story) return cycle
      const mat = await material(story, new Date(cycle.windowFrom), new Date(cycle.windowTo))
      const context = JSON.stringify({ hds: mat.hds, characterName: mat.characterName, diaryDate: `${cycle.dateKey} ${WEEKDAYS[keyWeekday(cycle.dateKey)]}`, awakeWindow: mat.window })
      const patch = { attempts: (cycle.attempts || 0) + 1, updatedAt: now }
      const last = patch.attempts >= config.maxAttempts
      // 先记下尝试次数：生成中途重启也计入，避免同一周期无限重来。
      await checkpoint(cycle.id, { attempts: patch.attempts })
      let { diary, memory, dream } = cycle
      const errors = []
      try {
        if (!diary) {
          if (mat.count < config.minimumEntries) diary = { skipped: true, reason: `清醒期有效剧情仅 ${mat.count} 条` }
          else {
            await yieldForeground(cycle.storyId)
            const raw = await callModel('私人日记', diarySystem(config), `${context}\n\n剧情素材（按时间）：\n${mat.lines.join('\n')}`)
            const sections = normalizeBlocks(raw.sections || raw.paragraphs, { participantIds: mat.participantIds, sourceIds: mat.sourceIds, maxChars: config.maxDiaryChars, maxItems: config.maxSections })
            if (!sections.length) throw new Error('日记没有有效小节')
            diary = { title: clip(raw.title, 20), mood: clip(raw.mood, 16), sections, lingering: normalizeBlocks(raw.lingering, { participantIds: mat.participantIds, sourceIds: mat.sourceIds, maxChars: 240, maxItems: 2, textLimit: 120 }) }
          }
          patch.diary = diary
          patch.sourceHashes = { ...(cycle.sourceHashes || {}), ...mat.sourceHashes }
          await checkpoint(cycle.id, { diary: patch.diary, sourceHashes: patch.sourceHashes })
        }
      } catch (error) { errors.push(`日记：${error?.message || error}`) }
      try {
        if (diary && !diary.skipped && !memory) {
          const ids = new Set(diary.sections.flatMap(s => s.sources))
          try {
            const people = mat.hds.participants.map(p => ({ id: p.id, displayName: p.displayName }))
            await yieldForeground(cycle.storyId)
            const raw = await callModel('日记记忆压缩', memorySystem(), JSON.stringify({ participants: people, diary: { date: cycle.dateKey, title: diary.title, mood: diary.mood, sections: diary.sections, lingering: diary.lingering } }), 0.2)
            const facts = normalizeFacts(raw.facts, { participantIds: mat.participantIds, sourceIds: ids })
            if (!facts.length && !raw.summary) throw new Error('压缩结果为空')
            const fullText = [diary.title, ...diary.sections.flatMap(s => [s.heading, s.text]), ...diary.lingering.map(x => x.text)].join('\n')
            memory = { summary: clip(raw.summary, 60), facts, episodeTags: normalizeTags(raw.episodeTags, fullText) }
          } catch (error) {
            if (!last) throw error
            memory = fallbackMemory(diary)
          }
          patch.memory = memory
          await checkpoint(cycle.id, { memory })
        }
      } catch (error) { errors.push(`记忆压缩：${error?.message || error}`) }
      try {
        if (cycle.dreamDrawn && !dream) {
          const residue = diary && !diary.skipped ? `\n睡前的日记（梦的余温，可变形取用）：\n${diary.sections.map(s => s.text).join('\n')}` : ''
          await yieldForeground(cycle.storyId)
          const raw = await callModel('梦境', dreamSystem(config, cycle.dreamDraw || {}), `${context}${residue}\n\n最近的经历（意象来源）：\n${mat.lines.slice(-60).join('\n')}`)
          const paragraphs = normalizeBlocks(raw.paragraphs, { participantIds: mat.participantIds, sourceIds: mat.sourceIds, maxChars: config.maxDreamChars, sourceKey: 'inspiredBy' })
          if (!paragraphs.length) throw new Error('梦境没有有效段落')
          dream = { paragraphs, aftertaste: clip(raw.aftertaste, 80) }
          patch.dream = dream
          patch.sourceHashes = { ...(cycle.sourceHashes || {}), ...(patch.sourceHashes || {}), ...mat.sourceHashes }
          await checkpoint(cycle.id, { dream, sourceHashes: patch.sourceHashes })
        }
      } catch (error) { errors.push(`梦境：${error?.message || error}`) }
      const complete = !!diary && (diary.skipped || !!memory) && (!cycle.dreamDrawn || !!dream)
      patch.error = errors.join('；')
      if (complete) patch.status = diary.skipped && !dream ? 'skipped' : 'done'
      else if (last) { patch.status = 'failed'; logger.warn('日记生成放弃 周期=%d 原因=%s', cycle.id, clip(patch.error, 300)) }
      else { patch.status = 'pending'; patch.nextAttemptAt = new Date(now.getTime() + 30 * MIN * patch.attempts); logger.warn('日记生成失败，稍后重试 周期=%d 原因=%s', cycle.id, clip(patch.error, 300)) }
      await db.set('atri_journal_cycle', { id: cycle.id }, patch)
      const result = { ...cycle, ...patch }
      if (result.diary) await writeDayArchive(story, cycle.dateKey).catch(error => logger.warn('写入日记存档失败：%s', error?.message || error))
      if (complete) logger.info('私人日记已归档 日期=%s 日记=%s 梦境=%s', cycle.dateKey, diary.skipped ? '跳过' : '有', dream ? '有' : '无')
      return result
    })().finally(() => running.delete(cycle.id))
    running.set(cycle.id, job)
    return job
  }

  /** 7 天后原文不可读（模糊）；30 天后归档压缩，只剩模糊印象。 */
  async function maintain(story, now) {
    const todayKey = localDateKey(now, timezoneOf(story))
    const rows = await db.get('atri_journal_cycle', { storyId: story.id, tier: { $ne: 'archived' }, status: { $in: ['done', 'skipped'] } })
    const touched = new Set()
    for (const row of rows) {
      const age = keyAgeDays(row.dateKey, todayKey)
      if (age > config.archiveDays) {
        const full = JSON.stringify({ diary: row.diary, memory: row.memory, dream: row.dream })
        const archive = zlib.gzipSync(Buffer.from(full)).toString('base64')
        const memory = row.memory ? {
          summary: clip(row.memory.summary, 20),
          episodeTags: row.memory.episodeTags,
          facts: (row.memory.facts || []).filter(f => f.importance >= config.archiveKeepImportance).sort((x, y) => y.importance - x.importance).slice(0, 3).map(f => ({ ...f, content: clip(f.content, 20) })),
        } : null
        if (config.archiveFiles) {
          const dir = dayDir(story.id, row.dateKey)
          const file = path.join(dir, `${row.dateKey}.md`)
          try {
            const md = await fsp.readFile(file)
            await writePrivate(`${file}.gz`, zlib.gzipSync(md))
            await fsp.rm(file, { force: true })
          } catch (error) {
            if (error?.code !== 'ENOENT') logger.warn('归档压缩失败 %s：%s', row.dateKey, error?.message || error)
          }
        }
        await db.set('atri_journal_cycle', { id: row.id }, {
          tier: 'archived', archive, memory,
          diary: row.diary ? { title: row.diary.title, mood: row.diary.mood, skipped: row.diary.skipped, reason: row.diary.reason } : null,
          dream: null, updatedAt: now,
        })
        touched.add(row.dateKey)
      } else if (age > config.fadeDays && row.tier === 'fresh') {
        await db.set('atri_journal_cycle', { id: row.id }, { tier: 'faded', updatedAt: now })
        touched.add(row.dateKey)
      }
    }
    for (const key of touched) await writeMonthIndex(story, key).catch(() => {})
  }

  let ticking = false
  async function tick() {
    if (ticking) return
    ticking = true
    try {
      const now = new Date()
      for (const story of await stories()) {
        const runtime = await loadRuntime(story.id)
        const { runtime: next, events } = observeSleep(runtime, sleepSignal(decodeState(story.state)), now, config, await lastCycle(story.id), timezoneOf(story))
        for (const event of events) {
          if (event.type === 'confirm') next.session.cycleId = (await createCycle(story, event.sleepAt, now)).id
          else if (event.type === 'wake') {
            await db.set('atri_journal_cycle', { id: event.cycleId }, { wakeAt: event.wakeAt, updatedAt: now })
            const [row] = await db.get('atri_journal_cycle', { id: event.cycleId })
            if (row?.diary) await writeDayArchive(story, row.dateKey).catch(() => {})
          }
        }
        await saveRuntime(story.id, next)
        for (const cycle of await db.get('atri_journal_cycle', { storyId: story.id, status: 'pending' })) {
          if (cycle.nextAttemptAt && new Date(cycle.nextAttemptAt) > now) continue
          enqueue(cycle.id)
        }
        await maintain(story, now)
      }
    } catch (error) {
      logger.warn('睡眠检查失败：%s', error?.message || error)
    } finally {
      ticking = false
    }
  }

  // ----- recall -----
  // 规则：只有 ① 对方专门提到日记，② Atri 在剧本里自己想到日记 时才检索；其余回合不检索、不发送。
  // 格式沿用 HDS：7 天内的原文进 recalledHistory（historical-original-excerpt），之后的压缩记忆进 memories（derived-memory）。
  let selfRecall
  try { selfRecall = new RegExp(config.selfRecallPattern) } catch { selfRecall = /(?:翻|打开|看)[^。！？\n]{0,6}日记/ }
  const pendingSelfRecall = new Map()

  async function intactSources(cycle) {
    const hashes = cycle.sourceHashes || {}
    const ids = Object.keys(hashes).map(Number)
    const intact = new Set()
    if (!ids.length) return intact
    for (const row of await db.get('interlude_script_entry', { id: { $in: ids } })) {
      if (row.kind !== 'redacted' && !row.metadata?.redacted && sha(row.content) === hashes[row.id]) intact.add(row.id)
    }
    return intact
  }
  const srcOf = (b) => b.sources || b.sourceEntryIds || []
  const visible = (blocks, pid, shareAll, intact) => (blocks || []).filter(b => (!srcOf(b).length || srcOf(b).every(id => intact.has(id))) && (shareAll || (b.about || []).every(id => id === pid)))
  const has = (text, words) => (words || []).some(w => w && String(text || '').includes(w))
  const tagsOf = (row) => Object.values(row.memory?.episodeTags || {}).flat()

  /** 按 HDS episodeTags 导航 + 字面重合定位某天。 */
  function scoreTopic(text, row) {
    let score = tagsOf(row).filter(k => k.length >= 2 && text.includes(k)).length * 3
    score += Math.min(4, Math.floor(sharedGrams(text, [row.memory?.summary, ...(row.memory?.facts || []).map(f => f.content), row.diary?.title].join(' ')) / 2))
    return score
  }

  async function diaryRows(story, todayKey) {
    return db.get('atri_journal_cycle', {
      storyId: story.id, status: { $in: ['done', 'skipped'] }, dateKey: { $gte: shiftKey(todayKey, -config.searchDays) },
    }, { sort: { sleepAt: 'desc' }, limit: 200 })
  }

  const memoryRecord = (story, pid, now, index, category, content, importance = 0.7, sourceEntryId = null) =>
    ({ id: -(index + 1), storyId: story.id, participantId: pid, category, content, importance, status: 'active', sourceEntryId, createdAt: now, updatedAt: now })

  /**
   * @param cue 用于定位哪天的文字（对方消息，或她自己想到日记的剧本）。
   * @returns {{ memories: object[], history: object[], explicit: boolean }}
   */
  async function buildRecall(request, { selfCue } = {}) {
    const empty = { memories: [], history: [], explicit: false }
    if (!config.recallEnabled || !request?.story) return empty
    if (!request.participant && request.phase === 'user-message') return empty
    if (request.groupContext && !config.allowInGroups) return empty
    const story = request.story
    // 没有当前参与者的推进回合（与 HDS recallHistory 一致）：只看不属于任何人的内容。
    const pid = request.participant?.id ?? ''
    const now = request.now instanceof Date ? request.now : new Date()
    const tz = timezoneOf(story)
    const todayKey = localDateKey(now, tz)
    const message = request.phase === 'user-message' ? String(request.userMessage || '') : ''
    const key = `${story.id}:${pid}`
    const pending = pendingSelfRecall.get(key)
    const pendingCue = pending && pending.until > now.getTime() ? pending.cue : ''
    const userMentions = has(message, config.diaryTriggers)
    const wantsDream = has(message, config.dreamTriggers)
    const cue = selfCue || pendingCue
    const explicit = userMentions || !!cue
    const shareAll = !!request.shareParticipantDetails
    const memories = []
    const history = []
    if (!explicit && !wantsDream && !(config.habitHint && request.phase === 'advance')) return empty

    const rows = await diaryRows(story, todayKey)
    const written = rows.filter(r => r.diary && !r.diary.skipped)

    if (explicit) {
      if (pendingCue) pendingSelfRecall.delete(key)
      const cueText = [message, cue].filter(Boolean).join('\n')
      const dateRefs = parseDateRefs(cueText, todayKey)
      let targets = dateRefs.length ? written.filter(r => dateRefs.includes(r.dateKey)) : []
      if (!dateRefs.length) {
        const scored = written.map(r => ({ r, s: scoreTopic(cueText, r) })).filter(x => x.s >= 3).sort((a, b) => b.s - a.s)
        targets = scored.length ? scored.slice(0, 2).map(x => x.r) : written.slice(0, 1)
      }
      let produced = false
      for (const row of targets.slice(0, 2)) {
        const intact = await intactSources(row)
        const age = keyAgeDays(row.dateKey, todayKey)
        const head = `${keyLabel(row.dateKey)} ${WEEKDAYS[keyWeekday(row.dateKey)]}`
        if (row.tier === 'fresh' && age <= config.fadeDays) {
          const sections = visible(row.diary.sections, pid, shareAll, intact)
          if (!sections.length) continue
          const lingering = visible(row.diary.lingering, pid, shareAll, intact)
          const sources = [...new Set(sections.flatMap(srcOf))]
          history.push({
            id: sources[0] ?? -(history.length + 1),
            occurredAt: new Date(row.sleepAt).toISOString(),
            content: clip([
              `[我的私人日记 · ${head}${row.diary.title && sections.length === row.diary.sections.length ? ` · ${row.diary.title}` : ''}] 这本日记只有我自己知道。按我的人设决定提不提、提多少：标“可以说”的可以用自己的话自然说出；标“只有我知道”的只放在心里，不说出口、不暗示、不念原文，也不把日记给对方看。`,
              ...sections.map(sec => `${sec.private ? '（只有我知道）' : '（可以说）'}${sec.heading ? `「${sec.heading}」` : ''}${sec.text}`),
              lingering.length ? `（还惦记着）${lingering.map(x => `${x.private ? '［只有我知道］' : ''}${x.text}`).join('；')}` : '',
            ].filter(Boolean).join('\n'), 1800),
            sourceEntryIds: sources,
          })
          produced = true
        } else {
          const archived = row.tier === 'archived'
          const facts = visible(row.memory?.facts, pid, shareAll, intact)
          if (!facts.length) continue
          memories.push(memoryRecord(story, pid, now, memories.length, archived ? '很久以前的日记·模糊' : '日记记忆·模糊', clip([
            archived
              ? `【${head} 的日记太久了，想不太起来，只剩一点模糊印象】下面没有的细节一律说想不太起来，不要编。`
              : `【${head} 的日记过去一阵了，只记得大概】说的时候带着“好像”“大概”的不确定，不补充下面没有的细节。`,
            '标“只有我知道”的只放在心里，不说出口。',
            ...facts.map(f => `- ${f.private ? '（只有我知道）' : ''}${f.content}`),
          ].join('\n'), archived ? 400 : 700), archived ? 0.4 : 0.6, srcOf(facts[0])[0] ?? null))
          produced = true
        }
      }
      if (!produced) {
        memories.push(memoryRecord(story, pid, now, memories.length, '日记记忆·想不起来', dateRefs.length || targets.length
          ? '【想不太起来了】翻了日记也找不到那天 / 那件事的明确记录。不要编造细节，可以自然地说想不太起来了。'
          : '【日记】我还没有写下过能想起来的日记内容。不要编造，可以自然地说没写什么或想不起来。', 0.5))
      }
    } else if (config.habitHint && request.phase === 'advance' && written.length) {
      const last = written[0]
      memories.push(memoryRecord(story, pid, now, 0, '习惯', `我有睡前写日记的习惯（最近一篇是${keyLabel(last.dateKey)}）。只是习惯提示，不含内容；剧情需要时我可以自己翻开日记。`, 0.3))
    }

    if (wantsDream) {
      const recent = rows.find(c => c.wakeAt && now.getTime() - new Date(c.wakeAt).getTime() <= config.dreamFadeHours * HOUR)
      if (recent && recent.dreamDrawn && recent.dream) {
        const intact = await intactSources(recent)
        const paragraphs = (recent.dream.paragraphs || []).filter(p => srcOf(p).every(id => intact.has(id)) && (shareAll || p.about.every(id => id === pid)))
        const age = (now.getTime() - new Date(recent.wakeAt).getTime()) / HOUR
        if (paragraphs.length) memories.push(memoryRecord(story, pid, now, memories.length, '梦境回忆（不是现实）', clip([
          `【梦·${keyLabel(recent.dateKey)}那一觉】这是梦，不是真实发生的事，不能当作任何人的真实言行、承诺或关系依据。${age > 12 ? '已经过去一阵，只记得大概。' : '醒来不久，还有点印象。'}像普通人聊梦那样说，记不清的地方就说记不清。`,
          ...paragraphs.map(p => p.text),
          recent.dream.aftertaste ? `醒来后的感觉：${recent.dream.aftertaste}` : '',
        ].filter(Boolean).join('\n'), 1000), 0.6))
      } else if (recent && !recent.dreamDrawn) {
        memories.push(memoryRecord(story, pid, now, memories.length, '梦境回忆（不是现实）', '【梦】最近这一觉没有留下清楚的梦境记忆。不要编一个具体的梦，可以说没做梦或不记得了。', 0.5))
      }
    }
    return { memories, history, explicit }
  }

  const inject = (request, recall) => ({
    ...request,
    ...recall.memories.length ? { memories: [...recall.memories, ...(request.memories || [])] } : {},
    ...recall.history.length ? { recalledHistory: [...(request.recalledHistory || []), ...recall.history] } : {},
  })
  const injected = (recall) => recall.memories.length + recall.history.length > 0
  const scriptOf = (decision) => (typeof decision?.script === 'string' ? decision.script : '')

  // 叙述器挂载：尽量装在 HDS 原生叙述器上（最内层）。其他插件（bilibili / bili-eyes / album）
  // 无论先后加载，都包在我们外面；同回合重写只调用原生 decide，不会重复触发它们的副作用。
  const isProxy = require('node:util').types.isProxy
  let active = true
  const current = service.getNarrator()
  const innermost = !isProxy(current)
  // 其他插件若用 Object.create(原叙述器) 包装（如 atri-bilibili），沿原型链找到 HDS 原生实例再挂载。
  let host = current
  while (innermost && Object.prototype.hasOwnProperty.call(host, 'decide')) {
    const proto = Object.getPrototypeOf(host)
    if (!proto || proto === Object.prototype || isProxy(proto) || typeof proto.decide !== 'function' || proto.constructor?.prototype === proto) break
    host = proto
  }
  const hadOwn = innermost && Object.prototype.hasOwnProperty.call(host, 'decide')
  let originalDecide = host.decide
  const realDecide = originalDecide
  const nativeDecide = (request) => originalDecide.call(host, request)
  const layer = async (request) => {
    if (!active) return nativeDecide(request)
    let recall = { memories: [], history: [], explicit: false }
    try { recall = await buildRecall(request) } catch (error) { logger.warn('回忆准备失败，已跳过：%s', error?.message || error) }
    let decision = await nativeDecide(injected(recall) ? inject(request, recall) : request)
    try {
      const pid = request?.participant?.id ?? ''
      const script = scriptOf(decision)
      if (request?.story && script && !recall.explicit && selfRecall.test(script)) {
        // 她在剧情里自己想到了日记：同一回合带着日记重写；有流式提前回复时改为下一回合。
        const canRedo = config.selfRecallRedecide && !request.onEarlyReply
        if (canRedo) {
          const again = await buildRecall(request, { selfCue: script })
          if (injected(again)) {
            const note = memoryRecord(request.story, pid, request.now instanceof Date ? request.now : new Date(), 90, '刚想到日记', '【刚才我自己想到了日记，于是翻开看了】以此为契机继续当前剧情；日记内容按下面的标注决定说不说。', 0.6)
            const redo = await nativeDecide(inject(request, { ...again, memories: [note, ...again.memories] }))
            if (redo && scriptOf(redo)) { decision = redo; recall = again; debug('Atri 自己想到日记，已在同一回合重新生成 参与者=%s', pid) }
          }
        } else {
          pendingSelfRecall.set(`${request.story.id}:${pid}`, { until: Date.now() + config.selfRecallMinutes * MIN, cue: clip(script, 600) })
          debug('Atri 自己想到日记，下一回合读取 参与者=%s', pid)
        }
      }
      if (injected(recall) && decision && Array.isArray(decision.memories)) {
        const reference = [...recall.memories, ...recall.history].map(r => r.content).join('\n')
        decision.memories = decision.memories.filter(m => overlapRatio(m?.content, reference) < 0.5)
      }
    } catch (error) { logger.warn('回忆后处理失败：%s', error?.message || error) }
    if (injected(recall)) debug('本回合提供日记回忆 原文 %d 段，记忆 %d 条', recall.history.length, recall.memories.length)
    return decision
  }
  let wrapped = null
  if (innermost) {
    host.decide = layer
    debug('已挂在 HDS 原生叙述器内层')
  } else {
    // 叙述器已被其他插件包装：退回外层包装，并建议把本插件排在 hds-interlude 后面。
    logger.warn('HDS 叙述器已被其他插件包装，本插件改为外层挂载；建议在插件配置中把 atri-journal-dreams 排在 hds-interlude 之后、其他 Atri 扩展之前。')
    wrapped = new Proxy(current, {
      get(target, key) {
        if (key === 'decide') return layer
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    service.setNarrator(wrapped)
  }
  ctx.on('dispose', () => {
    active = false
    if (innermost) {
      if (host.decide === layer) { if (hadOwn) host.decide = realDecide; else delete host.decide }
    } else if (service.getNarrator() === wrapped) service.setNarrator(current)
  })
  const base = current

  // ----- commands (never reveal diary content) -----
  const guard = (session) => {
    const ok = typeof service.canManageSession === 'function' ? service.canManageSession(session) : (session?.user?.authority ?? 0) >= 4
    if (!ok) return '没有权限。'
  }
  ctx.command('interlude.journal', 'Atri 的睡眠日记（内容只有她自己知道）')
  ctx.command('interlude.journal.status', '查看睡眠检测与存档状态（不显示内容）').action(async ({ session }) => {
    const denied = guard(session); if (denied) return denied
    const out = []
    for (const story of await stories()) {
      const tz = timezoneOf(story)
      const runtime = await loadRuntime(story.id)
      const rows = await db.get('atri_journal_cycle', { storyId: story.id }, { sort: { sleepAt: 'desc' }, limit: 7 })
      const all = await db.get('atri_journal_cycle', { storyId: story.id })
      const count = (tier) => all.filter(r => r.tier === tier && r.diary && !r.diary.skipped).length
      out.push([
        `故事 ${story.id}：当前${sleepSignal(decodeState(story.state)).asleep ? '睡着' : '醒着'}`,
        runtime.session ? `本轮睡眠：${localStamp(new Date(runtime.session.startAt), tz)} 起${runtime.session.cycleId ? '，已确认' : runtime.session.ignored ? '，判定为小睡/夜醒' : '，等待确认'}` : '没有进行中的睡眠',
        `存档：清晰 ${count('fresh')} 篇 · 模糊 ${count('faded')} 篇 · 已归档压缩 ${count('archived')} 篇`,
        ...rows.map(r => `- ${r.dateKey} ${r.status}${r.diary?.skipped ? '（未写）' : ''}${r.dreamDrawn ? ' · 有梦' : ''}${r.memory?.fallback ? ' · 压缩兜底' : ''}`),
      ].join('\n'))
    }
    return out.join('\n\n') || '没有运行中的 HDS 故事。'
  })
  ctx.command('interlude.journal.run', '验收：把“现在”当作入睡，立即生成一轮（不显示内容）').action(async ({ session }) => {
    const denied = guard(session); if (denied) return denied
    const [story] = await stories()
    if (!story) return '没有运行中的 HDS 故事。'
    const now = new Date()
    const cycle = await createCycle(story, now, now)
    const runtime = await loadRuntime(story.id)
    await saveRuntime(story.id, { ...runtime, session: { startAt: now.toISOString(), lastAsleepAt: now.toISOString(), endAt: now.toISOString(), cycleId: cycle.id } })
    const result = await processCycle(cycle, true)
    return `${result.dateKey}：${result.status}${result.diary && !result.diary.skipped ? `，日记 ${result.diary.sections.length} 节` : ''}${result.dreamDrawn ? (result.dream ? '，有梦' : '，梦待生成') : '，无梦'}${result.error ? `（${clip(result.error, 120)}）` : ''}`
  })
  ctx.command('interlude.journal.forget <date:string>', '删除某一天（YYYY-MM-DD）的日记、梦和存档文件').action(async ({ session }, date) => {
    const denied = guard(session); if (denied) return denied
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return '请提供日期，例如 2026-10-21。'
    let removed = 0
    for (const story of await stories()) {
      removed += (await db.get('atri_journal_cycle', { storyId: story.id, dateKey: date })).length
      await db.remove('atri_journal_cycle', { storyId: story.id, dateKey: date })
      const dir = dayDir(story.id, date)
      await fsp.rm(path.join(dir, `${date}.md`), { force: true })
      await fsp.rm(path.join(dir, `${date}.md.gz`), { force: true })
      await writeMonthIndex(story, date).catch(() => {})
    }
    return removed ? `已删除 ${date} 的 ${removed} 篇记录。` : `${date} 没有记录。`
  })

  ctx.on('ready', () => {
    ctx.setTimeout(tick, 15000)
    ctx.setInterval(tick, config.checkIntervalMinutes * MIN)
  })

  exports._lastInstance = { tick, processCycle, enqueue, queueIdle: () => queue, buildRecall, maintain, writeDayArchive, wrapped, base, layer, innermost, setNativeDecide: (fn) => { originalDecide = fn }, archiveRoot, pendingSelfRecall }
}

exports._test = { observeSleep, sleepSignal, inWindow, parseModelJson, normalizeBlocks, normalizeFacts, normalizeTags, overlapRatio, parseDateRefs, diaryDateKey, renderDay, shiftKey }
