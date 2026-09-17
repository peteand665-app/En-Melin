/* Εν Μέλιν — send a push to the devices watching a station (copied from Smash Me).
 *
 * There is no database. The order-taking device already knows every
 * subscription, because they travel in the Google Drive sync file, so it posts
 * them along with the message. This function's only job is to hold the VAPID
 * private key, which must never reach the browser.
 *
 * Environment variables (Netlify → Site configuration → Environment variables):
 *   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:you@example.com)
 */
const webpush = require('web-push');

const MAX_SUBS = 25;          // a caravan, not a chain
const MAX_BODY = 200 * 1024;  // a product photo, and no more

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST')    return json(405, { error: 'POST only' });

  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return json(500, { error: 'VAPID keys are not set on this site' });
  }
  if ((event.body || '').length > MAX_BODY) return json(413, { error: 'payload too large' });

  let req;
  try { req = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'bad JSON' }); }

  const subs = Array.isArray(req.subscriptions) ? req.subscriptions.slice(0, MAX_SUBS) : [];
  if (!subs.length) return json(400, { error: 'no subscriptions' });

  webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:enmelin@example.com',
                          VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const payload = JSON.stringify({
    title:   req.title   || 'New order',
    body:    req.body    || '',
    icon:    req.icon    || undefined,
    image:   req.image   || undefined,
    station: req.station || '',
    orderId: req.orderId || '',
    count:   req.count   || 0
  });

  /* Report each endpoint separately: a subscription that has expired should be
     dropped by the caller, not retried forever. */
  const results = await Promise.allSettled(
    subs.map(s => webpush.sendNotification(s, payload, { TTL: 600, urgency: 'high' }))
  );

  const gone = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const code = r.reason && r.reason.statusCode;
      if (code === 404 || code === 410) gone.push(subs[i].endpoint);
    }
  });

  return json(200, {
    sent:   results.filter(r => r.status === 'fulfilled').length,
    failed: results.filter(r => r.status === 'rejected').length,
    gone                                   // caller removes these
  });
};

const cors = () => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
});
const json = (statusCode, obj) => ({
  statusCode, headers: { ...cors(), 'content-type': 'application/json' }, body: JSON.stringify(obj)
});
