/* Εν Μέλιν — the ready screen's feed.
 *
 * Devices that change an order post the whole live picture for the current
 * event; the screen polls GET ?b=<id>. Per order, the newest change wins, so a
 * write lost to a race is healed by the next post from any device. The first
 * post for a screen id fixes its key; later posts must carry the same key.
 * Holds only order numbers, first names and states. No environment variables.
 */
import { getStore } from '@netlify/blobs';

const ID = /^[A-Z0-9]{4,12}$/;
const KEY = /^[A-Z0-9]{16,64}$/;
const ITEM = /^[A-Za-z0-9_-]{1,40}$/;
const STATES = new Set(['prep', 'ready', 'gone']);
const MAX_ITEMS = 400;
const GONE_KEEP = 15 * 60e3;
const DAY_KEEP = 12 * 3600e3;

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
async function hash(k) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('enmelin-board:' + k));
  return Buffer.from(d).toString('hex');
}
const clean = (i, now) => {
  if (!i || !ITEM.test(String(i.id)) || !STATES.has(i.s)) return null;
  const t = Math.min(Number(i.t) || 0, now + 60e3);
  if (!t) return null;
  return { id: String(i.id), no: String(i.no ?? '').slice(0, 8), name: String(i.name ?? '').slice(0, 16),
           s: i.s, t, r: Math.min(Number(i.r) || 0, now + 60e3) };
};

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  const url = new URL(req.url);
  const store = getStore({ name: 'enmelin-board', consistency: 'strong' });
  const now = Date.now();

  if (req.method === 'GET') {
    const b = (url.searchParams.get('b') || '').toUpperCase();
    if (!ID.test(b)) return json(404, { error: 'no such screen' });
    const cur = await store.get('b/' + b, { type: 'json' });
    if (!cur) return json(200, { items: [], meta: {}, at: null });
    const items = Object.values(cur.items || {}).filter(i => i.s !== 'gone' && now - i.t < DAY_KEEP);
    return json(200, { items, meta: cur.meta || {}, at: cur.at || null });
  }

  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json(400, { error: 'bad JSON' }); }
    const b = String((body && body.b) || '').toUpperCase();
    const k = body && body.k;
    if (!ID.test(b) || typeof k !== 'string' || !KEY.test(k)) return json(400, { error: 'bad screen id or key' });
    const h = await hash(k);
    const cur = (await store.get('b/' + b, { type: 'json' })) || { h, items: {}, meta: {}, at: 0 };
    if (cur.h !== h) return json(403, { error: 'wrong key for this screen' });
    const incoming = Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS) : [];
    for (const raw of incoming) {
      const i = clean(raw, now);
      if (!i) continue;
      const prev = cur.items[i.id];
      if (!prev || i.t > prev.t) cur.items[i.id] = i;
    }
    for (const [id, i] of Object.entries(cur.items)) {
      if ((i.s === 'gone' && now - i.t > GONE_KEEP) || now - i.t > DAY_KEEP) delete cur.items[id];
    }
    const all = Object.values(cur.items);
    if (all.length > MAX_ITEMS) {
      all.sort((a, c) => c.t - a.t).slice(MAX_ITEMS).forEach(i => delete cur.items[i.id]);
    }
    const m = body.meta || {};
    cur.meta = { title: String(m.title || '').slice(0, 40), cause: String(m.cause || '').slice(0, 80), speak: !!m.speak };
    cur.at = now;
    await store.setJSON('b/' + b, cur);
    return json(200, { ok: true, n: Object.keys(cur.items).length });
  }
  return json(405, { error: 'method not allowed' });
};
