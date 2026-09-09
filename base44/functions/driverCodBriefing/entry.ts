// driverCodBriefing — 9am driver COD briefing.
// Reads SquareCatalogItems (source of truth for outstanding/uncollected CODs,
// kept clean by the daily squarePruneCatalogDb 8:30am job), maps each item to
// its driver via the linked Delivery, and:
//   1. Sends each driver with outstanding CODs a push notification listing
//      every outstanding item (amount, date, store, patient), total and count.
//   2. Returns the full grouped breakdown (all drivers, all items) so the
//      app-owner briefing can be composed and delivered (agent/WhatsApp).
//
// Params: { dry_run?: boolean } — dry_run=true computes everything but does
// NOT send pushes (used for test runs).
//
// Push delivery is INLINED (web-push VAPID + FCM v1 HTTP API) — this function
// must run unauthenticated from a scheduled workflow, so it cannot call
// sendPushNotification (which requires an authenticated user session), and
// cross-function base44.functions.invoke does not forward auth anyway.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import webpush from 'npm:web-push@3.6.7';

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Proceeds when unauthenticated (scheduled workflow); requires admin if a user
// session is present.
const requireAdminIfAuthenticated = async (b44) => {
  const ok = await b44.auth.isAuthenticated().catch(() => false);
  if (!ok) return null;
  const u = await b44.auth.me().catch(() => null);
  if (u?.role !== 'admin') throw new HttpError(403, 'Forbidden: Admin access required');
  return u;
};

