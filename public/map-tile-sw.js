/**
 * map-tile-sw.js — HERE map tile cache-first Service Worker + Web Push
 *
 * Tile caching strategy:
 *   1. Check active city cache → return if hit
 *   2. Check legacy/fallback caches → return if hit
 *   3. Fetch from network, cache it, broadcast TILE_NETWORK_FETCH to clients
 *
 * City namespacing: each city gets its own Cache Storage bucket so switching
 * cities doesn't invalidate the entire tile cache.
 *
 * Push notifications:
 *   'push' event      — shows a notification using the payload's title/body/icon/url
 *   'notificationclick' — focuses an existing app window or opens a new one,
 *                         navigating to `data.url` if provided (deep link)
 */

const SW_VERSION = 'v12';
const CACHE_PREFIX = 'here-tiles';
const DEFAULT_CACHE = `${CACHE_PREFIX}-default-${SW_VERSION}`;
const TILE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const STALE_CITY_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Active city — updated via SET_ACTIVE_CITY message
let activeCityId = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getCacheName(cityId) {
  return cityId ? `${CACHE_PREFIX}-${cityId}` : DEFAULT_CACHE;
}

/** Strip API key and other volatile params so the same tile always hits the same cache entry */
function normalizeTileUrl(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete('apiKey');
    u.searchParams.delete('api_key');
    u.searchParams.delete('token');
    return u.toString();
  } catch (_) {
    return url;
  }
}

function isTileRequest(url) {
  try {
    const u = new URL(url);
    return (
      u.hostname.includes('maps.hereapi.com') ||
      u.hostname.includes('tiles.maps.hereapi.com') ||
      u.hostname.includes('map.ls.hereapi.com') ||
      (u.hostname.includes('here.com') && (u.pathname.includes('/maptile') || u.pathname.includes('/tile')))
    );
  } catch (_) {
    return false;
  }
}

/** Broadcast a message to all controlled clients */
async function broadcastToClients(msg) {
  try {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: false });
    clients.forEach((client) => client.postMessage(msg));
  } catch (_) {}
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  console.log(`[TileSW ${SW_VERSION}] Installing`);
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  console.log(`[TileSW ${SW_VERSION}] Activating`);
  event.waitUntil(self.clients.claim());
});

// ─── Fetch interception ───────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only intercept HERE tile requests
  if (!isTileRequest(request.url)) return;

  event.respondWith(handleTileRequest(request));
});

async function handleTileRequest(request) {
  const cacheKey = normalizeTileUrl(request.url);
  const cacheRequest = new Request(cacheKey);

  // ── 1. Try active city cache first ────────────────────────────────────────
  if (activeCityId) {
    try {
      const cityCache = await caches.open(getCacheName(activeCityId));
      const cityHit = await cityCache.match(cacheRequest);
      if (cityHit) {
        return cityHit;
      }
    } catch (_) {}
  }

  // ── 2. Try default/fallback cache ─────────────────────────────────────────
  try {
    const defaultCache = await caches.open(DEFAULT_CACHE);
    const defaultHit = await defaultCache.match(cacheRequest);
    if (defaultHit) {
      // Promote to active city cache for future hits
      if (activeCityId) {
        defaultHit.clone().blob().then((blob) => {
          caches.open(getCacheName(activeCityId)).then((c) =>
            c.put(cacheRequest, new Response(blob, {
              status: defaultHit.status,
              statusText: defaultHit.statusText,
              headers: defaultHit.headers
            }))
          ).catch(() => {});
        }).catch(() => {});
      }
      return defaultHit;
    }
  } catch (_) {}

  // ── 3. Try any other existing city caches ─────────────────────────────────
  try {
    const allCacheNames = await caches.keys();
    const otherTileCaches = allCacheNames.filter(
      (name) => name.startsWith(CACHE_PREFIX) && name !== getCacheName(activeCityId) && name !== DEFAULT_CACHE
    );
    for (const cacheName of otherTileCaches) {
      const cache = await caches.open(cacheName);
      const hit = await cache.match(cacheRequest);
      if (hit) {
        return hit;
      }
    }
  } catch (_) {}

  // ── 4. Network fetch (cache miss) ─────────────────────────────────────────
  let networkResponse;
  try {
    networkResponse = await fetch(request);
  } catch (networkError) {
    // Offline and no cache — return a transparent 1x1 PNG tile placeholder
    console.warn(`[TileSW] Network error for tile: ${networkError.message}`);
    return new Response(null, { status: 503, statusText: 'Service Unavailable' });
  }

  if (!networkResponse.ok) {
    return networkResponse;
  }

  // Broadcast cache miss so the usage tracker can log it
  broadcastToClients({ type: 'TILE_NETWORK_FETCH', count: 1 });

  // Cache the response
  try {
    const targetCacheName = getCacheName(activeCityId);
    const responseToCache = networkResponse.clone();
    const cache = await caches.open(targetCacheName);
    await cache.put(cacheRequest, responseToCache);
  } catch (cacheError) {
    console.warn(`[TileSW] Failed to cache tile: ${cacheError.message}`);
  }

  return networkResponse;
}

