const ICON_192 = 'https://media.base44.com/images/public/68570f3cd01bfa2d2408a9d6/25b6bccd2_renametoicon-192.png';
const ICON_512 = 'https://media.base44.com/images/public/68570f3cd01bfa2d2408a9d6/0fe50bd3b_renametoicon-512.png';

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'RxDeliver', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'RxDeliver';
  const options = {
    body: data.body || '',
    icon: ICON_192,
    badge: ICON_192,
    image: data.image || undefined,
    data: { url: data.url || '/' },
    requireInteraction: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(targetUrl) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
