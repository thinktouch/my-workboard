import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const code = await readFile(new URL('../public/task-motion.js', import.meta.url), 'utf8');

function fixture({ reduced = false, hidden = false, tall = false, failAnimation = false } = {}) {
  const animations = [], timers = new Map();
  let nextTimer = 0;
  class Element {
    constructor() { this.events = new Map(); this.style = {}; this.dataset = {}; this.children = []; this.inert = false; this.isConnected = true; const names = new Set(); this.classList = { add: name => names.add(name), remove: name => names.delete(name), contains: name => names.has(name) }; }
    addEventListener(type, handler) { if (!this.events.has(type)) this.events.set(type, new Set()); this.events.get(type).add(handler); }
    removeEventListener(type, handler) { this.events.get(type)?.delete(handler); }
    emit(type) { for (const handler of this.events.get(type) || []) handler(); }
    setAttribute() {} removeAttribute() {}
    append(child) { this.children.push(child); child.parent = this; }
    remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    cloneNode() { const clone = new Element(); clone.dataset = { ...this.dataset }; return clone; }
    closest() { return { dataset: { quadrant: 'q1' } }; }
    getBoundingClientRect() { return { left: 30, top: 180, width: 240, height: tall ? 600 : 38, bottom: tall ? 780 : 218 }; }
    animate(keyframes, options) {
      if (failAnimation && this.className === 'task-flight-card q1') throw Error('动画不可用');
      let resolve, reject;
      const animation = { node: this, keyframes, options, canceled: false, finished: new Promise((yes, no) => { resolve = yes; reject = no; }), finish: () => resolve(), cancel() { this.canceled = true; reject(Error('canceled')); } };
      animations.push(animation); return animation;
    }
  }
  const card = new Element(); card.dataset.id = 'new-task';
  const list = new Element(); list.scrollTop = 180; list.getBoundingClientRect = () => ({ top: 120, bottom: 400 });
  const media = new Element(); media.matches = reduced;
  const window = new Element(); window.matchMedia = () => media;
  const document = new Element(); document.hidden = hidden; document.body = new Element(); document.querySelectorAll = () => card.isConnected ? [card] : []; document.createElement = () => new Element();
  vm.runInNewContext(code, { window, document, console, setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id) });
  return { motion: window.workboardMotion, card, list, media, window, document, animations, timers, start: { left: 170, top: 14, width: 430, height: 28 } };
}
const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };

test('新任务从输入区移动到实际位置，结束后清理覆盖层并恢复交互', async () => {
  const f = fixture(); f.motion.flyIn('new-task', f.list, f.start);
  assert.equal(f.document.body.children.length, 1); assert.equal(f.card.inert, true); assert.equal(f.motion.isArriving('new-task'), true);
  assert.equal(f.animations.length, 2); assert.ok(f.animations[0].keyframes[0].transform.includes('200px')); assert.ok(f.animations[1].keyframes[0].transform.includes('-171px'));
  assert.ok(f.animations[0].options.duration >= 420 && f.animations[0].options.duration <= 680);
  f.animations[0].finish(); f.animations[1].finish(); await flush();
  assert.equal(f.document.body.children.length, 0); assert.equal(f.card.inert, false); assert.equal(f.card.classList.contains('is-arriving'), false); assert.equal(f.motion.isArriving('new-task'), false); assert.equal(f.timers.size, 0);
  assert.equal(f.animations.length, 3); assert.equal(f.animations[2].options.duration, 180);
});

test('减少动态效果、后台页面、过长任务及无目标时不生成飞行动画', () => {
  for (const options of [{ reduced: true }, { hidden: true }, { tall: true }]) { const f = fixture(options); f.motion.flyIn('new-task', f.list, f.start); assert.equal(f.animations.length, 0); assert.equal(f.card.inert, false); }
  const f = fixture(); f.motion.flyIn('missing', f.list, f.start); assert.equal(f.document.body.children.length, 0);
});

test('自动定位产生的滚动不打断动画，用户滚动会立即恢复正确任务位置', async () => {
  const f = fixture(); f.motion.flyIn('new-task', f.list, f.start); f.list.emit('scroll'); assert.equal(f.motion.isArriving('new-task'), true);
  f.list.scrollTop += 40; f.list.emit('scroll'); await flush();
  assert.equal(f.document.body.children.length, 0); assert.equal(f.card.inert, false); assert.equal(f.motion.isArriving('new-task'), false); assert.equal(f.animations.length, 2);
});

test('窗口调整、动态偏好变化和目标移除均不会留下隐藏任务', async () => {
  for (const action of ['resize', 'reduced', 'removed']) {
    const f = fixture(); f.motion.flyIn('new-task', f.list, f.start);
    if (action === 'resize') f.window.emit('resize');
    if (action === 'reduced') { f.media.matches = true; f.media.emit('change'); }
    if (action === 'removed') { f.card.isConnected = false; f.motion.synchronize(); }
    await flush(); assert.equal(f.document.body.children.length, 0); assert.equal(f.card.inert, false); assert.equal(f.motion.isArriving('new-task'), false); assert.equal(f.timers.size, 0);
  }
});

test('动画 API 失败时仍正常显示已创建的任务', async () => {
  const f = fixture({ failAnimation: true }); f.motion.flyIn('new-task', f.list, f.start); await flush();
  assert.equal(f.document.body.children.length, 0); assert.equal(f.card.classList.contains('is-arriving'), false); assert.equal(f.card.inert, false); assert.equal(f.motion.isArriving('new-task'), false);
});