// ─── Message handling ─────────────────────────────────────────────────────────

self.addEventListener('message', (event) => {
  const { type, cityId } = event.data || {};

  switch (type) {
    case 'SET_ACTIVE_CITY':
      if (cityId && cityId !== activeCityId) {
        console.log(`[TileSW] Active city → ${cityId}`);
        activeCityId = cityId;
      }
      break;

    case 'CLEAR_CITY_CACHE':
      if (cityId) {
        caches.delete(getCacheName(cityId))
          .then(() => console.log(`[TileSW] Cleared cache for city: ${cityId}`))
          .catch(() => {});
      }
      break;

    case 'CLEAR_STALE_CITIES':
      pruneStaleCarches();
      break;

    case 'GET_CACHE_STATS':
      getCacheStats().then((stats) => {
        event.source?.postMessage({ type: 'CACHE_STATS', ...stats });
      }).catch(() => {});
      break;

    case 'SHOW_TRACKING_NOTIFICATION':
      showTrackingNotification(event.data);
      break;

    case 'HIDE_TRACKING_NOTIFICATION':
      hideTrackingNotification();
      break;

    case 'UPDATE_TRACKING_NOTIFICATION':
      updateTrackingNotification(event.data);
      break;

    default:
      break;
  }
});

// ─── Stale cache pruning ──────────────────────────────────────────────────────

async function pruneStaleCarches() {
  try {
    const allCaches = await caches.keys();
    const tileCaches = allCaches.filter((name) => name.startsWith(CACHE_PREFIX));
    const now = Date.now();

    for (const cacheName of tileCaches) {
      const cache = await caches.open(cacheName);
      const requests = await cache.keys();
      let deletedCount = 0;

      for (const req of requests) {
        const response = await cache.match(req);
        if (!response) continue;

        const dateHeader = response.headers.get('date');
        if (dateHeader) {
          const cacheAge = now - new Date(dateHeader).getTime();
          if (cacheAge > STALE_CITY_TTL_MS) {
            await cache.delete(req);
            deletedCount++;
          }
        }
      }

      // Delete the whole cache bucket if it's now empty
      const remaining = await cache.keys();
      if (remaining.length === 0) {
        await caches.delete(cacheName);
        console.log(`[TileSW] Pruned empty cache: ${cacheName}`);
      } else if (deletedCount > 0) {
        console.log(`[TileSW] Pruned ${deletedCount} stale tiles from ${cacheName}`);
      }
    }
  } catch (err) {
    console.warn(`[TileSW] Stale cache pruning failed: ${err.message}`);
  }
}

// ─── Cache stats ──────────────────────────────────────────────────────────────

async function getCacheStats() {
  try {
    const allCaches = await caches.keys();
    const tileCaches = allCaches.filter((name) => name.startsWith(CACHE_PREFIX));
    let totalTiles = 0;
    const perCity = {};

    for (const cacheName of tileCaches) {
      const cache = await caches.open(cacheName);
      const keys = await cache.keys();
      totalTiles += keys.length;
      perCity[cacheName] = keys.length;
    }

    return { totalTiles, perCity, activeCityId };
  } catch (_) {
    return { totalTiles: 0, perCity: {}, activeCityId };
  }
}


