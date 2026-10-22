'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const p = require('..'), h = p._test
const c = p.Config({})
test('package exports and HDS service declarations', () => {
  assert.equal(typeof p.apply, 'function')
  assert.deepEqual(p.inject.required, ['database','interlude'])
})
test('public defaults contain no endpoint, key, model or story ID', () => {
  for (const key of ['endpoint','apiKey','model','storyId']) assert.equal(c[key], '', key)
  assert.equal(c.source, 'hds'); assert.equal(c.allowInGroups, false)
})
test('sleep signal prefers rhythm over fallback', () => {
  assert.equal(h.sleepSignal({lifeRhythm:{attention:'awake'},lifeStatus:{status:'asleep'}}).asleep, false)
  assert.equal(h.sleepSignal({lifeStatus:{status:'asleep'}}).asleep, true)
  assert.equal(h.sleepSignal({}).asleep, false)
})
test('night window spans midnight', () => {
  assert.equal(h.inWindow(new Date('2026-01-03T15:00:00Z'), 'Asia/Shanghai', '21:00-05:00'), true)
  assert.equal(h.inWindow(new Date('2026-01-03T04:00:00Z'), 'Asia/Shanghai', '21:00-05:00'), false)
})
test('diary day boundary assigns pre-dawn sleep to previous day', () => {
  assert.equal(h.diaryDateKey(new Date('2026-01-03T18:00:00Z'), 'Asia/Shanghai', 5), '2026-01-03')
})
test('sleep confirmation waits before producing one cycle intent', () => {
  const now=new Date('2026-01-03T15:10:00Z'), at=new Date('2026-01-03T15:00:00Z')
  assert.equal(h.observeSleep({}, {asleep:true,at}, now, c, null, 'Asia/Shanghai').events.length, 0)
  const later=new Date('2026-01-03T15:30:00Z')
  assert.equal(h.observeSleep({}, {asleep:true,at}, later, c, null, 'Asia/Shanghai').events[0].type,'confirm')
})
test('model JSON parser strips think and fences', () => {
  assert.deepEqual(h.parseModelJson('<think>synthetic reasoning</think>```json\n{"ok":true}\n```'),{ok:true})
  assert.throws(()=>h.parseModelJson('not JSON'))
})
test('blocks retain only allowed subjects and source entries', () => {
  const blocks=h.normalizeBlocks([{text:'测试剧情', about:['p','unknown'], sources:[1,99],privacy:'private'}],{participantIds:new Set(['p']),sourceIds:new Set([1]),maxChars:100})
  assert.deepEqual(blocks[0].about,['p']);assert.deepEqual(blocks[0].sources,[1]);assert.equal(blocks[0].private,true)
})
test('facts clamp weights and filter unknown source references', () => {
  const [f]=h.normalizeFacts([{content:'测试事实', importance:2, confidence:-1, sourceEntryIds:[1,99],about:['p','other'],privacy:'private'}],{participantIds:new Set(['p']),sourceIds:new Set([1])})
  assert.equal(f.importance,1);assert.equal(f.confidence,0);assert.deepEqual(f.sourceEntryIds,[1]);assert.deepEqual(f.about,['p']);assert.equal(f.private,true)
})
test('episode tags must be grounded substrings', () => {
  assert.deepEqual(h.normalizeTags({places:['咖啡店','未知地点'],topics:['测试']},'在咖啡店聊测试'),{places:['咖啡店'],topics:['测试']})
})
test('relative dates and shifts resolve deterministically', () => {
  assert.ok(h.parseDateRefs('昨天的日记', '2026-01-03').includes('2026-01-02'))
  assert.equal(h.shiftKey('2026-01-01',-1),'2025-12-31')
})
test('overlap detects copied content but not empty text', () => {
  assert.equal(h.overlapRatio('今天在咖啡店看了一本书','今天在咖啡店看了一本书'),1)
  assert.equal(h.overlapRatio('','其他'),0)
})