// ── FCM HTTP v1 access token (service account JWT → OAuth2 token) ──────
let _cachedFcmToken = null;
function base64UrlEncode(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function pemToArrayBuffer(pem) {
  const b64 = pem.replace('-----BEGIN PRIVATE KEY-----', '').replace('-----END PRIVATE KEY-----', '').replace(/\s+/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
async function getFcmAccessToken(serviceAccountJson) {
  const now = Math.floor(Date.now() / 1000);
  if (_cachedFcmToken && _cachedFcmToken.expiresAt - 60 > now) return _cachedFcmToken.token;
  let creds;
  try { creds = JSON.parse(serviceAccountJson); } catch { return null; }
  const { client_email, private_key } = creds;
  if (!client_email || !private_key) return null;
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claimSet = base64UrlEncode(JSON.stringify({
    iss: client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const key = await crypto.subtle.importKey('pkcs8', pemToArrayBuffer(private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = base64UrlEncode(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claimSet}`)));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claimSet}.${signature}` }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.access_token) return null;
  _cachedFcmToken = { token: json.access_token, expiresAt: now + 3600 };
  return json.access_token;
}

// ── Push sending (inlined parity with sendPushNotification) ─────────────
async function sendPushToUser(base44, userId, title, body, url, tag) {
  const vapidPublicKey = Deno.env.get('VAPID_PUBLIC_KEY');
  const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY');
  const vapidSubject = Deno.env.get('VAPID_SUBJECT');
  const fcmServiceAccountJson = Deno.env.get('FCM_SERVICE_ACCOUNT_JSON');
  let fcmProjectId = null;
  try { fcmProjectId = fcmServiceAccountJson ? JSON.parse(fcmServiceAccountJson).project_id : null; } catch { fcmProjectId = null; }

  const deviceProfiles = {};
  let hasAnyExplicitFalse = false;
  const userSettingsRecords = await base44.asServiceRole.entities.UserSettings.filter({ user_id: userId }).catch(() => []);
  const profiles = userSettingsRecords?.[0]?.device_settings_profiles || {};
  Object.assign(deviceProfiles, profiles);
  hasAnyExplicitFalse = Object.values(profiles).some((p) => p?.notifications_enabled === false);

  const subscriptions = await base44.asServiceRole.entities.PushSubscription.filter({ user_id: userId }).catch(() => []);
  if (!subscriptions || subscriptions.length === 0) return { sent: 0, skipped: 0, removed: 0, errors: [] };

  const notifData = { title, body, url: url || '/', tag: tag || undefined };

  const hasFcmSub = subscriptions.some((s) => s.endpoint?.startsWith('fcm://'));
  let fcmAccessToken = null;
  if (hasFcmSub && fcmServiceAccountJson && fcmProjectId) fcmAccessToken = await getFcmAccessToken(fcmServiceAccountJson);

  let sent = 0, removed = 0, skipped = 0;
  const errors = [];
  await Promise.all(subscriptions.map(async (sub) => {
    const isFCM = sub.endpoint?.startsWith('fcm://');
    // FCM (APK) subs always receive pushes; web subs honor device profiles.
    if (!isFCM) {
      let deviceEnabled = true;
      if (sub.device_identifier && deviceProfiles[sub.device_identifier]) deviceEnabled = deviceProfiles[sub.device_identifier].notifications_enabled ?? true;
      else if (hasAnyExplicitFalse) deviceEnabled = false;
      if (!deviceEnabled) { skipped++; return; }
    }
    if (isFCM) {
      const fcmToken = sub.endpoint.replace('fcm://', '');
      if (!fcmToken) { skipped++; return; }
      if (!fcmAccessToken || !fcmProjectId) { errors.push({ error: 'FCM not configured or token exchange failed' }); return; }
      try {
        const fcmMessage = {
          token: fcmToken,
          data: { url: url || '/' },
          android: { priority: 'high', notification: { tag: tag || undefined, channel_id: 'default' } },
        };
        fcmMessage.notification = { title, body, icon: 'ic_stat_notify', color: '#22c55e' };
        const fcmResponse = await fetch(`https://fcm.googleapis.com/v1/projects/${fcmProjectId}/messages:send`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${fcmAccessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: fcmMessage }),
        });
        if (fcmResponse.ok) sent++;
        else {
          const errBody = await fcmResponse.json().catch(() => ({}));
          const errStatus = errBody?.error?.status;
          if (errStatus === 'NOT_FOUND' || errStatus === 'INVALID_ARGUMENT' || fcmResponse.status === 404) {
            await base44.asServiceRole.entities.PushSubscription.delete(sub.id).catch(() => {});
            removed++;
          } else errors.push({ error: `FCM HTTP ${fcmResponse.status}` });
        }
      } catch (err) { errors.push({ error: err.message || String(err) }); }
    } else {
      if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) { errors.push({ error: 'VAPID keys not configured' }); return; }
      try {
        webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
        const pushSubscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh_key, auth: sub.auth_key } };
        await webpush.sendNotification(pushSubscription, JSON.stringify(notifData));
        sent++;
      } catch (err) {
        if (err?.statusCode === 410 || err?.statusCode === 404) {
          await base44.asServiceRole.entities.PushSubscription.delete(sub.id).catch(() => {});
          removed++;
        } else errors.push({ error: err.message || String(err) });
      }
    }
  }));
  return { sent, skipped, removed, errors };
}

// ── Helpers ─────────────────────────────────────────────────────────────
const unwrapEntityRecord = (r) => {
  if (!r || typeof r !== 'object') return null;
  if (r.data && typeof r.data === 'object') return { ...r.data, id: r.data.id || r.id };
  return r;
};
const money = (v) => `$${(Number(v) || 0).toFixed(2)}`;
const extractPatientName = (itemName) => {
  const m = String(itemName || '').match(/\)[-\s]*(.+)$/);
  return m ? m[1].trim() : (String(itemName || '').trim() || 'Unknown');
};
// MM/DD from a YYYY-MM-DD date for compact display
const shortDate = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${m[2]}/${m[1]}` : (iso || ''); };

async function listAll(base44, entityName, sortField, limit = 2000) {
  const out = [];
  const res = await base44.asServiceRole.entities[entityName].list(sortField, limit).catch(() => []);
  (Array.isArray(res) ? res : []).forEach((r) => { const u = unwrapEntityRecord(r); if (u) out.push(u); });
  return out;
}
async function fetchByIds(base44, entityName, ids) {
  const out = [];
  const unique = Array.from(new Set(ids.filter(Boolean)));
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const res = await base44.asServiceRole.entities[entityName].filter({ id: { $in: chunk } }).catch(() => []);
    (Array.isArray(res) ? res : []).forEach((r) => { const u = unwrapEntityRecord(r); if (u) out.push(u); });
    if (i + 50 < unique.length) await sleep(100);
  }
  return out;
}

async function handleBriefing(base44, params = {}) {
  const dryRun = !!params?.dry_run;
  const startedAt = Date.now();

  // 1. Outstanding CODs (source of truth — pruned daily to mirror live Square catalog)
  const catalogItems = await listAll(base44, 'SquareCatalogItems', '-updated_date');
  if (!catalogItems.length) {
    return { success: true, dry_run: dryRun, drivers: [], totals: { drivers: 0, items: 0, amount: 0 }, pushes: [], message: 'No outstanding CODs.', duration_ms: Date.now() - startedAt };
  }

  // 2. Map to deliveries (driver assignment)
  const deliveryIds = catalogItems.map((x) => x.delivery_id);
  const deliveries = await fetchByIds(base44, 'Delivery', deliveryIds);
  const deliveryById = new Map(deliveries.map((d) => [d.id, d]));

  // 3. Store names
  const storeIds = catalogItems.map((x) => x.store_id);
  const stores = await fetchByIds(base44, 'Store', storeIds);
  const storeById = new Map(stores.map((s) => [s.id, s]));

  // 4. Group by driver, items oldest first
  const groups = new Map(); // driver_id -> { driver_id, driver_name, items: [], total, count, byStore }
  const unassigned = [];
  for (const item of catalogItems) {
    const delivery = item.delivery_id ? deliveryById.get(item.delivery_id) : null;
    const store = storeById.get(item.store_id);
    const entry = {
      item_name: item.item_name,
      amount: Number(item.amount) || 0,
      delivery_date: item.delivery_date || delivery?.delivery_date || null,
      patient_name: extractPatientName(item.item_name),
      store_name: store?.name || store?.abbreviation || null,
      store_abbreviation: store?.abbreviation || null,
      delivery_status: delivery?.status || null,
    };
    if (!delivery?.driver_id) { unassigned.push(entry); continue; }
    if (!groups.has(delivery.driver_id)) {
      groups.set(delivery.driver_id, { driver_id: delivery.driver_id, driver_name: delivery.driver_name || 'Unknown driver', items: [], total: 0, count: 0, byStore: new Map() });
    }
    const g = groups.get(delivery.driver_id);
    g.items.push(entry);
    g.total += entry.amount;
    g.count += 1;
    g.byStore.set(entry.store_name || 'Unknown store', (g.byStore.get(entry.store_name || 'Unknown store') || 0) + entry.amount);
  }

  const driverBriefings = Array.from(groups.values()).map((g) => {
    g.items.sort((a, b) => String(a.delivery_date || '').localeCompare(String(b.delivery_date || '')));
    return {
      ...g,
      byStore: Array.from(g.byStore.entries()).map(([store, amount]) => ({ store, amount: Math.round(amount * 100) / 100 })),
    };
  }).sort((a, b) => b.total - a.total);

  // 5. Send pushes (skip in dry-run)
  const pushes = [];
  if (!dryRun) {
    const today = new Date().toISOString().slice(0, 10);
    for (const g of driverBriefings) {
      const lines = g.items.map((it) => `${shortDate(it.delivery_date)} ${it.store_abbreviation || (it.store_name || '').slice(0, 12)} — ${it.patient_name} — ${money(it.amount)}`);
      const body = [
        `${g.count} uncollected COD${g.count === 1 ? '' : 's'} totaling ${money(g.total)}.`,
        '',
        ...lines,
        '',
        'Collect at your earliest convenience.',
      ].join('\n');
      const result = await sendPushToUser(base44, g.driver_id, `COD Briefing — ${shortDate(today)}`, body, '/', `cod-briefing-${today}`);
      pushes.push({ driver_id: g.driver_id, driver_name: g.driver_name, ...result });
      await sleep(150);
    }
  }

  const totals = {
    drivers: driverBriefings.length,
    items: catalogItems.length,
    amount: Math.round(driverBriefings.reduce((s, g) => s + g.total, 0) * 100) / 100,
  };

  return {
    success: true,
    dry_run: dryRun,
    generated_at: new Date().toISOString(),
    totals,
    drivers: driverBriefings,
    unassigned_items: unassigned,
    pushes,
    duration_ms: Date.now() - startedAt,
  };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    await requireAdminIfAuthenticated(base44);
    let params = {};
    try { params = await req.json(); } catch { params = {}; }
    return Response.json(await handleBriefing(base44, params));
  } catch (error) {
    const status = error?.status || 500;
    return Response.json({ error: error?.message || 'Internal Server Error' }, { status });
  }
});
