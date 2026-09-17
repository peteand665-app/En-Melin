/* Εν Μέλιν — guest-ticket queue for a Star CloudPRNT printer.
 *
 * The till posts a ticket (a PNG it drew itself); the printer polls this URL
 * every few seconds, fetches the oldest ticket and confirms it. Everything is
 * namespaced by the secret key in the printer's URL (?k=...), which the app
 * generates once in Settings → Εκτυπωτής αριθμών. No environment variables.
 *
 * CloudPRNT (HTTP):  POST = poll · GET ?token = fetch job · DELETE ?token&code = done
 * App:               POST {submit:true,k,id,png} · GET ?k&info=1
 */
import { getStore } from '@netlify/blobs';

const MAX_PNG = 400 * 1024;       // a long ticket is ~80 KB
const MAX_QUEUE = 60;
const JOB_TTL = 6 * 3600e3;       // a ticket from hours ago helps nobody
const SEEN_EVERY = 30e3;          // record printer status at most this often

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const validKey = k => typeof k === 'string' && /^[A-Z0-9]{16,64}$/.test(k);
async function ns(k) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('enmelin-print:' + k));
  return [...new Uint8Array(d)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}
const tokenOf = key => key.split('/job/')[1];
const tsOf = key => parseInt(tokenOf(key).split('-')[0], 36) || 0;

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  const url = new URL(req.url);
  let body = null;
  if (req.method === 'POST') {
    try { body = await req.json(); } catch { return json(400, { error: 'bad JSON' }); }
    if (!body || typeof body !== 'object') return json(400, { error: 'bad JSON' });
  }
  const key = body && body.submit ? body.k : url.searchParams.get('k');
  if (!validKey(key)) return json(401, { error: 'unknown printer key' });

  const store = getStore({ name: 'enmelin-print', consistency: 'strong' });
  const P = `p/${await ns(key)}/`;
  const jobs = async () => ((await store.list({ prefix: P + 'job/' })).blobs || []).map(b => b.key).sort();
  const now = Date.now();

  /* ── the app queues a ticket ── */
  if (req.method === 'POST' && body.submit) {
    if (typeof body.png !== 'string' || body.png.length > MAX_PNG * 1.4) return json(413, { error: 'ticket too large' });
    const bytes = Uint8Array.from(Buffer.from(body.png, 'base64'));
    if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47)
      return json(400, { error: 'not a PNG' });
    const list = await jobs();
    if (list.length >= MAX_QUEUE) return json(429, { error: 'queue full' });
    const id = String(body.id || 'job').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40) || 'job';
    await store.set(`${P}job/${now.toString(36).padStart(9, '0')}-${id}`, bytes.buffer);
    return json(200, { queued: list.length + 1 });
  }

  /* ── the printer polls ── */
  if (req.method === 'POST') {
    const status = String(body.statusCode || '').slice(0, 60);
    const prev = await store.get(P + 'printer', { type: 'json' });
    if (!prev || prev.status !== status || now - prev.at > SEEN_EVERY)
      await store.setJSON(P + 'printer', { mac: String(body.printerMAC || '').slice(0, 32), status, at: now });
    const fresh = [];
    for (const j of await jobs()) {
      if (now - tsOf(j) > JOB_TTL) await store.delete(j); else fresh.push(j);
    }
    if (!fresh.length || body.printingInProgress) return json(200, { jobReady: false });
    return json(200, { jobReady: true, mediaTypes: ['image/png'], jobToken: tokenOf(fresh[0]) });
  }

  /* ── the app asks how the printer is ── */
  if (req.method === 'GET' && url.searchParams.get('info')) {
    const pr = await store.get(P + 'printer', { type: 'json' });
    const err = await store.get(P + 'lasterror', { type: 'json' });
    return json(200, { seen: pr ? pr.at : null, status: pr ? pr.status : '', queued: (await jobs()).length,
      lastError: err && now - err.at < 3600e3 ? err.code : '' });
  }

  const token = (url.searchParams.get('token') || '').replace(/[^A-Za-z0-9-]/g, '');
  const target = async () => token ? `${P}job/${token}` : (await jobs())[0];

  /* ── the printer fetches the job ── */
  if (req.method === 'GET') {
    const jk = await target();
    const data = jk && await store.get(jk, { type: 'arrayBuffer' });
    if (!data) return new Response('', { status: 404 });
    return new Response(data, { status: 200, headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
  }

  /* ── the printer confirms: printed, or it cannot take it — either way it leaves the queue ── */
  if (req.method === 'DELETE') {
    const code = url.searchParams.get('code') || '';
    const jk = await target();
    if (jk) await store.delete(jk);
    if (!code.startsWith('2')) await store.setJSON(P + 'lasterror', { code: code.slice(0, 60), at: now });
    return json(200, {});
  }
  return json(405, { error: 'method not allowed' });
};
