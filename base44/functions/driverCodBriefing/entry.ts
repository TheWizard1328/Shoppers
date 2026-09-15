// driverCodBriefing — 9am driver COD briefing.
// Reads SquareCatalogItems (source of truth for outstanding/uncollected CODs,
// kept clean by the daily squarePruneCatalogDb 8:30am job), maps each item to
// its driver via the linked Delivery, and:
//   1. Sends each driver with outstanding CODs a push notification listing
//      every outstanding item (amount, date, store, patient), total and count.
//   2. Returns the full grouped breakdown (all drivers, all items) so the
//      app-owner briefing can be composed and delivered (agent/WhatsApp).
//
// Params: { dry_run?, owner_only?, test_driver_id? } — dry_run=true computes everything but does
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

  const userSettingsRecords = await base44.asServiceRole.entities.UserSettings.filter({ user_id: userId }).catch(() => []);
  const deviceProfiles = userSettingsRecords?.[0]?.device_settings_profiles || {};

  const subscriptions = await base44.asServiceRole.entities.PushSubscription.filter({ user_id: userId }).catch(() => []);
  console.log('[briefing] push target:', userId, '| subs:', subscriptions?.length || 0, '| fcm:', subscriptions?.filter((s) => s.endpoint?.startsWith('fcm://')).length || 0);
  if (!subscriptions || subscriptions.length === 0) return { sent: 0, skipped: 0, removed: 0, errors: [] };

  const notifData = { title, body, url: url || '/', tag: tag || undefined };

  const hasFcmSub = subscriptions.some((s) => s.endpoint?.startsWith('fcm://'));
  let fcmAccessToken = null;
  if (hasFcmSub && fcmServiceAccountJson && fcmProjectId) fcmAccessToken = await getFcmAccessToken(fcmServiceAccountJson);

  let sent = 0, removed = 0, skipped = 0;
  const errors = [];
  if (hasFcmSub) console.log('[briefing] FCM token acquired:', !!fcmAccessToken, '| vapid keys:', !!vapidPublicKey, !!vapidPrivateKey, !!vapidSubject);
  await Promise.all(subscriptions.map(async (sub) => {
    const isFCM = sub.endpoint?.startsWith('fcm://');
    // FCM (APK) subs always receive pushes; web subs honor device profiles.
    if (!isFCM) {
      const profile = sub.device_identifier ? deviceProfiles[sub.device_identifier] : null;
      if (profile && profile.notifications_enabled === false) { skipped++; return; }
    }
    if (isFCM) {
      const fcmToken = sub.endpoint.replace('fcm://', '');
      if (!fcmToken) { skipped++; return; }
      if (!fcmAccessToken || !fcmProjectId) { errors.push({ error: 'FCM not configured or token exchange failed' }); return; }
      try {
        // FCM v1 field placement: icon/color are ANDROID-only fields — they
        // must live in android.notification, NOT the generic notification
        // object. Putting them in the top-level notification causes
        // 400 INVALID_ARGUMENT ("Unknown name 'icon'/'color': Cannot find field")
        // which silently rejected every non-interactive push to the APKs.
        const fcmMessage = {
          token: fcmToken,
          data: { url: url || '/' },
          android: { priority: 'high', notification: { tag: tag || undefined, channel_id: 'default', icon: 'ic_stat_notify', color: '#22c55e' } },
        };
        fcmMessage.notification = { title, body };
        const fcmResponse = await fetch(`https://fcm.googleapis.com/v1/projects/${fcmProjectId}/messages:send`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${fcmAccessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: fcmMessage }),
        });
        if (fcmResponse.ok) sent++;
        else {
          const errBody = await fcmResponse.json().catch(() => ({}));
          const errStatus = errBody?.error?.status;
          if (errStatus === 'NOT_FOUND' || errStatus === 'UNREGISTERED') {
            await base44.asServiceRole.entities.PushSubscription.delete(sub.id).catch(() => {});
            removed++;
          } else errors.push({ error: `FCM HTTP ${fcmResponse.status}: ${JSON.stringify(errBody).slice(0, 300)}` });
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
  // NOTE (Sep 15 2026): list errors are NOT swallowed anymore. A transient
  // list failure used to look like an empty catalog — which produced a
  // FALSE "clean slate" briefing. Now the error propagates and the run
  // fails loudly with no pushes sent.
  const res = await base44.asServiceRole.entities[entityName].list(sortField, limit);
  const rows = Array.isArray(res) ? res : (Array.isArray(res?.data) ? res.data : []);
  rows.forEach((r) => { const u = unwrapEntityRecord(r); if (u) out.push(u); });
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

// Find the App Owner's platform user. The owner resolves through the
// PLATFORM user database (role === 'admin' — the same check the frontend
// isAppOwner() uses), NOT the AppUser entity. Fallbacks stay in the platform
// DB too: role filter, then the pinned platform user id (Robert T — several
// users carry the 'admin' app role in AppUser, so only the platform DB is
// authoritative).
const OWNER_PLATFORM_USER_ID = '68570f3cd01bfa2d2408a9d7';
async function listPlatformUsers(base44) {
  const usersRes = await base44.asServiceRole.entities.User.list({ limit: 500 }).catch((e) => {
    console.log('[briefing] User.list error:', e?.message || String(e));
    return [];
  });
  const users = (Array.isArray(usersRes) ? usersRes : (Array.isArray(usersRes?.data) ? usersRes.data : []))
    .map((r) => unwrapEntityRecord(r)).filter(Boolean);
  console.log('[briefing] platform users listed:', users.length, '| admins:', users.filter((u) => u?.role === 'admin').length, '| roles sample:', users.slice(0, 5).map((u) => u?.role).join(','));
  return users;
}
async function findOwner(base44) {
  try {
    const users = await listPlatformUsers(base44);
    const admins = users.filter((u) => u?.role === 'admin');
    if (admins.length === 1) return admins[0];
    if (admins.length > 1) {
      // Multiple platform users carry role=admin (e.g. the workspace's
      // Superagent platform user shares the owner's name). The REAL app
      // owner is the one with registered push devices in this app.
      for (const a of admins) {
        const subs = await base44.asServiceRole.entities.PushSubscription.filter({ user_id: a.id }).catch(() => []);
        if (Array.isArray(subs) && subs.length) {
          console.log('[briefing] owner disambiguated by push subscriptions:', a.id, `(${(subs || []).length} subs)`);
          return a;
        }
      }
      // No admin has subs — prefer the pinned platform id.
      const pinnedAdmin = admins.find((a) => a.id === OWNER_PLATFORM_USER_ID);
      if (pinnedAdmin) return pinnedAdmin;
    }
  } catch (err) {
    console.log('[briefing] User.list path failed:', err?.message || String(err));
  }
  try {
    const adminRes = await base44.asServiceRole.entities.User.filter({ role: 'admin' }).catch((e) => {
      console.log('[briefing] User.filter(role=admin) error:', e?.message || String(e));
      return [];
    });
    const admins = (Array.isArray(adminRes) ? adminRes : []).map((r) => unwrapEntityRecord(r)).filter(Boolean);
    console.log('[briefing] User.filter(role=admin):', admins.length);
    if (admins.length) return admins[0];
  } catch (err) {
    console.log('[briefing] User.filter path failed:', err?.message || String(err));
  }
  try {
    const byIdRes = await base44.asServiceRole.entities.User.filter({ id: OWNER_PLATFORM_USER_ID }).catch((e) => {
      console.log('[briefing] User.filter(id) error:', e?.message || String(e));
      return [];
    });
    const byId = (Array.isArray(byIdRes) ? byIdRes : []).map((r) => unwrapEntityRecord(r)).filter(Boolean);
    console.log('[briefing] User.filter(pinned id):', byId.length, byId.map((u) => u?.role).join(','));
    if (byId.length) return byId[0];
  } catch (err) {
    console.log('[briefing] User.filter by-id path failed:', err?.message || String(err));
  }
  // Final fallback: the pinned platform user id. NOTE — the service role
  // CANNOT read the platform User collection (User.list/filter return 0
  // records from unauthenticated scheduled functions), so the role=admin
  // lookup above can never resolve here. The pinned id IS the platform
  // user with role=admin (Robert T) — a platform-DB identity, not an
  // AppUser one — verified by his devices' push subscriptions.
  console.log('[briefing] platform DB lookups unavailable — using pinned platform owner id');
  return { id: OWNER_PLATFORM_USER_ID, full_name: 'App Owner' };
}

async function handleBriefing(base44, params = {}) {
  const dryRun = !!params?.dry_run;
  // Optional: send a TEST push to a single driver only (targets a real driver's real data)
  const testDriverId = params?.test_driver_id || null;
  // Optional: send ONLY the App Owner copy (full cross-driver briefing) and
  // skip all driver pushes — used to test/demo the owner briefing without
  // re-notifying every driver.
  const ownerOnly = !!params?.owner_only;
  const startedAt = Date.now();

  // App Owner (Robert T): now receives the SAME treatment as drivers — in-app
  // message + push notification — in addition to the full multi-driver briefing
  // the owner workflow sends via WhatsApp (owner requested all channels).
  // 1. Outstanding CODs (source of truth — pruned daily to mirror live Square catalog)
  console.log('[briefing] invoked. dry_run:', dryRun, '| test_driver_id:', testDriverId || 'none');
  let catalogItems = [];
  try {
    catalogItems = await listAll(base44, 'SquareCatalogItems', '-updated_date');
  } catch (err) {
    // LOUD failure: never send a briefing based on a failed read. If the
    // catalog list fails we cannot tell "clean" from "broken" — abort the
    // whole run so no driver/owner gets a false briefing.
    console.log('[briefing] FATAL: SquareCatalogItems list failed:', err?.message || String(err));
    return { success: false, error: `SquareCatalogItems list failed: ${err?.message || String(err)}`, duration_ms: Date.now() - startedAt };
  }
  console.log('[briefing] catalog items (raw):', catalogItems.length);
  // Dedupe: the reconciler sweep's bookkeeping upsert can create duplicate rows
  // for the same COD when its existence-check filter fails under platform strain
  // (429/500 storms) — Sep 10 2026 every outstanding COD had 3-5 rows, which made
  // every driver briefing (and the owner copy) list each COD 3-5 times. One row
  // per delivery_id; rows without a delivery_id dedupe on name+amount+store.
  const seenCodKeys = new Set();
  catalogItems = catalogItems.filter((x) => {
    const key = x.delivery_id || `nodel:${x.item_name}|${x.amount}|${x.store_id}`;
    if (seenCodKeys.has(key)) return false;
    seenCodKeys.add(key);
    return true;
  });
  console.log('[briefing] catalog items (deduped):', catalogItems.length);
  if (!catalogItems.length) {
    // Clean slate still reaches the owner in-app (same as the WhatsApp copy —
    // "the COD slate is clean"). Drivers have nothing to collect, so no
    // driver pushes go out.
    let cleanOwnerPush = null;
    if (!dryRun) {
      try {
        const owner = await findOwner(base44);
        if (owner?.id) {
          const today = new Date().toISOString().slice(0, 10);
          const ownerName = owner.full_name || owner.name || 'App Owner';
          const cleanBody = `${ownerOnly ? 'TEST — ' : ''}COD Briefing — ${shortDate(today)}\n\nNo outstanding CODs — the slate is clean.`;
          let cleanMessageId = null;
          try {
            const created = await base44.asServiceRole.entities.Message.create({
              sender_id: 'cod_briefing',
              sender_name: 'COD Briefing',
              receiver_id: owner.id,
              receiver_name: ownerName,
              conversation_id: ['cod_briefing', owner.id].sort().join('_'),
              content: cleanBody,
              read: false,
              message_type: 'text',
            });
            cleanMessageId = created?.id || null;
          } catch (err) {
            console.log('[briefing] clean Message.create failed:', err?.message || String(err));
          }
          const chatUrl = `/?openChat=cod_briefing&openChatName=${encodeURIComponent('COD Briefing')}`;
          const result = await sendPushToUser(base44, owner.id, `${ownerOnly ? 'TEST — ' : ''}COD Briefing (All Drivers) — ${shortDate(today)}`, cleanBody, chatUrl, `cod-briefing-owner-${today}`);
          cleanOwnerPush = { owner_id: owner.id, owner_name: ownerName, in_app_message_id: cleanMessageId, ...result };
          console.log('[briefing] clean-slate owner push result:', JSON.stringify(result));
        }
      } catch (err) {
        console.log('[briefing] clean-slate owner briefing failed:', err?.message || String(err));
      }
    }
    return { success: true, dry_run: dryRun, owner_only: ownerOnly, drivers: [], totals: { drivers: 0, items: 0, amount: 0 }, pushes: [], owner_push: cleanOwnerPush, message: 'No outstanding CODs.', duration_ms: Date.now() - startedAt };
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
  if (!dryRun && !ownerOnly) {
    const today = new Date().toISOString().slice(0, 10);
    for (const g of driverBriefings) {
      if (testDriverId && g.driver_id !== testDriverId) continue;
      // Money column alignment: pad every amount (incl. the total) to the same
      // width so the $ signs and decimals line up down the list.
      const moneyStrs = g.items.map((it) => (Number(it.amount) || 0).toFixed(2));
      const totalStr = (Math.round(g.total * 100) / 100).toFixed(2);
      const moneyWidth = Math.max(totalStr.length, ...moneyStrs.map((m) => m.length));
      const lines = g.items.map((it, idx) => `${shortDate(it.delivery_date)} ${it.store_abbreviation || (it.store_name || '').slice(0, 12)} · $${moneyStrs[idx].padStart(moneyWidth)} · ${it.patient_name}`);
      const body = [
        `${g.count} uncollected COD${g.count === 1 ? '' : 's'} totaling $${totalStr}.`,
        '',
        ...lines,
        '',
        'Collect at your earliest convenience.',
      ].join('\n');
      const title = `${testDriverId ? 'TEST — ' : ''}COD Briefing — ${shortDate(today)}`;
      // In-app message: create a Message record from the system 'COD Briefing'
      // sender so the driver also gets the briefing inside the app's messaging
      // section. The push's deep link opens that exact thread on tap.
      // Thread shape mirrors the existing system_updates pattern:
      // conversation_id = sorted([senderId, driverId]).join('_'), display name
      // comes from the denormalized sender_name (no user record needed).
      let inAppMessageId = null;
      try {
        const created = await base44.asServiceRole.entities.Message.create({
          sender_id: 'cod_briefing',
          sender_name: 'COD Briefing',
          receiver_id: g.driver_id,
          receiver_name: g.driver_name,
          conversation_id: ['cod_briefing', g.driver_id].sort().join('_'),
          content: body,
          read: false,
          message_type: 'text',
        });
        inAppMessageId = created?.id || null;
      } catch (err) {
        console.log('[briefing] Message.create failed:', err?.message || String(err));
      }
      const chatUrl = `/?openChat=cod_briefing&openChatName=${encodeURIComponent('COD Briefing')}`;
      const result = await sendPushToUser(base44, g.driver_id, title, body, chatUrl, `cod-briefing-${today}`);
      pushes.push({ driver_id: g.driver_id, driver_name: g.driver_name, in_app_message_id: inAppMessageId, ...result });
      console.log('[briefing] push result:', JSON.stringify({ driver: g.driver_name, ...result }));
      await sleep(150);
    }
  }

  // ── App Owner copy (Sep 15 2026): the owner asked to receive the FULL
  // cross-driver briefing as an in-app push + in-app Message (previously the
  // only push they got was their own driver-specific one when they drive; the
  // full version only went out via the WhatsApp workflow broadcast). The
  // owner is identified by platform User.role === 'admin' — the same check
  // the frontend isAppOwner() uses. Sent as the same 'COD Briefing' system
  // thread shape drivers get.
  let ownerPush = null;
  if (!dryRun) {
    try {
      const owner = await findOwner(base44);
      if (owner?.id) {
        const today = new Date().toISOString().slice(0, 10);
        const ownerName = owner.full_name || owner.name || 'App Owner';
        // Compose full per-driver breakdown with aligned money columns
        const moneyStrsAll = driverBriefings.flatMap((g) => g.items.map((it) => (Number(it.amount) || 0).toFixed(2)));
        const totalAll = (Math.round(driverBriefings.reduce((sm, g) => sm + g.total, 0) * 100) / 100).toFixed(2);
        const moneyWidth = Math.max(totalAll.length, ...(moneyStrsAll.length ? moneyStrsAll : ['0']));
        const lines = [];
        for (const g of driverBriefings) {
          const gTotal = (Math.round(g.total * 100) / 100).toFixed(2);
          lines.push(`${String(g.driver_name).toUpperCase()} — ${g.count} COD${g.count === 1 ? '' : 's'}, $${gTotal}`);
          g.items.forEach((it, idx) => {
            const amt = (Number(it.amount) || 0).toFixed(2);
            lines.push(`${shortDate(it.delivery_date)} ${(it.store_abbreviation || it.store_name || '—').slice(0, 12)} · $${amt.padStart(moneyWidth)} · ${it.patient_name}`);
          });
          lines.push('');
        }
        if (unassigned.length) lines.push(`Unassigned: ${unassigned.length} COD${unassigned.length === 1 ? '' : 's'} (no driver on delivery)`, '');
        lines.push(`TOTAL: ${catalogItems.length} COD${catalogItems.length === 1 ? '' : 's'}, $${totalAll}`);
        const failedPushes = pushes.filter((p) => p.sent === 0 || (p.errors && p.errors.length));
        if (failedPushes.length) lines.push(`Push failed: ${failedPushes.map((p) => p.driver_name).join(', ')}`);
        const ownerBody = [
          `${ownerOnly ? 'TEST — ' : ''}COD Briefing — ${shortDate(today)}`,
          '',
          ...lines,
        ].join('\n');
        // In-app Message: same system-thread shape as the driver copies
        let ownerMessageId = null;
        try {
          const created = await base44.asServiceRole.entities.Message.create({
            sender_id: 'cod_briefing',
            sender_name: 'COD Briefing',
            receiver_id: owner.id,
            receiver_name: ownerName,
            conversation_id: ['cod_briefing', owner.id].sort().join('_'),
            content: ownerBody,
            read: false,
            message_type: 'text',
          });
          ownerMessageId = created?.id || null;
        } catch (err) {
          console.log('[briefing] owner Message.create failed:', err?.message || String(err));
        }
        const chatUrl = `/?openChat=cod_briefing&openChatName=${encodeURIComponent('COD Briefing')}`;
        const title = `${ownerOnly ? 'TEST — ' : ''}COD Briefing (All Drivers) — ${shortDate(today)}`;
        const result = await sendPushToUser(base44, owner.id, title, ownerBody, chatUrl, `cod-briefing-owner-${today}`);
        ownerPush = { owner_id: owner.id, owner_name: ownerName, in_app_message_id: ownerMessageId, ...result };
        console.log('[briefing] owner push result:', JSON.stringify(result));
      } else {
        console.log('[briefing] No App Owner found (platform role admin) — owner push skipped.');
        ownerPush = { skipped: true, reason: 'No platform user with role=admin found' };
      }
    } catch (err) {
      console.log('[briefing] owner briefing failed:', err?.message || String(err));
      ownerPush = { error: err?.message || String(err) };
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
    owner_only: ownerOnly,
    generated_at: new Date().toISOString(),
    totals,
    drivers: driverBriefings,
    unassigned_items: unassigned,
    pushes,
    owner_push: ownerPush,
    duration_ms: Date.now() - startedAt,
  };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    await requireAdminIfAuthenticated(base44);
    let params = {};
    try { params = await req.json(); } catch { params = {}; }
    if (params?.diagnostic_users) {
      const users = await listPlatformUsers(base44);
      return Response.json({
        count: users.length,
        admins: users.filter((u) => u?.role === 'admin').map((u) => ({ id: u.id, role: u.role, full_name: u.full_name })),
        sample: users.slice(0, 10).map((u) => ({ id: u.id, role: u.role, full_name: u?.full_name, keys: Object.keys(u).slice(0, 20) })),
      });
    }
    if (params?.diagnostic_fcm_project) {
      const fcmServiceAccountJson = Deno.env.get('FCM_SERVICE_ACCOUNT_JSON');
      let projectId = null, clientEmail = null;
      try { const c = JSON.parse(fcmServiceAccountJson || '{}'); projectId = c.project_id; clientEmail = c.client_email; } catch {}
      return Response.json({ fcm_service_account_configured: !!fcmServiceAccountJson, project_id: projectId, client_email: clientEmail });
    }
    return Response.json(await handleBriefing(base44, params));
  } catch (error) {
    const status = error?.status || 500;
    return Response.json({ error: error?.message || 'Internal Server Error' }, { status });
  }
});