// ─── Persistent Tracking Notification ──────────────────────────────────────────
// On Android, a visible notification makes the OS less aggressive about killing the
// PWA's background process. While this doesn't give us a true Android Foreground
// Service, it significantly improves the survival rate of watchPosition callbacks
// and setInterval heartbeats when the app is backgrounded.
//
// The notification is shown when the driver goes on_duty and removed when they go
// off_duty. It uses `requireInteraction: true` so it doesn't auto-dismiss, and a
// unique `tag: 'rxdeliver-tracking'` so it replaces itself on updates.
//
// IMPORTANT: This notification is LOCAL (not a push notification). It's triggered
// by the client page via postMessage to the service worker. No server involvement.

const TRACKING_TAG = 'rxdeliver-tracking';

async function showTrackingNotification(data = {}) {
  const status = data.status || 'on_duty';
  const driverName = data.driverName || 'Driver';
  const stopCount = data.stopCount;
  const nextStop = data.nextStop;

  let body = 'Location tracking active';
  if (stopCount != null) body = `${stopCount} stop${stopCount !== 1 ? 's' : ''} remaining`;
  if (nextStop) body += ` — Next: ${nextStop}`;

  const options = {
    body,
    icon: ICON_192,
    badge: ICON_192,
    tag: TRACKING_TAG,
    requireInteraction: true, // Persistent — won't auto-dismiss
    silent: true, // No sound — this is a status indicator, not an alert
    data: {
      url: '/',
      isTrackingNotification: true,
      status,
    },
  };

  // Add a "Go Off Duty" action button (Android Chrome supports max 2)
  if (data.canStopTracking) {
    options.actions = [{
      action: 'stop_tracking',
      title: 'Go Off Duty',
    }];
  }

  try {
    await self.registration.showNotification(`RxDeliver — ${status === 'on_duty' ? 'On Duty' : 'Tracking'}`, options);
    console.log('[TileSW] Tracking notification shown');
  } catch (err) {
    console.warn('[TileSW] Failed to show tracking notification:', err.message);
  }
}

async function updateTrackingNotification(data = {}) {
  // showNotification with the same tag replaces the existing notification
  await showTrackingNotification(data);
}

async function hideTrackingNotification() {
  try {
    const notifications = await self.registration.getNotifications({ tag: TRACKING_TAG });
    for (const n of notifications) {
      n.close();
    }
    console.log('[TileSW] Tracking notification hidden');
  } catch (err) {
    console.warn('[TileSW] Failed to hide tracking notification:', err.message);
  }
}

// Handle the "Go Off Duty" action button on the tracking notification
// (notificationclick for this action is handled in the main notificationclick listener above)

// ─── Web Push ─────────────────────────────────────────────────────────────────
// This is the SINGLE source of push handling for the PWA. The separate push-sw.js
// has been removed — having two SWs competing at the same scope caused Android
// Chrome to deliver background push events to whichever SW won the controller
// race (usually map-tile-sw.js since it registers first), but the push
// subscription might have been created on the OTHER SW's registration. When the
// app is backgrounded, the push event fires on the SW that owns the subscription
// — if that SW is not the controlling SW, showNotification() may silently fail
// or the event may not fire at all. Consolidating into one SW eliminates this
// race entirely.

const ICON_192 = 'https://media.base44.com/images/public/68570f3cd01bfa2d2408a9d6/25b6bccd2_renametoicon-192.png';
const ICON_512 = 'https://media.base44.com/images/public/68570f3cd01bfa2d2408a9d6/0fe50bd3b_renametoicon-512.png';

