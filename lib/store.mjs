import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const QUADRANTS = new Set(['q1', 'q2', 'q3', 'q4']);
export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function normalizeTask(task) {
  if (!task || typeof task.text !== 'string' || !task.text.trim() || task.text.trim().length > 500 || !QUADRANTS.has(task.quadrant)) throw new AppError('任务内容需为 1–500 字，并选择有效象限');
  if (task.id != null && (typeof task.id !== 'string' || !task.id || task.id.length > 128)) throw new AppError('任务编号无效');
  const timestamp = new Date().toISOString();
  return {
    id: task.id || randomUUID(), text: task.text.trim(), quadrant: task.quadrant,
    done: Boolean(task.done), inProgress: !task.done && Boolean(task.inProgress),
    createdAt: Number.isFinite(Date.parse(task.createdAt)) ? task.createdAt : timestamp,
    completedAt: task.done ? (Number.isFinite(Date.parse(task.completedAt)) ? task.completedAt : timestamp) : null,
    demo: Boolean(task.demo)
  };
}
export function validateDocument(value) {
  if (!value || !Array.isArray(value.tasks) || value.tasks.length > 100000) throw new AppError('任务数据格式错误，需要 tasks 数组');
  const tasks = value.tasks.map(normalizeTask);
  const trash = (Array.isArray(value.trash) ? value.trash : []).map(entry => ({ task: normalizeTask(entry.task), index: Number.isSafeInteger(entry.index) ? Math.max(0, entry.index) : 0, deletedAt: entry.deletedAt || new Date().toISOString() }));
  const ids = [...tasks, ...trash.map(entry => entry.task)].map(task => task.id);
  if (new Set(ids).size !== ids.length) throw new AppError('任务编号重复');
  return { version: 1, revision: Number.isSafeInteger(value.revision) ? Math.max(0, value.revision) : 0, updatedAt: value.updatedAt || new Date().toISOString(), tasks, trash };
}

const schema = `
  CREATE TABLE app_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
    text TEXT NOT NULL CHECK (length(trim(text)) BETWEEN 1 AND 500),
    quadrant TEXT NOT NULL CHECK (quadrant IN ('q1', 'q2', 'q3', 'q4')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'done')),
    created_at TEXT NOT NULL,
    completed_at TEXT,
    demo INTEGER NOT NULL CHECK (demo IN (0, 1)),
    position INTEGER NOT NULL CHECK (position >= 0),
    deleted_at TEXT,
    original_position INTEGER,
    CHECK ((status = 'done' AND completed_at IS NOT NULL) OR (status != 'done' AND completed_at IS NULL)),
    CHECK ((deleted_at IS NULL AND original_position IS NULL) OR (deleted_at IS NOT NULL AND original_position IS NOT NULL AND original_position >= 0))
  ) STRICT;
  CREATE INDEX tasks_quadrant_created ON tasks(quadrant, created_at) WHERE deleted_at IS NULL;
  CREATE INDEX tasks_status ON tasks(status) WHERE deleted_at IS NULL;
  PRAGMA user_version = 1;
`;
const upsert = `INSERT INTO tasks (id, text, quadrant, status, created_at, completed_at, demo, position, deleted_at, original_position)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET text=excluded.text, quadrant=excluded.quadrant,
    status=excluded.status, created_at=excluded.created_at, completed_at=excluded.completed_at,
    demo=excluded.demo, position=excluded.position, deleted_at=excluded.deleted_at,
    original_position=excluded.original_position`;
function records(doc) {
  const record = (task, position, deletedAt = null, originalPosition = null) => [
    task.id, task.text, task.quadrant, task.done ? 'done' : task.inProgress ? 'processing' : 'pending',
    task.createdAt, task.completedAt, Number(task.demo), position, deletedAt, originalPosition
  ];
  return [...doc.tasks.map((task, i) => record(task, i)), ...doc.trash.map((entry, i) => record(entry.task, i, entry.deletedAt, entry.index))];
}

