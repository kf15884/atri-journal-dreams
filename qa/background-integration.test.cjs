'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {App}=require('koishi'),HTTP=require('@koishijs/plugin-http').default,SQLite=require('@koishijs/plugin-database-sqlite').default;
const HDS=require(process.env.ATRI_HDS_MODULE || '../../hds/lib/index.js'),J=require('..');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('background journal yields without charging attempts; resumes, checkpoints and preserves HDS', {timeout:10000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'atri-journal-queue-')),app=new App();app.baseDir=dir;app.plugin(HTTP,{});app.plugin(SQLite,{path:path.join(dir,'koishi.db')});
 app.plugin(HDS,HDS.Config({runtime:{autoAdvanceEnabled:false,allowProactiveMessages:false},model:{providers:[]},memory:{enabled:false},onebot:{enabled:false},logging:{logScriptPreview:false}}));app.plugin(J,J.Config({minimumEntries:1,factLimit:0}));
 t.after(async()=>{await app.stop();fs.rmSync(dir,{recursive:true,force:true})});await app.start();await sleep(80);
 const s=app.interlude,session={platform:'onebot',selfId:'BOT_ACCOUNT',userId:'OWNER_ACCOUNT',channelId:'private:OWNER_ACCOUNT',isDirect:true,username:'测试'};
 const story=await s.createStory(session),p=await s.ensureParticipant(story,session),now=new Date();
 const entry=await s.appendEntry(story.id,{kind:'script',actor:'narrator',content:'午后在窗边读书，想起今天的阳光。',occurredAt:now.toISOString()},now,p.id);
 const cycle=await app.database.create('atri_journal_cycle',{storyId:story.id,dateKey:'2026-10-22',sleepAt:now,windowFrom:new Date(now-3600000),windowTo:new Date(+now+1000),status:'pending',tier:'fresh',attempts:0,diary:null,memory:null,dream:null,dreamDrawn:false,dreamDraw:{},sourceHashes:{},createdAt:now,updatedAt:now});
 const originalStory=await app.database.get('interlude_story',{id:story.id}),originalScripts=await app.database.get('interlude_script_entry',{storyId:story.id});let busy=true,calls=0;
 s.hasPendingNarrative=()=>busy;s.pendingSplitSegments=async()=>[];
 s.compactor={routing:{compaction:{}},assignedProviders:()=>[{id:'fake',model:'TEST_MODEL'}],config:{compaction:{}},sideTaskJson:async(_p,_m,task,_timeout,_body,parse)=>{
   calls++;return parse(JSON.stringify(task==='私人日记'?{title:'窗边',mood:'平静',sections:[{heading:'阳光',text:'今天在窗边读书，阳光很暖。',about:[p.id],sources:[entry.id],privacy:'private'}]}:{summary:'读书的一天',facts:[{content:'今天在窗边读书',about:[p.id],sourceEntryIds:[entry.id],importance:0.5,privacy:'private'}],episodeTags:{topics:['读书']}}));
 }};
 const instance=J._lastInstance,job=instance.processCycle(cycle);await sleep(50);assert.equal(calls,0);assert.equal((await app.database.get('atri_journal_cycle',{id:cycle.id}))[0].attempts,0);
 busy=false;const result=await job;assert.equal(result.status,'done');assert.equal(calls,2);const saved=(await app.database.get('atri_journal_cycle',{id:cycle.id}))[0];assert.equal(saved.attempts,1);assert.ok(saved.diary.sections[0].private);
 await instance.processCycle(saved);assert.equal(calls,2,'finished checkpoints are not regenerated');
 assert.deepEqual(await app.database.get('interlude_story',{id:story.id}),originalStory);assert.deepEqual(await app.database.get('interlude_script_entry',{storyId:story.id}),originalScripts);
 const recall=await instance.buildRecall({story,participant:p,phase:'user-message',userMessage:'今天日记写了什么',now:new Date(now)});assert.ok(recall.history.some(x=>x.content.includes('只有我知道')));assert.ok([...recall.history,...recall.memories].reduce((n,x)=>n+x.content.length,0)<=3200);
});
