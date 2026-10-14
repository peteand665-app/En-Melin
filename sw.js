/* Εν Μέλιν — service worker.
   Two jobs: notifications (as in Smash Me) and keeping the app usable at a
   venue with no signal. The app page is fetched network-first, so a new build
   is still picked up the moment the device is online; the cached copy is only
   used when the network fails. Bump CACHE with every release (release.sh does). */
const CACHE = 'enmelin-v1.6.0';
const SHELL = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png', '/badge-96.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('enmelin-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate'){
    event.respondWith(fetch(req).then(r => {
      if (r.ok){ const c = r.clone(); caches.open(CACHE).then(x => x.put('/', c)); }
      return r;
    }).catch(() => caches.match('/')));
    return;
  }
  const fonts = /^fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if ((url.origin === location.origin && !url.pathname.startsWith('/.netlify/')) || fonts){
    event.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
      if (r.ok || r.type === 'opaque'){ const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); }
      return r;
    })));
  }
});

self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = {}; }
  const title = d.title || 'Νέα παραγγελία';
  const opts = {
    body: d.body || '',
    tag: d.tag || ('order-' + (d.orderId || Date.now())),
    renotify: true,
    silent: false,                       // iOS plays the system notification sound
    data: { station: d.station || '', orderId: d.orderId || '' }
  };
  opts.icon = d.icon || '/icon-192.png';
  opts.badge = d.badge || '/badge-96.png';     // Android status bar: white silhouette
  opts.vibrate = [200, 100, 200];              // Android; iOS ignores it
  if (d.image) opts.image = d.image;
  event.waitUntil((async () => {
    await self.registration.showNotification(title, opts);
    /* tell any open window, so it can pull the new order straight away */
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    cs.forEach(c => c.postMessage({ enmelin: 'push', orderId: opts.data.orderId, station: opts.data.station }));
    if (self.registration.setAppBadge && d.count) self.registration.setAppBadge(d.count);
  })());
});

/* Tapping the notification opens the app on that station's screen. */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const { station } = event.notification.data || {};
  const url = '/?view=' + encodeURIComponent(station || 'home');
  event.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cs) {
      if ('focus' in c) { c.postMessage({ enmelin: 'open', station }); return c.focus(); }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
