import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SqliteStore, AppError, normalizeTask, QUADRANTS } from './lib/store.mjs';
import { startLocalService } from './lib/service.mjs';
const ROOT=path.dirname(fileURLToPath(import.meta.url));
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.woff2':'font/woff2'};
async function body(req) {
  if(!req.headers['content-type']?.startsWith('application/json'))throw new AppError('需要 JSON 请求',415);
  let size=0;const parts=[];
  for await(const part of req){size+=part.length;if(size>8*1024*1024)throw new AppError('数据超过 8MB',413);parts.push(part);}
  try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw new AppError('JSON 内容无法解析');}
}
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));}
export async function createWorkboardServer({dataFile=path.join(ROOT,'data.sqlite'),publicDir=path.join(ROOT,'public'),legacyFile,control}={}) {
  const store=new SqliteStore(dataFile,{legacyFile});await store.initialize();
  const server=http.createServer(async(req,res)=>{
    try{
      const hostname=new URL(`http://${req.headers.host||'localhost'}`).hostname;
      if(!['localhost','127.0.0.1','[::1]'].includes(hostname))throw new AppError('仅允许本机访问',403);
      const url=new URL(req.url,'http://localhost'),route=url.pathname;
      if(route.startsWith('/_workboard/')){
        if(!control||req.headers['x-workboard-token']!==control.token||req.headers.origin||req.headers['sec-fetch-site']==='cross-site')throw new AppError('服务控制请求不可用',403);
        const identity={application:'my-workboard',root:control.root,pid:process.pid};
        if(route==='/_workboard/status'&&req.method==='GET'){json(res,200,identity);return;}
        if(route==='/_workboard/stop'&&req.method==='POST'){
          await body(req);json(res,200,{...identity,stopping:true});
          setImmediate(()=>{server.close();server.closeIdleConnections();});return;
        }
        throw new AppError('服务控制接口不存在',404);
      }
      if(route.startsWith('/api/')){
        if(req.method!=='GET'){
          if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)throw new AppError('请从本地工作台页面操作',403);
          if(req.headers['sec-fetch-site']==='cross-site')throw new AppError('跨站请求不可用',403);
        }
        if(route==='/api/data'&&req.method==='GET'){json(res,200,await store.read());return;}
        if(route==='/api/trash'&&req.method==='DELETE'){
          await body(req);
          json(res,200,await store.mutate(doc=>{const purged=doc.trash.length;doc.trash=[];return {purged};}));return;
        }
        const trashItem=route.match(/^\/api\/trash\/([^/]+)$/);
        if(trashItem&&req.method==='DELETE'){
          await body(req);const id=decodeURIComponent(trashItem[1]);
          json(res,200,await store.mutate(doc=>{const index=doc.trash.findIndex(entry=>entry.task.id===id);if(index<0)throw new AppError('最近删除记录不存在，可能已恢复或删除',404);doc.trash.splice(index,1);return {id,purged:1};}));return;
        }

        if(route==='/api/tasks'&&req.method==='POST'){
          const input=await body(req);const task=normalizeTask({...input,id:undefined,done:false,inProgress:false,demo:false});
          json(res,201,await store.mutate(doc=>{doc.tasks.unshift(task);return {id:task.id};}));return;
        }
        const item=route.match(/^\/api\/tasks\/([^/]+)(\/restore)?$/);
        if(item){
          const id=decodeURIComponent(item[1]);
          if(item[2]&&req.method==='POST'){
            await body(req);json(res,200,await store.mutate(doc=>{const index=doc.trash.findIndex(e=>e.task.id===id);if(index<0)throw new AppError('回收记录不存在',404);if(doc.tasks.some(t=>t.id===id))throw new AppError('任务已恢复',409);const [entry]=doc.trash.splice(index,1);doc.tasks.splice(Math.min(entry.index,doc.tasks.length),0,entry.task);return {id};}));return;
          }
          if(!item[2]&&req.method==='PATCH'){
            const patch=await body(req);
            json(res,200,await store.mutate(doc=>{
              const index=doc.tasks.findIndex(t=>t.id===id);
              if(index<0)throw new AppError('任务不存在',404);
              const t=doc.tasks[index];
              if(patch.quadrant!==undefined&&!QUADRANTS.has(patch.quadrant))throw new AppError('象限无效');
              if(patch.done!==undefined&&typeof patch.done!=='boolean')throw new AppError('完成状态无效');
              if(patch.inProgress!==undefined&&typeof patch.inProgress!=='boolean')throw new AppError('处理状态无效');
              if(patch.inProgress===true&&patch.done===true)throw new AppError('任务不能同时处于处理中和已完成');
              const done=patch.done??(patch.inProgress===true?false:t.done);
              doc.tasks[index]=normalizeTask({
                ...t,...Object.fromEntries(Object.entries(patch).filter(([k])=>['text','quadrant'].includes(k))),
                done,inProgress:done?false:patch.inProgress??(patch.done===false?false:t.inProgress),
                completedAt:done?(t.done?t.completedAt:new Date().toISOString()):null,
                demo:patch.text!==undefined?false:t.demo
              });
              return {id};
            }));return;
          }
          if(!item[2]&&req.method==='DELETE'){
            await body(req);json(res,200,await store.mutate(doc=>{const index=doc.tasks.findIndex(t=>t.id===id);if(index<0)throw new AppError('任务不存在',404);const [task]=doc.tasks.splice(index,1);doc.trash.push({task,index,deletedAt:new Date().toISOString()});return {id};}));return;
          }
        }

        if(route==='/api/clear-demo'&&req.method==='POST'){
          await body(req);json(res,200,await store.mutate(doc=>{const ids=[];doc.tasks.forEach((task,index)=>{if(task.demo){ids.push(task.id);doc.trash.push({task,index,deletedAt:new Date().toISOString()});}});doc.tasks=doc.tasks.filter(t=>!t.demo);return {ids};}));return;
        }
        if(route==='/api/restore-batch'&&req.method==='POST'){
          const input=await body(req);if(!Array.isArray(input.ids))throw new AppError('需要任务编号');
          json(res,200,await store.mutate(doc=>{const ids=new Set(input.ids),entries=doc.trash.filter(e=>ids.has(e.task.id)).sort((a,b)=>a.index-b.index);for(const entry of entries)if(!doc.tasks.some(t=>t.id===entry.task.id))doc.tasks.splice(Math.min(entry.index,doc.tasks.length),0,entry.task);doc.trash=doc.trash.filter(e=>!ids.has(e.task.id));return {restored:entries.length};}));return;
        }
        throw new AppError('接口不存在',404);
      }
      if(!['GET','HEAD'].includes(req.method))throw new AppError('请求方法不可用',405);
      const relative=decodeURIComponent(route==='/'?'/index.html':route),filename=path.resolve(publicDir,'.'+relative);
      if(!filename.startsWith(path.resolve(publicDir)+path.sep))throw new AppError('文件不可访问',403);
      let data;try{data=await readFile(filename);}catch(error){if(error.code==='ENOENT'||error.code==='EISDIR')throw new AppError('文件不存在',404);throw error;}
      res.writeHead(200,{'Content-Type':MIME[path.extname(filename)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:data);
    }catch(error){if(!res.headersSent)json(res,error.status||500,{error:error.status?error.message:'本地保存失败，请检查 data.sqlite 所在目录的写入权限'});else res.destroy();}
  });
  server.on('close',()=>store.close());
  return {server,store};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const port=Number(process.env.PORT||5173);
  try{const result=await startLocalService(createWorkboardServer,ROOT,port);console.log(`${result.alreadyRunning?'工作台已在运行':'工作台'}：http://127.0.0.1:${result.port}\n数据文件：${path.join(ROOT,'data.sqlite')}\n运行关闭脚本或按 Ctrl+C 可停止服务。`);}catch(error){console.error(error.code==='EADDRINUSE'?`端口 ${port} 已占用；若是旧版本工作台，请先关闭原窗口再启动。`:error.message);process.exitCode=1;}
}
