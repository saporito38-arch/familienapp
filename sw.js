// Service Worker der Familien-App: zeigt Push-Benachrichtigungen an
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Familie', {
    body: d.body || '',
    tag: d.tag || undefined,
    icon: 'icon.png',
    badge: 'icon.png',
    data: { view: d.view || 'heute' }
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const view = (e.notification.data && e.notification.data.view) || 'heute';
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if ('focus' in c) { c.postMessage({ view }); return c.focus(); }
    }
    return self.clients.openWindow(new URL('./#' + view, self.registration.scope).href);
  })());
});
