import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkboardServer } from '../server.mjs';
import { startLocalService, stopLocalService } from '../lib/service.mjs';
import { SqliteStore } from '../lib/store.mjs';

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workboard-service-'));
  const dataFile = path.join(root, 'data.sqlite');
  let service;
  t.after(async () => {
    if (service?.server.listening) await new Promise(resolve => service.server.close(resolve));
    await delay(40);
    await rm(root, { recursive: true, force: true });
  });
  return {
    root, dataFile, stateFile: path.join(root, '.workboard-service.json'),
    async start() { service = await startLocalService(createWorkboardServer, root, await freePort(), { dataFile }); return service; }
  };
}

test('记录当前项目身份，拒绝无凭据关闭，关闭后任务完整保留', async t => {
  const f = await fixture(t), service = await f.start(), base = `http://127.0.0.1:${service.port}`;
  const state = JSON.parse(await readFile(f.stateFile, 'utf8'));
  assert.equal(state.root, f.root); assert.equal(state.pid, process.pid); assert.match(state.token, /^[a-f0-9]{64}$/);
  assert.equal((await fetch(base + '/_workboard/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const created = await fetch(base + '/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '关闭后仍保存', quadrant: 'q1' }) });
  assert.equal(created.status, 201);
  assert.equal(await stopLocalService(f.root), true);
  assert.equal(service.server.listening, false);
  await assert.rejects(readFile(f.stateFile), { code: 'ENOENT' });
  const store = new SqliteStore(f.dataFile); await store.initialize();
  try { assert.equal((await store.read()).tasks[0].text, '关闭后仍保存'); } finally { store.close(); }
  assert.equal(await stopLocalService(f.root), false);
});

test('重复启动返回现有地址，自定义端口不影响关闭定位', async t => {
  const f = await fixture(t), first = await f.start();
  const second = await startLocalService(createWorkboardServer, f.root, await freePort(), { dataFile: f.dataFile });
  assert.equal(second.alreadyRunning, true); assert.equal(second.port, first.port);
  assert.equal(await stopLocalService(f.root), true);
});

test('服务凭据或 PID 不匹配时不停止进程', async t => {
  const f = await fixture(t), service = await f.start(), original = await readFile(f.stateFile, 'utf8'), state = JSON.parse(original);
  for (const invalid of [{ ...state, token: '0'.repeat(64) }, { ...state, pid: state.pid + 1 }]) {
    await writeFile(f.stateFile, JSON.stringify(invalid));
    await assert.rejects(stopLocalService(f.root), /身份/);
    assert.equal(service.server.listening, true);
  }
  await writeFile(f.stateFile, original);
  assert.equal(await stopLocalService(f.root), true);
});

test('过期服务记录可以清理，路径不匹配的记录保持原样', async t => {
  const f = await fixture(t), state = { root: f.root, pid: 12345, port: await freePort(), token: 'a'.repeat(64) };
  await writeFile(f.stateFile, JSON.stringify(state));
  assert.equal(await stopLocalService(f.root), false);
  await assert.rejects(readFile(f.stateFile), { code: 'ENOENT' });
  const invalid = JSON.stringify({ ...state, root: path.dirname(f.root) });
  await writeFile(f.stateFile, invalid);
  await assert.rejects(stopLocalService(f.root), /服务记录无效/);
  assert.equal(await readFile(f.stateFile, 'utf8'), invalid);
});

test('其他程序占用端口时不会覆盖服务记录或停止该程序', async t => {
  const f = await fixture(t), foreign = net.createServer();
  await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => foreign.close(resolve)));
  await assert.rejects(startLocalService(createWorkboardServer, f.root, foreign.address().port, { dataFile: f.dataFile }), { code: 'EADDRINUSE' });
  assert.equal(foreign.listening, true);
  await assert.rejects(readFile(f.stateFile), { code: 'ENOENT' });
});

test('系统启动关闭脚本支持含空格路径、其他工作目录和重复启动', async t => {
  const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const root = await mkdtemp(path.join(os.tmpdir(), 'workboard launcher '));
  const names = ['server.mjs', 'stop.mjs', 'lib', 'start.cmd', 'stop.cmd', '启动工作台.cmd', '关闭工作台.cmd', 'start.sh', 'stop.sh'];
  for (const name of names) await cp(path.join(source, name), path.join(root, name), { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = path.dirname(process.execPath) + path.delimiter + process.env.PATH;
  env.PORT = String(await freePort());
  function launch(stop = false) {
    const windows = process.platform === 'win32';
    const command = windows ? process.env.ComSpec || 'cmd.exe' : 'sh';
    const args = windows ? ['/d', '/c', `call "${path.join(root, stop ? '关闭工作台.cmd' : '启动工作台.cmd')}" --no-pause`] : [path.join(root, stop ? 'stop.sh' : 'start.sh')];
    const child = spawn(command, args, { cwd: os.tmpdir(), env, windowsHide: true, windowsVerbatimArguments: windows, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', value => output += value); child.stderr.on('data', value => output += value);
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve({ code, output })); });
    return { child, exited };
  }
  const running = launch();
  t.after(async () => {
    if (running.child.exitCode === null) {
      try { await stopLocalService(root); } catch { running.child.kill(); }
      await running.exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  let state;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { state = JSON.parse(await readFile(path.join(root, '.workboard-service.json'), 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (running.child.exitCode !== null) assert.fail((await running.exited).output);
    await delay(50);
  }
  assert.ok(state, '启动脚本没有生成服务记录');
  const duplicate = await launch().exited; assert.equal(duplicate.code, 0, duplicate.output);
  assert.equal(JSON.parse(await readFile(path.join(root, '.workboard-service.json'), 'utf8')).pid, state.pid);
  const created = await fetch(`http://127.0.0.1:${state.port}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '脚本关闭后保留', quadrant: 'q2' }) });
  assert.equal(created.status, 201);
  const stopped = await launch(true).exited; assert.equal(stopped.code, 0, stopped.output);
  const exited = await running.exited; assert.equal(exited.code, 0, exited.output);
  await assert.rejects(readFile(path.join(root, '.workboard-service.json')), { code: 'ENOENT' });
  const store = new SqliteStore(path.join(root, 'data.sqlite')); await store.initialize();
  try { assert.equal((await store.read()).tasks[0].text, '脚本关闭后保留'); } finally { store.close(); }
});