export class SqliteStore {
  constructor(filename, { legacyFile = path.join(path.dirname(filename), 'data.json') } = {}) {
    this.filename = filename;
    this.legacyFile = legacyFile;
    this.queue = Promise.resolve();
    this.db = null;
  }
  async initialize() {
    await mkdir(path.dirname(this.filename), { recursive: true });
    try {
      this.db = new DatabaseSync(this.filename);
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;');
      const check = this.db.prepare('PRAGMA quick_check').get();
      if (check.quick_check !== 'ok') throw Error('数据库完整性检查失败');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version !== 0 && version !== 1) throw Error('数据库版本不受支持，请使用匹配的工作台版本');
      const initialized = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_meta'").get();
      if (!initialized) {
        if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()) throw Error('文件不是工作台数据库');
        let legacy = { version: 1, revision: 0, updatedAt: new Date().toISOString(), tasks: [], trash: [] };
        if (this.legacyFile) {
          let source;
          try { source = await readFile(this.legacyFile, 'utf8'); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (source !== undefined) legacy = validateDocument(JSON.parse(source.replace(/^\uFEFF/, '')));
        }
        this.transaction(() => {
          // Recheck after reading the legacy file in case another instance initialized it.
          if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_meta'").get()) return;
          this.db.exec(schema);
          this.db.prepare('INSERT INTO app_meta VALUES (1, ?, ?)').run(legacy.revision, legacy.updatedAt);
          const insert = this.db.prepare(upsert);
          for (const record of records(legacy)) insert.run(...record);
          if (JSON.stringify(this.readDocument()) !== JSON.stringify(legacy)) throw Error('迁移校验失败，原始数据已保留');
        });
      }
      // Persistent data stays in one file; rollback journals exist only during writes.
      this.db.exec('PRAGMA journal_mode = DELETE;');
      return await this.read();
    } catch (error) {
      this.close();
      throw new AppError(`无法打开 data.sqlite，原始数据已保留：${error.message}`, 503);
    }
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  readDocument() {
    const meta = this.db.prepare('SELECT revision, updated_at FROM app_meta WHERE id=1').get();
    if (!meta) throw new AppError('数据库元信息缺失，原文件已保留', 503);
    const doc = { version: 1, revision: meta.revision, updatedAt: meta.updated_at, tasks: [], trash: [] };
    for (const row of this.db.prepare('SELECT * FROM tasks ORDER BY position, rowid').all()) {
      const task = { id: row.id, text: row.text, quadrant: row.quadrant, done: row.status === 'done', inProgress: row.status === 'processing', createdAt: row.created_at, completedAt: row.completed_at, demo: Boolean(row.demo) };
      if (row.deleted_at === null) doc.tasks.push(task);
      else doc.trash.push({ task, index: row.original_position, deletedAt: row.deleted_at });
    }
    return doc;
  }
  async read() {
    this.db.exec('BEGIN');
    try { const doc = this.readDocument(); this.db.exec('COMMIT'); return doc; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  mutate(action) {
    const operation = this.queue.then(() => this.transaction(() => {
      const doc = this.readDocument();
      const previous = new Map(records(doc).map(row => [row[0], JSON.stringify(row)]));
      const result = action(doc);
      if (result?.then) throw new AppError('数据库操作必须在同步事务内完成');
      doc.revision++; doc.updatedAt = new Date().toISOString();
      const normalized = validateDocument(doc);
      const insert = this.db.prepare(upsert);
      for (const row of records(normalized)) {
        if (previous.get(row[0]) !== JSON.stringify(row)) insert.run(...row);
        previous.delete(row[0]);
      }
      const remove = this.db.prepare('DELETE FROM tasks WHERE id=?');
      for (const id of previous.keys()) remove.run(id);
      this.db.prepare('UPDATE app_meta SET revision=?, updated_at=? WHERE id=1').run(normalized.revision, normalized.updatedAt);
      return { ...normalized, result };
    }));
    this.queue = operation.catch(() => {});
    return operation;
  }
  close() {
    if (this.db) { this.db.close(); this.db = null; }
  }
}
