import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const filename = root => path.join(root, '.workboard-service.json');
async function readState(root) {
  let source;
  try { source = await readFile(filename(root), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const state = JSON.parse(source);
  if (state.root !== root || !Number.isInteger(state.pid) || state.pid <= 0 || !Number.isInteger(state.port) || state.port < 1 || state.port > 65535 || !/^[a-f0-9]{64}$/.test(state.token)) throw Error('服务记录无效，未停止任何进程。');
  return state;
}
async function request(state, stop = false) {
  const response = await fetch(`http://127.0.0.1:${state.port}/_workboard/${stop ? 'stop' : 'status'}`, {
    method: stop ? 'POST' : 'GET',
    headers: { 'X-Workboard-Token': state.token, ...(stop ? { 'Content-Type': 'application/json' } : {}) },
    body: stop ? '{}' : undefined,
    signal: AbortSignal.timeout(3000)
  });
  if (!response.ok) throw Error('无法验证当前项目的服务身份，未停止任何进程。');
  const value = await response.json();
  if (value.application !== 'my-workboard' || value.root !== state.root || value.pid !== state.pid) throw Error('服务身份不匹配，未停止任何进程。');
  return value;
}
const refused = error => error.cause?.code === 'ECONNREFUSED';
async function removeOwnedState(root, token) {
  try { if ((await readState(root))?.token === token) await unlink(filename(root)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function startLocalService(createServer, root, port, options = {}) {
  root = path.resolve(root);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('PORT 必须为 1–65535。');
  const previous = await readState(root);
  if (previous) {
    try { await request(previous); return { alreadyRunning: true, port: previous.port }; }
    catch (error) { if (!refused(error)) throw error; }
  }
  const token = randomBytes(32).toString('hex');
  const { server, store } = await createServer({ ...options, control: { token, root } });
  const temporary = `${filename(root)}.${token}.tmp`;
  try {
    await new Promise((resolve, reject) => {
      const onError = error => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError); server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
    await writeFile(temporary, JSON.stringify({ root, port, pid: process.pid, token }) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, filename(root));
  } catch (error) {
    if (server.listening) await new Promise(resolve => server.close(resolve)); else store.close();
    try { await unlink(temporary); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') console.error(cleanupError.message); }
    throw error;
  }
  const shutdown = () => { if (server.listening) { server.close(); server.closeIdleConnections(); } };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  server.on('close', () => {
    process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown);
    removeOwnedState(root, token).catch(error => console.error(`服务记录清理失败：${error.message}`));
  });
  return { server, port, alreadyRunning: false };
}

export async function stopLocalService(root) {
  root = path.resolve(root);
  const state = await readState(root);
  if (!state) return false;
  try { await request(state); }
  catch (error) {
    if (!refused(error)) throw error;
    await removeOwnedState(root, state.token); return false;
  }
  await request(state, true);
  for (let attempt = 0; attempt < 50; attempt++) {
    const current = await readState(root);
    if (!current || current.token !== state.token) return true;
    await delay(100);
  }
  throw Error('工作台仍在等待当前请求完成，请稍后再次运行关闭脚本。');
}
