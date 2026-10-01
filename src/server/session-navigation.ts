import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Session, SessionOrder, Stored, SearchHit, SearchPage } from '../shared/contracts.ts';
import type { Store } from './store.ts';
import { AppError, invariant } from './errors.ts';

type Bucket = 'pinned' | 'active' | 'archived';
type OrderRecord = Stored & Omit<SessionOrder, 'revision'>;
const bucketOf = (session: Session): Bucket =>
  session.archived ? 'archived' : session.pinned ? 'pinned' : 'active';
const byTime = (a: Session, b: Session) =>
  b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);

export function getSessionOrder(store: Store): SessionOrder {
  const saved = store.get<OrderRecord>('session-order', 'global');
  const sessions = store.list<Session>('session').sort(byTime);
  const result: SessionOrder = {
    revision: saved?.revision ?? 0,
    pinned: [],
    active: [],
    archived: [],
  };
  for (const bucket of ['pinned', 'active', 'archived'] as const) {
    const members = sessions.filter((s) => bucketOf(s) === bucket).map((s) => s.id);
    const retained = [...new Set(saved?.[bucket] ?? [])].filter((id) => members.includes(id));
    result[bucket] = [...members.filter((id) => !retained.includes(id)), ...retained];
  }
  return result;
}

export function saveSessionOrder(store: Store, raw: unknown): SessionOrder {
  const input = z
    .object({
      bucket: z.enum(['pinned', 'active', 'archived']),
      ids: z.array(z.string().min(1).max(150)).max(100000),
      revision: z.number().int().min(0),
    })
    .parse(raw);
  return store.transaction(() => {
    const current = getSessionOrder(store);
    invariant(
      current.revision === input.revision,
      'VERSION_CONFLICT',
      '顺序已变化，请刷新后再排列',
      409,
    );
    const members = current[input.bucket];
    invariant(
      new Set(input.ids).size === input.ids.length &&
        input.ids.length === members.length &&
        input.ids.every((id) => members.includes(id)),
      'INVALID_ORDER',
      '顺序必须完整包含本组会话且不能重复',
    );
    store.put<OrderRecord>(
      'session-order',
      'global',
      { ...current, [input.bucket]: input.ids },
      current.revision || undefined,
    );
    return getSessionOrder(store);
  });
}

export function orderedSessions(store: Store, manual: boolean): Session[] {
  const order = getSessionOrder(store);
  const positions = new Map(
    [...order.pinned, ...order.active, ...order.archived].map((id, i) => [id, i]),
  );
  return store.list<Session>('session').sort((a, b) => {
    if (a.archived !== b.archived) return Number(a.archived) - Number(b.archived);
    const pins = a.archived ? 0 : Number(b.pinned) - Number(a.pinned);
    if (pins) return pins;
    if (manual || (!a.archived && a.pinned && b.pinned))
      return positions.get(a.id)! - positions.get(b.id)!;
    return byTime(a, b);
  });
}

const searchInput = z.object({
  q: z.string().trim().max(500).default(''),
  archived: z.enum(['true', 'false']).default('false'),
  sessionId: z.string().min(1).max(150).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(2048).optional(),
});
const cursorInput = z.object({
  fingerprint: z.string().length(64),
  sessionId: z.string().max(150),
  position: z.number().int().nonnegative(),
});
const scopeSQL = `SELECT id,body FROM records WHERE kind='session' AND
  ((?<>'' AND id=?) OR (?='' AND coalesce(json_extract(body,'$.archived'),0)=?))`;

function snippet(text: string, query: string) {
  const at = text.toLowerCase().indexOf(query),
    length = 180;
  let start = Math.max(0, at - 55);
  // Avoid splitting a UTF-16 surrogate pair at either edge of the excerpt.
  if (start && /[\uDC00-\uDFFF]/.test(text[start])) start--;
  let end = Math.min(text.length, Math.max(start + length, at + query.length));
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end++;
  const lead = start ? '…' : '';
  return {
    snippet: lead + text.slice(start, end) + (end < text.length ? '…' : ''),
    matchStart: at - start + lead.length,
    matchLength: query.length,
  };
}

export function searchSessions(store: Store, raw: unknown): SearchPage {
  const input = searchInput.parse(raw),
    query = input.q.toLowerCase();
  if (input.sessionId) store.need('session', input.sessionId);
  const scope = [
    input.sessionId ?? '',
    input.sessionId ?? '',
    input.sessionId ?? '',
    Number(input.archived === 'true'),
  ];
  const state = store.db
    .prepare(
      `WITH scope AS (${scopeSQL})
    SELECT s.id,json_extract(s.body,'$.title') AS title,count(m.id) AS count,coalesce(max(m.position),0) AS last
    FROM scope s LEFT JOIN messages m ON m.session_id=s.id GROUP BY s.id ORDER BY s.id`,
    )
    .all(...scope);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([query, input.archived, input.sessionId, state]))
    .digest('hex');
  let last = { sessionId: '', position: 0 };
  if (input.cursor) {
    let cursor;
    try {
      cursor = cursorInput.parse(
        JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')),
      );
    } catch {
      throw new AppError('INVALID_SEARCH_CURSOR', '搜索分页参数无效，请重新搜索');
    }
    invariant(
      cursor.fingerprint === fingerprint,
      'SEARCH_CURSOR_EXPIRED',
      '搜索结果已变化，请重新搜索',
      409,
    );
    last = cursor;
  }
  if (!query) return { hits: [], cursor: null };
  const rows = store.db
    .prepare(
      `WITH scope AS (${scopeSQL}), hits AS (
    SELECT s.id AS session_id,0 AS position,NULL AS message_id,json_extract(s.body,'$.title') AS text,'title' AS source
    FROM scope s WHERE instr(lower(json_extract(s.body,'$.title')),?)>0
    UNION ALL
    SELECT m.session_id,m.position,m.id,json_extract(m.body,'$.text'),'message' FROM messages m
    JOIN scope s ON s.id=m.session_id WHERE json_type(m.body,'$.text')='text'
      AND json_extract(m.body,'$.role') IN ('user','assistant','tool') AND instr(lower(json_extract(m.body,'$.text')),?)>0)
    SELECT h.*,json_extract(s.body,'$.title') AS title FROM hits h JOIN scope s ON s.id=h.session_id
    WHERE h.session_id>? OR (h.session_id=? AND h.position>?) ORDER BY h.session_id,h.position LIMIT ?`,
    )
    .all(
      ...scope,
      query,
      query,
      last.sessionId,
      last.sessionId,
      last.position,
      input.limit + 1,
    ) as {
    session_id: string;
    position: number;
    message_id: string | null;
    text: string;
    source: 'title' | 'message';
    title: string;
  }[];
  const hits: SearchHit[] = rows.slice(0, input.limit).map((r) => ({
    sessionId: r.session_id,
    title: r.title,
    messageId: r.message_id,
    position: r.position,
    source: r.source,
    ...snippet(r.text, query),
  }));
  const tail = hits.at(-1);
  return {
    hits,
    cursor:
      rows.length > input.limit && tail
        ? Buffer.from(
            JSON.stringify({ fingerprint, sessionId: tail.sessionId, position: tail.position }),
          ).toString('base64url')
        : null,
  };
}
