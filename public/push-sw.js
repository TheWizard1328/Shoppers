// Web Push listeners — imported by map-tile-sw.js via importScripts
const DEFAULT_NOTIFICATION_ICON = '/icons/icon-192.png';
const DEFAULT_NOTIFICATION_BADGE = '/icons/icon-192.png';

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    payload = { body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || 'RxDeliver';
  const options = {
    body: payload.body || '',
    icon: payload.icon || DEFAULT_NOTIFICATION_ICON,
    badge: payload.badge || DEFAULT_NOTIFICATION_BADGE,
    tag: payload.tag || undefined,
    renotify: !!payload.tag,
    requireInteraction: !!payload.requireInteraction,
    data: { url: payload.url || '/', ...payload.data }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      try {
        const clientUrl = new URL(client.url);
        if (clientUrl.origin === self.location.origin && 'focus' in client) {
          await client.focus();
          if ('navigate' in client && targetUrl !== clientUrl.pathname) {
            try { await client.navigate(targetUrl); } catch (_) {}
          }
          return;
        }
      } catch (_) {}
    }
    if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
  })());
});