function resolvePwaUrl(targetUrl) {
  const scope = self.registration.scope;
  if (!targetUrl || targetUrl === '/') {
    return scope;
  }
  if (targetUrl.startsWith('http://') || targetUrl.startsWith('https://')) {
    return targetUrl;
  }
  if (targetUrl.startsWith('/?')) {
    const query = targetUrl.slice(1);
    return scope + (scope.endsWith('/') ? query.slice(1) : query);
  }
  if (targetUrl.startsWith('/')) {
    return scope + (scope.endsWith('/') ? targetUrl.slice(1) : targetUrl);
  }
  return new URL(targetUrl, scope).href;
}

// ─── Push: update last_used_at on THIS device only ─────────────────────────────
// The server's sendPushNotification function no longer stamps last_used_at on
// every subscription (it would stamp all of the user's devices with the same
// time). Instead, each device's SW reads the updatePushLastUsed function URL
// from the push-config cache and calls it here, so only the subscription for
// THIS device gets its own timestamp reflecting when push arrived here.
const PUSH_CONFIG_CACHE = 'push-config';
const PUSH_CONFIG_KEY = 'push-config.js';

async function updatePushLastUsed() {
  try {
    const cache = await caches.open(PUSH_CONFIG_CACHE);
    const keyUrl = new URL(PUSH_CONFIG_KEY, self.registration.scope).href;
    const response = await cache.match(keyUrl);
    if (!response) return;
    const config = await response.json();
    if (!config?.functionUrl) return;
    const sub = await self.registration.pushManager.getSubscription();
    if (!sub) return;
    await fetch(config.functionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint })
    });
  } catch (_) {}
}

// ─── Auth token bridge for background actions ─────────────────────────────────
// The SW has no access to localStorage. The app mirrors the Base44 access token
// into IndexedDB (rxdeliver_auth_bridge) so background notification actions can
// make authenticated API calls while the app is closed.
async function getBridgeToken() {
  try {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('rxdeliver_auth_bridge', 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const token = await new Promise((resolve, reject) => {
      const tx = db.transaction('tokens', 'readonly');
      const req = tx.objectStore('tokens').get('current');
      req.onsuccess = () => resolve(req.result?.token || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return token;
  } catch (_) {
    return null;
  }
}

// ─── Backend API call helper ─────────────────────────────────────────────────
async function callBackendFunction(functionName, body) {
  try {
    const token = await getBridgeToken();
    if (!token) {
      console.warn('[SW] No auth token in bridge — cannot call backend function');
      return null;
    }
    const scope = self.registration.scope;
    // Extract origin + base path from scope (e.g. https://base44.com/apps/xxx/)
    // The function API endpoint is: {origin}/api/apps/{appId}/functions/{functionName}
    // We read the appId from the scope path.
    const scopeUrl = new URL(scope);
    const pathParts = scopeUrl.pathname.split('/').filter(Boolean)
    // Find 'apps' in path and grab the next segment as appId
    let appId = null;
    for (let i = 0; i < pathParts.length - 1; i++) {
      if (pathParts[i] === 'apps') { appId = pathParts[i + 1]; break; }
    }
    if (!appId) return null;
    const apiUrl = `${scopeUrl.origin}/api/apps/${appId}/functions/${functionName}`;
    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(body)
    });
    return resp.ok;
  } catch (e) {
    console.warn('[SW] Backend function call failed:', e?.message || e);
    return false;
  }
}

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
    icon: payload.icon || ICON_192,
    badge: payload.badge || ICON_192,
    tag: payload.tag || undefined,
    renotify: !!payload.tag,
    requireInteraction: payload.requireInteraction != null ? !!payload.requireInteraction : true,
    data: {
      url: payload.url || '/',
      tag: payload.tag || undefined,
      requireInteraction: payload.requireInteraction != null ? !!payload.requireInteraction : true,
      ...payload.data
    }
  };

  // Add action buttons if the payload includes them.
  // Chrome on Android supports max 2 action buttons on persistent notifications.
  if (payload.actions && Array.isArray(payload.actions)) {
    options.actions = payload.actions.slice(0, 2).map(a => ({
      action: a.action,
      title: a.title,
      icon: a.icon || undefined
    }));
    // Store action metadata in data for the click handler
    options.data._actions = payload.actions.slice(0, 2);
  }

  event.waitUntil(Promise.all([
    self.registration.showNotification(title, options),
    updatePushLastUsed()
  ]));
});



