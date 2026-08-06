const ICON_192 = 'https://media.base44.com/images/public/68570f3cd01bfa2d2408a9d6/25b6bccd2_renametoicon-192.png';
const ICON_512 = 'https://media.base44.com/images/public/68570f3cd01bfa2d2408a9d6/0fe50bd3b_renametoicon-512.png';

/**
 * Resolve a notification URL relative to the service worker's scope (the PWA root),
 * NOT the origin root. On Base44 preview, the SW scope is something like:
 *   https://app.base44.com/preview/<app-id>/
 * If we call clients.openWindow('/'), it resolves to https://app.base44.com/ (the
 * editor landing page), which opens Chrome — not the installed PWA. By resolving
 * against self.registration.scope, we ensure the URL stays within the PWA's manifest
 * scope, so Android opens the installed PWA in standalone mode.
 */
function resolvePwaUrl(targetUrl) {
  const scope = self.registration.scope; // e.g. https://app.base44.com/preview/<app-id>/
  if (!targetUrl || targetUrl === '/') {
    return scope;
  }
  // Full URL — use as-is
  if (targetUrl.startsWith('http://') || targetUrl.startsWith('https://')) {
    return targetUrl;
  }
  // Query-string-only URLs like "/?openChat=..." — we need to preserve the query
  // but anchor it to the PWA scope instead of the origin root.
  if (targetUrl.startsWith('/?')) {
    const query = targetUrl.slice(1); // "?openChat=..."
    return scope + (scope.endsWith('/') ? query.slice(1) : query);
  }
  // Absolute path like "/chat/123" — strip leading / and append to scope
  if (targetUrl.startsWith('/')) {
    return scope + (scope.endsWith('/') ? targetUrl.slice(1) : targetUrl);
  }
  // Relative path — resolve against scope
  return new URL(targetUrl, scope).href;
}

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
    data: { url: data.url || '/', tag: data.tag || undefined, requireInteraction: !!data.requireInteraction },
    tag: data.tag || undefined,
    requireInteraction: !!data.requireInteraction,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const rawUrl = event.notification.data?.url || '/';
  const fullUrl = resolvePwaUrl(rawUrl);

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // 1. Try exact URL match
      for (const client of clientList) {
        if (client.url === fullUrl && 'focus' in client) {
          return client.focus();
        }
      }
      // 2. Try any client within the SW scope (the PWA window) — navigate it to the target
      for (const client of clientList) {
        if (client.url.startsWith(self.registration.scope) && 'focus' in client) {
          if ('navigate' in client) {
            client.navigate(fullUrl).catch(() => {});
          }
          return client.focus();
        }
      }
      // 3. No existing PWA window — open a new one at the scope-resolved URL.
      //    Because the URL is within the manifest scope, Android opens the installed
      //    PWA in standalone mode, not Chrome.
      if (clients.openWindow) {
        return clients.openWindow(fullUrl);
      }
    })
  );
});
