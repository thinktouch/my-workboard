import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createWorkboardServer } from '../server.mjs';
import { SqliteStore, normalizeTask, validateDocument } from '../lib/store.mjs';
const ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const blank=()=>({version:1,revision:0,updatedAt:new Date().toISOString(),tasks:[],trash:[]});
async function listen(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${server.address().port}`;}
async function stop(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
async function fixture(t){
  const dir=await mkdtemp(path.join(os.tmpdir(),'workboard-test-')),filename=path.join(dir,'data.sqlite');
  let instance=await createWorkboardServer({dataFile:filename}),base=await listen(instance.server);
  t.after(async()=>{await stop(instance.server);await rm(dir,{recursive:true,force:true});});
  return {dir,filename,get store(){return instance.store;},get base(){return base;},async restart(){await stop(instance.server);instance=await createWorkboardServer({dataFile:filename});base=await listen(instance.server);},async call(route,method='GET',value){const r=await fetch(base+route,{method,headers:method==='GET'?{}:{'Content-Type':'application/json'},body:method==='GET'?undefined:JSON.stringify(value??{})});return {status:r.status,data:await r.json()};}};
}
async function temporary(t){const dir=await mkdtemp(path.join(os.tmpdir(),'workboard-store-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}

test('并发新增不丢失，SQLite 表保存结构化任务，重启恢复',async t=>{
  const f=await fixture(t),results=await Promise.all(Array.from({length:24},(_,i)=>f.call('/api/tasks','POST',{text:`任务 ${i}`,quadrant:['q1','q2','q3','q4'][i%4]})));
  assert.ok(results.every(r=>r.status===201));
  const before=(await f.call('/api/data')).data;assert.equal(before.tasks.length,24);assert.equal(new Set(before.tasks.map(t=>t.id)).size,24);
  const id=before.tasks[0].id;await f.call(`/api/tasks/${id}`,'PATCH',{text:'重启后保留的内容',done:true,quadrant:'q2'});await f.restart();
  const {data}=await f.call('/api/data'),changed=data.tasks.find(t=>t.id===id);
  assert.equal(data.tasks.length,24);assert.equal(data.revision,25);assert.equal(changed.text,'重启后保留的内容');assert.equal(changed.done,true);assert.equal(changed.quadrant,'q2');assert.ok(changed.completedAt);
  assert.equal((await readFile(f.filename)).subarray(0,16).toString(),'SQLite format 3\0');
  const db=new DatabaseSync(f.filename,{readOnly:true});
  try{assert.equal(db.prepare('SELECT COUNT(*) count FROM tasks').get().count,24);assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status,'done');assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{db.close();}
});

test('删除及恢复持久保存，保留原内容、状态与时间',async t=>{
  const f=await fixture(t),created=await f.call('/api/tasks','POST',{text:'可恢复任务',quadrant:'q1'}),id=created.data.result.id;
  const progress=await f.call(`/api/tasks/${id}`,'PATCH',{inProgress:true});
  await f.call(`/api/tasks/${id}`,'DELETE',{});await f.restart();
  let result=await f.call('/api/data');assert.equal(result.data.tasks.length,0);assert.deepEqual(result.data.trash[0].task,progress.data.tasks[0]);
  result=await f.call(`/api/tasks/${id}/restore`,'POST',{});assert.equal(result.status,200);assert.deepEqual(result.data.tasks[0],progress.data.tasks[0]);assert.equal(result.data.trash.length,0);
});

test('永久删除只删除最近删除中的指定条目，无法删除正式任务，重启后不能恢复',async t=>{
  const f=await fixture(t),a=await f.call('/api/tasks','POST',{text:'保留的正式任务',quadrant:'q1'}),b=await f.call('/api/tasks','POST',{text:'永久删除测试',quadrant:'q2'}),c=await f.call('/api/tasks','POST',{text:'继续保留在最近删除',quadrant:'q3'});
  await f.call(`/api/tasks/${b.data.result.id}`,'DELETE',{});await f.call(`/api/tasks/${c.data.result.id}`,'DELETE',{});
  const result=await f.call(`/api/trash/${b.data.result.id}`,'DELETE',{});
  assert.equal(result.status,200);assert.equal(result.data.trash.length,1);assert.equal(result.data.trash[0].task.id,c.data.result.id);
  assert.equal(result.data.tasks[0].id,a.data.result.id);
  assert.equal((await f.call(`/api/trash/${a.data.result.id}`,'DELETE',{})).status,404);
  await f.restart();assert.equal((await f.call(`/api/tasks/${b.data.result.id}/restore`,'POST',{})).status,404);
  const db=new DatabaseSync(f.filename,{readOnly:true});try{assert.equal(db.prepare('SELECT COUNT(*) count FROM tasks WHERE id=?').get(b.data.result.id).count,0);}finally{db.close();}
});

test('清空仅移除所有最近删除项，正式任务和时间保持不变',async t=>{
  const f=await fixture(t),active=await f.call('/api/tasks','POST',{text:'正式任务',quadrant:'q1'}),before=active.data.tasks[0];
  for(let i=0;i<3;i++){const created=await f.call('/api/tasks','POST',{text:`待清空 ${i}`,quadrant:'q4'});await f.call(`/api/tasks/${created.data.result.id}`,'DELETE',{});}
  const result=await f.call('/api/trash','DELETE',{});assert.equal(result.status,200);assert.equal(result.data.result.purged,3);assert.equal(result.data.trash.length,0);assert.deepEqual(result.data.tasks,[before]);
  await f.restart();assert.deepEqual((await f.call('/api/data')).data.tasks,[before]);assert.equal((await f.call('/api/data')).data.trash.length,0);
  const invalid=await fetch(f.base+'/api/trash',{method:'DELETE',headers:{'Content-Type':'application/json',Origin:'https://example.com'},body:'{}'});assert.equal(invalid.status,403);
});

test('无效修改不改变数据库，任务文本用绑定参数保存，数据库不对外提供',async t=>{
  const f=await fixture(t),created=await f.call('/api/tasks','POST',{text:'保留',quadrant:'q3'}),id=created.data.result.id,before=(await f.call('/api/data')).data;
  assert.equal((await f.call(`/api/tasks/${id}`,'PATCH',{text:'  '})).status,400);assert.equal((await f.call(`/api/tasks/${id}`,'PATCH',{quadrant:'bad'})).status,400);
  assert.deepEqual((await f.call('/api/data')).data,before);
  const text="Robert'); DROP TABLE tasks; --";await f.call(`/api/tasks/${id}`,'PATCH',{text});assert.equal((await f.call('/api/data')).data.tasks[0].text,text);
  for(const route of ['/data.json','/data.sqlite','/data.sqlite-journal'])assert.equal((await f.call(route)).status,404);
  const forbidden=await fetch(f.base+'/api/tasks',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://example.com'},body:JSON.stringify({text:'跨站',quadrant:'q1'})});assert.equal(forbidden.status,403);
});

test('JSON 一次性迁移保留所有状态、时间、回收站与版本号，重启不重复迁移',async t=>{
  const dir=await temporary(t),legacyFile=path.join(dir,'data.json'),filename=path.join(dir,'data.sqlite');
  const legacy=validateDocument({...blank(),revision:17,tasks:[
    {id:'pending',text:'待办任务',quadrant:'q1',createdAt:'2026-10-01T01:02:03.000Z'},
    {id:'processing',text:'正在处理',quadrant:'q2',inProgress:true,createdAt:'2026-10-02T01:02:03.000Z'},
    {id:'done',text:'已完成',quadrant:'q3',done:true,createdAt:'2026-10-03T01:02:03.000Z',completedAt:'2026-10-04T01:02:03.000Z'}
  ],trash:[{task:{id:'removed',text:'已删除',quadrant:'q4',demo:true,createdAt:'2026-10-05T01:02:03.000Z'},index:2,deletedAt:'2026-10-06T01:02:03.000Z'}]});
  const source=JSON.stringify(legacy,null,2);await writeFile(legacyFile,source);
  const store=new SqliteStore(filename);await store.initialize();
  try{assert.deepEqual(await store.read(),legacy);await store.mutate(doc=>{doc.tasks[0].text='SQLite 中修改';});}finally{store.close();}
  assert.equal(await readFile(legacyFile,'utf8'),source);
  await writeFile(legacyFile,'旧 JSON 不再参与读取');
  const reopened=new SqliteStore(filename);await reopened.initialize();
  try{const result=await reopened.read();assert.equal(result.tasks[0].text,'SQLite 中修改');assert.equal(result.tasks.length,3);assert.equal(result.trash.length,1);assert.equal(result.revision,18);}finally{reopened.close();}
});

test('损坏的旧 JSON 阻止迁移，保留源文件，修复后可重新迁移',async t=>{
  const dir=await temporary(t),legacy=path.join(dir,'data.json'),filename=path.join(dir,'data.sqlite');await writeFile(legacy,'{ interrupted');
  await assert.rejects(new SqliteStore(filename).initialize(),/无法打开/);assert.equal(await readFile(legacy,'utf8'),'{ interrupted');
  const source=validateDocument({...blank(),tasks:[{id:'a',text:'修复后迁移',quadrant:'q1'}]});await writeFile(legacy,JSON.stringify(source));
  const store=new SqliteStore(filename);await store.initialize();try{assert.deepEqual(await store.read(),source);}finally{store.close();}
});

test('损坏的 SQLite 不会被旧 JSON 覆盖或静默清空',async t=>{
  const dir=await temporary(t),filename=path.join(dir,'data.sqlite');const broken=Buffer.from('not a sqlite database');await writeFile(filename,broken);await writeFile(path.join(dir,'data.json'),JSON.stringify(blank()));
  await assert.rejects(new SqliteStore(filename).initialize(),/无法打开/);assert.deepEqual(await readFile(filename),broken);
});

test('数据库约束失败时整个修改事务回滚，后续写入仍可继续',async t=>{
  const f=await fixture(t);await f.call('/api/tasks','POST',{text:'保留原文',quadrant:'q1'});const before=await f.store.read();
  await assert.rejects(f.store.mutate(doc=>{doc.tasks[0].text='不应留下部分修改';doc.tasks.push(normalizeTask({id:'\0invalid',text:'触发数据库约束',quadrant:'q2'}));}));
  assert.deepEqual(await f.store.read(),before);assert.equal((await f.call('/api/tasks','POST',{text:'回滚后继续',quadrant:'q3'})).status,201);
});

test('两个数据库连接的并发修改不会丢失彼此的数据',async t=>{
  const dir=await temporary(t),filename=path.join(dir,'data.sqlite'),a=new SqliteStore(filename),b=new SqliteStore(filename);await a.initialize();await b.initialize();
  try{await Promise.all(Array.from({length:20},(_,i)=>(i%2?a:b).mutate(doc=>{doc.tasks.push(normalizeTask({id:`task-${i}`,text:`任务 ${i}`,quadrant:'q1'}));})));const doc=await a.read();assert.equal(doc.tasks.length,20);assert.equal(doc.revision,20);}finally{a.close();b.close();}
});

test('关闭后复制单个 SQLite 文件到新目录可完整恢复并独立写入',async t=>{
  const dir=await temporary(t),filename=path.join(dir,'data.sqlite'),restored=path.join(dir,'restored','data.sqlite');const source=new SqliteStore(filename);await source.initialize();
  await source.mutate(doc=>{doc.tasks.push(normalizeTask({text:'跨目录还原',quadrant:'q4',inProgress:true}));});const expected=await source.read();source.close();
  await mkdir(path.dirname(restored));await copyFile(filename,restored);
  const store=new SqliteStore(restored);await store.initialize();try{assert.deepEqual(await store.read(),expected);await store.mutate(doc=>{doc.tasks.push(normalizeTask({text:'新目录写入',quadrant:'q1'}));});assert.equal((await store.read()).tasks.length,2);}finally{store.close();}
  const original=new SqliteStore(filename);await original.initialize();try{assert.deepEqual(await original.read(),expected);}finally{original.close();}
});

test('移除的备份下载及导入接口不可用，也没有残留入口或打包脚本',async t=>{
  const f=await fixture(t),before=await f.store.read();
  for(const [route,method] of [['/api/backup','GET'],['/api/import','POST'],['/api/upload','POST'],['/api/download','GET']])assert.equal((await f.call(route,method,{tasks:[{text:'不可导入',quadrant:'q1'}]})).status,404);
  assert.deepEqual(await f.store.read(),before);
  const pkg=JSON.parse(await readFile(path.join(ROOT,'package.json'),'utf8'));assert.equal(pkg.scripts.package,undefined);
  for(const name of ['lib/archive.mjs','scripts/package.mjs'])await assert.rejects(readFile(path.join(ROOT,name)),{code:'ENOENT'});
  for(const name of ['public/index.html','public/app.js'])assert.doesNotMatch(await readFile(path.join(ROOT,name),'utf8'),/\bdownload\b|type=["']file["']|\/api\/(?:backup|import|upload)/);
});

test('处理中状态持久化，编辑移动不改变状态，完成与待办互斥',async t=>{
  const f=await fixture(t),created=await f.call('/api/tasks','POST',{text:'状态测试',quadrant:'q1'}),id=created.data.result.id,createdAt=created.data.tasks[0].createdAt;
  let result=await f.call(`/api/tasks/${id}`,'PATCH',{inProgress:true});assert.equal(result.data.tasks[0].inProgress,true);assert.equal(result.data.tasks[0].done,false);assert.equal(result.data.tasks[0].completedAt,null);
  await f.call(`/api/tasks/${id}`,'PATCH',{text:'处理中编辑',quadrant:'q3'});await f.restart();result=await f.call('/api/data');assert.equal(result.data.tasks[0].inProgress,true);assert.equal(result.data.tasks[0].createdAt,createdAt);
  result=await f.call(`/api/tasks/${id}`,'PATCH',{done:true});assert.equal(result.data.tasks[0].inProgress,false);assert.ok(result.data.tasks[0].completedAt);
  result=await f.call(`/api/tasks/${id}`,'PATCH',{done:false});assert.equal(result.data.tasks[0].inProgress,false);assert.equal(result.data.tasks[0].completedAt,null);
  await f.call(`/api/tasks/${id}`,'PATCH',{inProgress:true});result=await f.call(`/api/tasks/${id}`,'PATCH',{inProgress:false});assert.equal(result.data.tasks[0].inProgress,false);assert.equal(result.data.tasks[0].done,false);
  const before=await f.store.read();assert.equal((await f.call(`/api/tasks/${id}`,'PATCH',{inProgress:'yes'})).status,400);assert.equal((await f.call(`/api/tasks/${id}`,'PATCH',{inProgress:true,done:true})).status,400);assert.deepEqual(await f.store.read(),before);
});

test('创建与完成时间真实记录，编辑移动和重启不改变，重新完成记录新时间',async t=>{
  const f=await fixture(t),beforeCreation=Date.now();let result=await f.call('/api/tasks','POST',{text:'记录生命周期',quadrant:'q1'});const task=result.data.tasks[0],id=task.id,createdAt=task.createdAt;
  assert.ok(Date.parse(createdAt)>=beforeCreation&&Date.parse(createdAt)<=Date.now());assert.equal(task.completedAt,null);
  const beforeCompletion=Date.now();result=await f.call(`/api/tasks/${id}`,'PATCH',{done:true});const completedAt=result.data.tasks[0].completedAt;assert.ok(Date.parse(completedAt)>=beforeCompletion&&Date.parse(completedAt)<=Date.now());
  result=await f.call(`/api/tasks/${id}`,'PATCH',{text:'已编辑',quadrant:'q2'});assert.equal(result.data.tasks[0].createdAt,createdAt);assert.equal(result.data.tasks[0].completedAt,completedAt);
  await f.restart();result=await f.call('/api/data');assert.equal(result.data.tasks[0].createdAt,createdAt);assert.equal(result.data.tasks[0].completedAt,completedAt);
  result=await f.call(`/api/tasks/${id}`,'PATCH',{done:false});assert.equal(result.data.tasks[0].createdAt,createdAt);assert.equal(result.data.tasks[0].completedAt,null);
  const againAfter=Date.now();result=await f.call(`/api/tasks/${id}`,'PATCH',{done:true});assert.ok(Date.parse(result.data.tasks[0].completedAt)>=againAfter);
});
