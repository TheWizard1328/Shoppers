// driverCodBriefing — 9pm EVENING driver COD wrap-up (moved from 9am mornings).
// Audience: ONLY drivers who worked today (>=1 non-cancelled, non-cycling
// delivery today). Each such driver gets a push + in-app Message with the
// day's COD summary: COLLECTED today (cash/debit/cheque, per-item amounts)
// plus anything still outstanding (today's uncollected + older CODs from
// the SquareCatalogItems source of truth). Returns the full grouped JSON so
// the app-owner briefing can be composed and delivered (agent/WhatsApp).
// At 9pm MDT, UTC has already rolled over — the briefing date is computed in
// America/Edmonton, never from new Date().toISOString().
//
// Params: { dry_run?, owner_only?, test_driver_id? } — dry_run=true computes everything but does
// NOT send pushes (used for test runs).
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

// Edmonton-local date — the briefing runs at 9pm MDT, when UTC has already
// rolled to the next day, so new Date().toISOString() would give tomorrow.
function edmontonToday() {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date());
}

async function handleBriefing(base44, params = {}) {
  const dryRun = !!params?.dry_run;
  const testDriverId = params?.test_driver_id || null;
  const ownerOnly = !!params?.owner_only;
  const startedAt = Date.now();

  const today = edmontonToday();

  console.log('[briefing] invoked. dry_run:', dryRun, '| test_driver_id:', testDriverId || 'none', '| date:', today);

  // 1. Today's deliveries — define who WORKED today and the day's COD activity.
  const todaysDeliveriesRaw = await base44.asServiceRole.entities.Delivery.filter({ delivery_date: today }).catch((e) => {
    console.log('[briefing] FATAL: today Delivery.filter failed:', e?.message || String(e));
    return null;
  });
  if (todaysDeliveriesRaw === null) {
    return { success: false, error: 'Today Delivery.filter failed — no briefing sent (cannot distinguish clean from broken).', duration_ms: Date.now() - startedAt };
  }
  const todaysDeliveries = (Array.isArray(todaysDeliveriesRaw) ? todaysDeliveriesRaw : []).map(unwrapEntityRecord).filter(Boolean);
  console.log('[briefing] today\'s deliveries:', todaysDeliveries.length);

  // Worked today = ≥1 non-cancelled, non-cycling-marker delivery today.
  const worked = new Map(); // driverId -> { driver_id, driver_name, deliveries }
  for (const d of todaysDeliveries) {
    if (!d?.driver_id || d.status === 'cancelled' || d.is_cycling_marker) continue;
    if (!worked.has(d.driver_id)) worked.set(d.driver_id, { driver_id: d.driver_id, driver_name: d.driver_name || 'Unknown driver', deliveries: 0 });
    worked.get(d.driver_id).deliveries += 1;
  }
  if (testDriverId) {
    if (!worked.has(testDriverId)) {
      return { success: false, error: `Test driver ${testDriverId} did not work today (${today}) — no briefing data.`, duration_ms: Date.now() - startedAt };
    }
    for (const k of Array.from(worked.keys())) if (k !== testDriverId) worked.delete(k);
  }
  console.log('[briefing] worked-today drivers:', Array.from(worked.values()).map((w) => w.driver_name).join(', ') || 'none');

  // 2. Day COD activity per worked driver (from today's deliveries).
  const patientIds = new Set(); const storeIdsNeeded = new Set();
  const codTodayByDriver = new Map(); // driverId -> [{ amount, collected, types, patient_id, store_id, delivery_id }]
  for (const d of todaysDeliveries) {
    if (!d?.driver_id || d.status === 'cancelled' || d.is_cycling_marker) continue;
    const codAmt = Number(d.cod_total_amount_required) || 0;
    if (codAmt <= 0) continue;
    const pays = (Array.isArray(d.cod_payments) ? d.cod_payments : []).filter((p) => Number(p?.amount || 0) > 0);
    const types = Array.from(new Set(pays.map((p) => String(p?.type || 'Unknown'))));
    if (!codTodayByDriver.has(d.driver_id)) codTodayByDriver.set(d.driver_id, []);
    codTodayByDriver.get(d.driver_id).push({ delivery_id: d.id, amount: codAmt, collected: pays.length > 0, types, patient_id: d.patient_id || null, store_id: d.store_id || null });
    if (d.patient_id) patientIds.add(d.patient_id);
    if (d.store_id) storeIdsNeeded.add(d.store_id);
  }

  // 3. OLDER outstanding CODs (SquareCatalogItems — source of truth, pruned daily).
  let catalogItems = [];
  try {
    catalogItems = await listAll(base44, 'SquareCatalogItems', '-updated_date');
  } catch (err) {
    console.log('[briefing] FATAL: SquareCatalogItems list failed:', err?.message || String(err));
    return { success: false, error: `SquareCatalogItems list failed: ${err?.message || String(err)}`, duration_ms: Date.now() - startedAt };
  }
  const seenCodKeys = new Set();
  catalogItems = catalogItems.filter((x) => {
    const key = x.delivery_id || `nodel:${x.item_name}|${x.amount}|${x.store_id}`;
    if (seenCodKeys.has(key)) return false;
    seenCodKeys.add(key);
    return true;
  });
  console.log('[briefing] catalog items (deduped):', catalogItems.length);

  // Map catalog items → deliveries (driver + date)
  const deliveryIds = catalogItems.map((x) => x.delivery_id).filter(Boolean);
  const olderDeliveries = await fetchByIds(base44, 'Delivery', deliveryIds);
  const olderDeliveryById = new Map(olderDeliveries.map((d) => [d?.id, d]));
  const olderByDriver = new Map(); // driverId -> [{ amount, patient_name, delivery_date }]
  const unassigned = [];
  for (const item of catalogItems) {
    const del = item.delivery_id ? olderDeliveryById.get(item.delivery_id) : null;
    const entry = {
      item_name: item.item_name,
      amount: Number(item.amount) || 0,
      delivery_date: item.delivery_date || del?.delivery_date || null,
      patient_name: extractPatientName(item.item_name),
      delivery_status: del?.status || null,
    };
    if (!del?.driver_id) { unassigned.push(entry); continue; }
    // Only items from BEFORE today belong here (today's items are covered by
    // the day section), and only for drivers who actually worked today.
    if (!worked.has(del.driver_id)) continue;
    if (String(entry.delivery_date || '') >= today) continue;
    if (!olderByDriver.has(del.driver_id)) olderByDriver.set(del.driver_id, []);
    olderByDriver.get(del.driver_id).push(entry);
  }

  // 4. Patient + store lookups for compact line rendering.
  const patients = await fetchByIds(base44, 'Patient', Array.from(patientIds));
  const patientNameById = new Map(patients.map((p) => [p.id, p.full_name || p.name || 'Unknown']));
  const stores = await fetchByIds(base44, 'Store', Array.from(storeIdsNeeded));
  const storeAbbrById = new Map(stores.map((s) => [s.id, s.abbreviation || (s.name || '').slice(0, 2)]));

  // 5. Per-driver briefing objects (worked-today drivers only).
  const driverBriefings = [];
  for (const w of worked.values()) {
    const cods = (codTodayByDriver.get(w.driver_id) || []).map((c) => ({
      amount: c.amount,
      collected: c.collected,
      types: c.types,
      patient_name: (c.patient_id && patientNameById.get(c.patient_id)) || 'Unknown',
      store_abbreviation: c.store_id ? (storeAbbrById.get(c.store_id) || '—') : '—',
    }));
    const collected = cods.filter((c) => c.collected);
    const uncollectedToday = cods.filter((c) => !c.collected);
    const older = olderByDriver.get(w.driver_id) || [];
    const outstandingTotal = uncollectedToday.reduce((s, c) => s + c.amount, 0) + older.reduce((s, c) => s + c.amount, 0);
    driverBriefings.push({
      driver_id: w.driver_id,
      driver_name: w.driver_name,
      deliveries_today: w.deliveries,
      collected_today: { count: collected.length, amount: Math.round(collected.reduce((s, c) => s + c.amount, 0) * 100) / 100, items: collected },
      uncollected_today: { count: uncollectedToday.length, amount: Math.round(uncollectedToday.reduce((s, c) => s + c.amount, 0) * 100) / 100, items: uncollectedToday },
      older_outstanding: { count: older.length, amount: Math.round(older.reduce((s, c) => s + c.amount, 0) * 100) / 100, items: older.sort((a, b) => String(a.delivery_date || '').localeCompare(String(b.delivery_date || ''))) },
      outstanding_total: Math.round(outstandingTotal * 100) / 100,
    });
  }
  driverBriefings.sort((a, b) => (b.collected_today.amount + b.outstanding_total) - (a.collected_today.amount + a.outstanding_total));

  // 6. Driver pushes (skip in dry-run / owner_only) — only drivers with
  // something to report (collected, uncollected, or older outstanding).
  const pushes = [];
  if (!dryRun && !ownerOnly) {
    for (const g of driverBriefings) {
      const hasCollected = g.collected_today.count > 0;
      const outstandingItems = [
        ...g.uncollected_today.items.map((c) => ({ amount: c.amount, label: `${shortDate(today)}(${c.store_abbreviation})-${c.patient_name}` })),
        ...g.older_outstanding.items.map((c) => ({ amount: c.amount, label: `${shortDate(c.delivery_date)}(${c.patient_name})` })),
      ];
      const outstandingCount = g.uncollected_today.count + g.older_outstanding.count;
      if (!hasCollected && outstandingCount === 0) continue; // worked today, zero COD activity — no push
      const moneyStrs = [
        ...g.collected_today.items.map((c) => c.amount.toFixed(2)),
        ...outstandingItems.map((c) => c.amount.toFixed(2)),
      ];
      const biggestStr = Math.max(g.collected_today.amount, g.outstanding_total).toFixed(2);
      const mw = Math.max(biggestStr.length, ...(moneyStrs.length ? moneyStrs : ['0']));
      const lines = [];
      if (hasCollected) {
        lines.push(`Collected today: ${g.collected_today.count} COD${g.collected_today.count === 1 ? '' : 's'}, $ ${g.collected_today.amount.toFixed(2).padStart(mw)}`);
        for (const c of g.collected_today.items) lines.push(`$ ${c.amount.toFixed(2).padStart(mw)} · ${c.types.join('/')} · ${c.patient_name}`);
        lines.push('');
      }
      if (outstandingCount > 0) {
        lines.push(`Still to collect: ${outstandingCount} COD${outstandingCount === 1 ? '' : 's'}, $ ${g.outstanding_total.toFixed(2).padStart(mw)}`);
        for (const c of outstandingItems) lines.push(`$ ${c.amount.toFixed(2).padStart(mw)} · ${c.label}`);
      } else {
        lines.push('Nothing outstanding — clean slate.');
      }
      const body = [
        `${testDriverId ? 'TEST — ' : ''}COD Wrap-Up — ${shortDate(today)}`,
        '',
        ...lines,
      ].join('\n');
      const title = `${testDriverId ? 'TEST — ' : ''}COD Wrap-Up — ${shortDate(today)}`;
      // In-app Message copy in the same system 'COD Briefing' thread shape.
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

  // ── App Owner copy: full per-driver breakdown of the day's COD wrap-up ──
  let ownerPush = null;
  if (!dryRun) {
    try {
      const owner = await findOwner(base44);
      if (owner?.id) {
        const ownerName = owner.full_name || owner.name || 'App Owner';
        const allC = driverBriefings.flatMap((g) => g.collected_today.items);
        const allO = driverBriefings.flatMap((g) => [
          ...g.uncollected_today.items.map((c) => ({ amount: c.amount, label: `${shortDate(today)}(${c.store_abbreviation})-${c.patient_name}` })),
          ...g.older_outstanding.items.map((c) => ({ amount: c.amount, label: `${shortDate(c.delivery_date)}(${c.patient_name})` })),
        ]);
        const moneyStrsAll = [...allC.map((c) => c.amount.toFixed(2)), ...allO.map((c) => c.amount.toFixed(2))];
        const cTotal = Math.round(driverBriefings.reduce((s, g) => s + g.collected_today.amount, 0) * 100) / 100;
        const oTotal = Math.round(driverBriefings.reduce((s, g) => s + g.outstanding_total, 0) * 100) / 100;
        const mw = Math.max(cTotal.toFixed(2).length, oTotal.toFixed(2).length, ...(moneyStrsAll.length ? moneyStrsAll : ['0']));
        const lines = [];
        for (const g of driverBriefings) {
          const hadCods = g.collected_today.count + g.uncollected_today.count + g.older_outstanding.count > 0;
          if (!hadCods) { lines.push(`${String(g.driver_name).toUpperCase()} — worked today (${g.deliveries_today} stops), no COD activity`); lines.push(''); continue; }
          lines.push(`${String(g.driver_name).toUpperCase()} — collected $ ${g.collected_today.amount.toFixed(2).padStart(mw)} (${g.collected_today.count}) · outstanding $ ${g.outstanding_total.toFixed(2).padStart(mw)} (${g.uncollected_today.count + g.older_outstanding.count})`);
          for (const c of g.collected_today.items) lines.push(`$ ${c.amount.toFixed(2).padStart(mw)} · ${c.types.join('/')} · ${c.patient_name}`);
          for (const c of g.uncollected_today.items) lines.push(`$ ${c.amount.toFixed(2).padStart(mw)} · OUTSTANDING · ${shortDate(today)}(${c.store_abbreviation})-${c.patient_name}`);
          for (const c of g.older_outstanding.items) lines.push(`$ ${c.amount.toFixed(2).padStart(mw)} · OUTSTANDING · ${shortDate(c.delivery_date)}(${c.patient_name})`);
          lines.push('');
        }
        if (unassigned.length) lines.push(`Unassigned: ${unassigned.length} COD${unassigned.length === 1 ? '' : 's'} (no driver on delivery)`, '');
        lines.push(`DAY TOTALS — collected: $ ${cTotal.toFixed(2).padStart(mw)} (${allC.length}) · outstanding: $ ${oTotal.toFixed(2).padStart(mw)} (${allO.length})`);
        const failedPushes = pushes.filter((p) => p.sent === 0 || (p.errors && p.errors.length));
        if (failedPushes.length) lines.push(`Push failed: ${failedPushes.map((p) => p.driver_name).join(', ')}`);
        const ownerBody = [
          `${ownerOnly ? 'TEST — ' : ''}COD Wrap-Up (All Drivers) — ${shortDate(today)}`,
          '',
          ...lines,
        ].join('\n');
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
        const title = `${ownerOnly ? 'TEST — ' : ''}COD Wrap-Up (All Drivers) — ${shortDate(today)}`;
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
    worked_drivers: driverBriefings.length,
    collected_count: driverBriefings.reduce((s, g) => s + g.collected_today.count, 0),
    collected_amount: Math.round(driverBriefings.reduce((s, g) => s + g.collected_today.amount, 0) * 100) / 100,
    outstanding_count: driverBriefings.reduce((s, g) => s + g.uncollected_today.count + g.older_outstanding.count, 0),
    outstanding_amount: Math.round(driverBriefings.reduce((s, g) => s + g.outstanding_total, 0) * 100) / 100,
  };

  return {
    success: true,
    dry_run: dry_run,
    owner_only: ownerOnly,
    briefing_date: today,
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