self.addEventListener('notificationclick', (event) => {
  const action = event.action; // '' when the notification body is clicked (not a button)

  // ─── Action button clicks ─────────────────────────────────────────────────
  // ─── Tracking notification "Go Off Duty" action ─────────────────────────────
  if (action === 'stop_tracking') {
    event.notification.close();
    // Post message to any open client to trigger the off-duty transition
    event.waitUntil((async () => {
      const clientList = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) {
        if (client.url.startsWith(self.registration.scope)) {
          client.postMessage({ type: 'stop_tracking_from_notification' });
          if ('focus' in client) client.focus();
        }
      }
    })());
    return;
  }

  // Don't close the notification on body click if it's the tracking indicator
  if (event.notification.data?.isTrackingNotification && !action) {
    // Just focus the app — don't close the notification
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
        for (const client of clientList) {
          if (client.url.startsWith(self.registration.scope) && 'focus' in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) return clients.openWindow('/');
      })
    );
    return;
  }

  if (action === 'mark_read' || action === 'acknowledge' || action === 'reply' || action === 'update_now') {
    event.notification.close();

    const notifData = event.notification.data || {};
    event.waitUntil((async () => {
      let result = false;

      // mark_read + acknowledge + update_now(message_id) hit the backend
      // handleNotificationAction; reply is pure client-side navigation.
      if (action === 'mark_read' && notifData.message_id) {
        result = await callBackendFunction('handleNotificationAction', {
          action: 'mark_read',
          message_id: notifData.message_id
        });
      } else if (action === 'acknowledge' && notifData.delivery_ids) {
        result = await callBackendFunction('handleNotificationAction', {
          action: 'acknowledge',
          delivery_ids: notifData.delivery_ids
        });
      } else if (action === 'update_now' && notifData.message_id) {
        // Mark the update broadcast message as read, then reload client-side
        result = await callBackendFunction('handleNotificationAction', {
          action: 'mark_read',
          message_id: notifData.message_id
        });
      }

      // Post a message to any open client so the UI can update in real-time
      const clientList = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) {
        if (client.url.startsWith(self.registration.scope)) {
          client.postMessage({
            type: 'notification_action',
            action,
            result,
            message_id: notifData.message_id,
            delivery_ids: notifData.delivery_ids,
            reply_to: notifData.reply_to,
            reply_to_name: notifData.reply_to_name
          });
        }
      }

      // reply + update_now also focus/navigate the app so the user lands on
      // the right screen (conversation / reload) even when the app was closed.
      if (action === 'reply' || action === 'update_now') {
        let rawUrl = notifData.url || '/';
        if (action === 'reply' && notifData.reply_to) {
          const sep = rawUrl.includes('?') ? '&' : '?';
          rawUrl = rawUrl + sep + 'openChat=' + encodeURIComponent(notifData.reply_to) +
            (notifData.reply_to_name ? '&openChatName=' + encodeURIComponent(notifData.reply_to_name) : '');
        }
        const fullUrl = resolvePwaUrl(rawUrl);
        const clientsList = await clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of clientsList) {
          if (client.url.startsWith(self.registration.scope) && 'focus' in client) {
            if ('navigate' in client) client.navigate(fullUrl).catch(() => {});
            return client.focus();
          }
        }
        if (clients.openWindow) return clients.openWindow(fullUrl);
      }
    })());
    return;
  }

  // ─── Default: body click — open/focus the app ──────────────────────────────
  event.notification.close();
  const rawUrl = event.notification.data?.url || '/';
  const fullUrl = resolvePwaUrl(rawUrl);

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url === fullUrl && 'focus' in client) {
          return client.focus();
        }
      }
      for (const client of clientList) {
        if (client.url.startsWith(self.registration.scope) && 'focus' in client) {
          if ('navigate' in client) {
            client.navigate(fullUrl).catch(() => {});
          }
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(fullUrl);
      }
    })
  );
});
