import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Message, MessagePage, RunEvent, Stored } from '../shared/contracts.ts';
import { AppError, invariant, stamp } from './errors.ts';

export class Store {
  db: DatabaseSync;
  home: string;
  private depth = 0;
  constructor(home: string) {
    this.home = path.resolve(home);
    invariant(
      !this.home.split(/[\\/]/).some((s) => s.toLowerCase() === '.hanako'),
      'LEGACY_HOME',
      '请选择独立的新数据目录',
    );
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    this.home = fs.realpathSync(this.home);
    invariant(
      !this.home.split(/[\\/]/).some((s) => s.toLowerCase() === '.hanako'),
      'LEGACY_HOME',
      '请选择独立的新数据目录',
    );
    this.db = new DatabaseSync(path.join(this.home, 'cagent.sqlite'), { timeout: 5000 });
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version > 2) {
      this.db.close();
      throw new AppError('NEWER_SCHEMA', '数据由较新版本创建，已停止写入', 409);
    }
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS records (
        kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)), PRIMARY KEY(kind,id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, position INTEGER NOT NULL,
        body TEXT NOT NULL CHECK(json_valid(body)), UNIQUE(session_id,position)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS message_session ON messages(session_id,position);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL,
        UNIQUE(run_id,sequence)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS event_session ON events(session_id,id);
      CREATE TABLE IF NOT EXISTS secrets (id TEXT PRIMARY KEY, codec TEXT NOT NULL, value BLOB NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS resource_blobs (id TEXT PRIMARY KEY, bytes BLOB NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL, target TEXT, outcome TEXT NOT NULL) STRICT;
      PRAGMA user_version=2;
      COMMIT;
    `);
  }
  transaction<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }
  get<T extends Stored>(kind: string, id: string): T | null {
    const row = this.db
      .prepare('SELECT body,revision,created_at,updated_at FROM records WHERE kind=? AND id=?')
      .get(kind, id) as
      { body: string; revision: number; created_at: string; updated_at: string } | undefined;
    return row
      ? {
          ...JSON.parse(row.body),
          id,
          revision: row.revision,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : null;
  }
  need<T extends Stored>(kind: string, id: string): T {
    const row = this.get<T>(kind, id);
    if (!row) throw new AppError('NOT_FOUND', '记录不存在', 404);
    return row;
  }
  list<T extends Stored>(kind: string): T[] {
    return (
      this.db
        .prepare('SELECT id FROM records WHERE kind=? ORDER BY updated_at DESC,id')
        .all(kind) as { id: string }[]
    ).map((r) => this.need<T>(kind, r.id));
  }
  put<T extends Stored>(
    kind: string,
    id: string,
    body: Omit<T, keyof Stored> | Record<string, unknown>,
    expected?: number,
  ): T {
    return this.transaction(() => {
      const previous = this.get<T>(kind, id);
      if (expected !== undefined && previous?.revision !== expected)
        throw new AppError('VERSION_CONFLICT', '内容已变化，请刷新后再保存', 409);
      const now = stamp(),
        revision = (previous?.revision ?? 0) + 1;
      const clean: Record<string, unknown> = { ...body };
      for (const field of ['id', 'revision', 'createdAt', 'updatedAt']) delete clean[field];
      this.db
        .prepare(
          `INSERT INTO records(kind,id,revision,created_at,updated_at,body) VALUES(?,?,?,?,?,?)
        ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,body=excluded.body`,
        )
        .run(kind, id, revision, previous?.createdAt ?? now, now, JSON.stringify(clean));
      return this.need<T>(kind, id);
    });
  }
  remove(kind: string, id: string) {
    this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id);
  }
  addMessage(input: Omit<Message, 'id' | 'position' | 'at'>, originalAt?: string): Message {
    return this.transaction(() => {
      const r = this.db
        .prepare('SELECT coalesce(max(position),0)+1 AS next FROM messages WHERE session_id=?')
        .get(input.sessionId) as { next: number };
      const message: Message = {
        ...input,
        id: randomUUID(),
        position: r.next,
        at: originalAt ?? stamp(),
      };
      this.db
        .prepare('INSERT INTO messages(id,session_id,position,body) VALUES(?,?,?,?)')
        .run(message.id, message.sessionId, message.position, JSON.stringify(message));
      return message;
    });
  }
  messages(sessionId: string, after = 0, limit = 1000): Message[] {
    return (
      this.db
        .prepare(
          'SELECT body FROM messages WHERE session_id=? AND position>? ORDER BY position LIMIT ?',
        )
        .all(sessionId, after, Math.min(limit, 10000)) as { body: string }[]
    ).map((x) => JSON.parse(x.body));
  }
  allMessages(sessionId: string): Message[] {
    return (
      this.db
        .prepare('SELECT body FROM messages WHERE session_id=? ORDER BY position')
        .all(sessionId) as { body: string }[]
    ).map((r) => {
      const m = JSON.parse(r.body);
      invariant(
        m && typeof m.text === 'string' && ['user', 'assistant', 'tool'].includes(m.role),
        'HISTORY_CORRUPT',
        '历史中存在损坏记录，请先检查导出或备份',
        409,
      );
      return m;
    });
  }
  runMessages(sessionId: string, runId: string): Message[] {
    return (
      this.db
        .prepare(
          "SELECT body FROM messages WHERE session_id=? AND json_extract(body,'$.runId')=? ORDER BY position",
        )
        .all(sessionId, runId) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  messagePage(sessionId: string, before = Number.MAX_SAFE_INTEGER, limit = 80): MessagePage {
    invariant(
      Number.isSafeInteger(before) &&
        before > 0 &&
        Number.isInteger(limit) &&
        limit >= 1 &&
        limit <= 200,
      'INVALID_PAGE',
      '分页参数无效',
    );
    const rows = this.db
      .prepare(
        'SELECT position,body FROM messages WHERE session_id=? AND position<? ORDER BY position DESC LIMIT ?',
      )
      .all(sessionId, before, limit + 1) as { position: number; body: string }[];
    const hasMore = rows.length > limit,
      page = rows.slice(0, limit).reverse(),
      messages: Message[] = [],
      corruptPositions: number[] = [];
    for (const r of page) {
      try {
        const m = JSON.parse(r.body);
        if (
          m.sessionId !== sessionId ||
          m.position !== r.position ||
          typeof m.text !== 'string' ||
          !['user', 'assistant', 'tool'].includes(m.role)
        )
          throw new Error();
        messages.push(m);
      } catch {
        corruptPositions.push(r.position);
      }
    }
    const { total } = this.db
      .prepare('SELECT count(*) AS total FROM messages WHERE session_id=?')
      .get(sessionId) as { total: number };
    return { messages, before: page[0]?.position ?? null, hasMore, total, corruptPositions };
  }
  event(runId: string, sessionId: string, kind: string, payload: unknown): RunEvent {
    return this.transaction(() => {
      const { next } = this.db
        .prepare('SELECT coalesce(max(sequence),0)+1 AS next FROM events WHERE run_id=?')
        .get(runId) as { next: number };
      const at = stamp();
      const r = this.db
        .prepare(
          'INSERT INTO events(run_id,session_id,sequence,kind,at,payload) VALUES(?,?,?,?,?,?)',
        )
        .run(runId, sessionId, next, kind, at, JSON.stringify(payload));
      return { id: Number(r.lastInsertRowid), runId, sessionId, sequence: next, kind, at, payload };
    });
  }
  events(sessionId: string, after = 0, limit = 2000): RunEvent[] {
    return (
      this.db
        .prepare('SELECT * FROM events WHERE session_id=? AND id>? ORDER BY id LIMIT ?')
        .all(sessionId, after, limit) as Record<string, unknown>[]
    ).map((r) => ({
      id: Number(r.id),
      runId: String(r.run_id),
      sessionId: String(r.session_id),
      sequence: Number(r.sequence),
      kind: String(r.kind),
      at: String(r.at),
      payload: JSON.parse(String(r.payload)),
    }));
  }
  audit(action: string, target: string | null, outcome: string) {
    this.db
      .prepare('INSERT INTO audit(at,action,target,outcome) VALUES(?,?,?,?)')
      .run(stamp(), action, target, outcome);
  }
  snapshot() {
    const records = this.db
      .prepare('SELECT kind,id,revision,created_at,updated_at,body FROM records ORDER BY kind,id')
      .all();
    const messages = this.db
      .prepare('SELECT id,session_id,position,body FROM messages ORDER BY session_id,position')
      .all();
    const data = { format: 'cagent-neutral', version: 1, records, messages };
    const sha256 = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    return { data, sha256, createdAt: stamp(), secretsIncluded: false };
  }
  close() {
    this.db.close();
  }
}
