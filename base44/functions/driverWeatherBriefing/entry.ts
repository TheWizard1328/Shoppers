// driverWeatherBriefing — 9am DAILY driver briefing (weather + day preview).
// Runs every day (weekends included). Audience: drivers who are SCHEDULED for
// the briefing date OR are the DEFAULT driver for the date — mirroring
// DriverScheduleCalendar's resolution:
//   1. Schedule-resolved: per-store slots for today's day-of-week
//      (weekday_am/pm, saturday_am/pm, sunday_am/pm), with date-specific
//      DriverScheduleOverride taking priority over the store's default driver.
//      '__booked_off__' / '__none__' means nobody works that slot.
//   2. Delivery-driven: drivers with non-cancelled patient/InterStore
//      deliveries today (the calendar's second binding) — a driver with a
//      route today always gets the briefing even if no schedule slot is set.
//
// Each driver receives a push: current weather + today's high/low/precip/wind
// for their city, stop count, first pickup time, and outstanding COD total.
// Weather: Open-Meteo (free, no API key).
//
// Params: { dry_run?: boolean, test_driver_id?: string }
// Push delivery is INLINED (web-push VAPID + FCM v1) — same constraints as
// driverCodBriefing (unauthenticated scheduled runs).
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import webpush from 'npm:web-push@3.6.7';

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }

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
  const signature = base64UrlEncode(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claimSet}.${signature}`)));
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

// ── Push sending (inlined parity with driverCodBriefing) ─────────────────
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
  if (!subscriptions || subscriptions.length === 0) return { sent: 0, skipped: 0, removed: 0, errors: [] };

  const notifData = { title, body, url: url || '/', tag: tag || undefined };

  const hasFcmSub = subscriptions.some((s) => s.endpoint?.startsWith('fcm://'));
  let fcmAccessToken = null;
  if (hasFcmSub && fcmServiceAccountJson && fcmProjectId) fcmAccessToken = await getFcmAccessToken(fcmServiceAccountJson);

  let sent = 0, removed = 0, skipped = 0;
  const errors = [];
  await Promise.all(subscriptions.map(async (sub) => {
    const isFCM = sub.endpoint?.startsWith('fcm://');
    if (!isFCM) {
      const profile = sub.device_identifier ? deviceProfiles[sub.device_identifier] : null;
      if (profile && profile.notifications_enabled === false) { skipped++; return; }
    }
    if (isFCM) {
      const fcmToken = sub.endpoint.replace('fcm://', '');
      if (!fcmToken) { skipped++; return; }
      if (!fcmAccessToken || !fcmProjectId) { errors.push({ error: 'FCM not configured or token exchange failed' }); return; }
      try {
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
async function listAll(base44, entityName, sortField, limit = 2000) {
  const out = [];
  const res = await base44.asServiceRole.entities[entityName].list(sortField, limit).catch(() => []);
  const rows = Array.isArray(res) ? res : (Array.isArray(res?.data) ? res.data : []);
  rows.forEach((r) => { const u = unwrapEntityRecord(r); if (u) out.push(u); });
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
function edmontonToday() {
  // YYYY-MM-DD in America/Edmonton
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date());
}
function edmontonDow(dateStr) {
  return new Date(`${dateStr}T12:00:00-06:00`).getUTCDay(); // noon Edmonton anchor
}
function slotKeysFor(dow) {
  if (dow === 0) return ['sunday_am', 'sunday_pm'];
  if (dow === 6) return ['saturday_am', 'saturday_pm'];
  return ['weekday_am', 'weekday_pm'];
}
function defaultDriverIdFor(store, slotKey) {
  return ({ weekday_am: store.weekday_am_driver_id, weekday_pm: store.weekday_pm_driver_id, saturday_am: store.saturday_am_driver_id, saturday_pm: store.saturday_pm_driver_id, sunday_am: store.sunday_am_driver_id, sunday_pm: store.sunday_pm_driver_id })[slotKey] || null;
}
function slotEnabledFor(store, slotKey) {
  return !!({ weekday_am: store.weekday_am_enabled, weekday_pm: store.weekday_pm_enabled, saturday_am: store.saturday_am_enabled, saturday_pm: store.saturday_pm_enabled, sunday_am: store.sunday_am_enabled, sunday_pm: store.sunday_pm_enabled })[slotKey];
}
function slotStartFor(store, slotKey) {
  return ({ weekday_am: store.weekday_am_start, weekday_pm: store.weekday_pm_start, saturday_am: store.saturday_am_start, saturday_pm: store.saturday_pm_start, sunday_am: store.sunday_am_start, sunday_pm: store.sunday_pm_start })[slotKey] || null;
}
const money = (v) => `$${(Number(v) || 0).toFixed(2)}`;

// WMO weather interpretation codes → short text
function wmoText(code) {
  const m = {
    0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
    56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
    66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
    77: 'Snow grains', 80: 'Rain showers', 81: 'Rain showers', 82: 'Violent showers',
    85: 'Snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm w/ hail', 99: 'Severe thunderstorm',
  };
  return m[code] || 'Mixed';
}

// ── Weather (Open-Meteo, cached per city) ────────────────────────────────
const _weatherCache = new Map(); // cityId -> { current, daily, fetchedAt }
async function getWeatherForCity(cityId, lat, lon) {
  if (_weatherCache.has(cityId) && Date.now() - _weatherCache.get(cityId).fetchedAt < 10 * 60 * 1000) return _weatherCache.get(cityId);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,snowfall_sum,weather_code` +
    `&timezone=America%2FEdmonton&forecast_days=1`;
  const res = await fetch(url).catch(() => null);
  if (!res || !res.ok) return null;
  const j = await res.json().catch(() => null);
  if (!j?.current || !j?.daily) return null;
  const entry = {
    current: { temp: Math.round(j.current.temperature_2m), feels: Math.round(j.current.apparent_temperature), text: wmoText(j.current.weather_code), wind: Math.round(j.current.wind_speed_10m) },
    daily: { high: Math.round(j.daily.temperature_2m_max?.[0]), low: Math.round(j.daily.temperature_2m_min?.[0]), precipProb: j.daily.precipitation_probability_max?.[0] ?? null, snowCm: j.daily.snowfall_sum?.[0] ?? 0, text: wmoText(j.daily.weather_code?.[0]) },
    fetchedAt: Date.now(),
  };
  _weatherCache.set(cityId, entry);
  return entry;
}

// ── Main ────────────────────────────────────────────────────────────────
async function handleBriefing(base44, params = {}) {
  const dryRun = !!params?.dry_run;
  const testDriverId = params?.test_driver_id || null;
  const startedAt = Date.now();

  const today = edmontonToday();
  const dow = edmontonDow(today);

  // 1. Load schedule + reference data
  const [stores, overrides, appUsers, cities, todaysDeliveries] = await Promise.all([
    listAll(base44, 'Store', 'name'),
    base44.asServiceRole.entities.DriverScheduleOverride.filter({ date: today }).catch(() => []),
    listAll(base44, 'AppUser', 'full_name'),
    listAll(base44, 'City', 'name'),
    base44.asServiceRole.entities.Delivery.filter({ delivery_date: today }).catch(() => []),
  ]);
  const overrideMap = new Map();
  for (const o of (overrides?.data || overrides || [])) {
    const rec = unwrapEntityRecord(o) || o;
    if (rec?.date && rec?.store_id && rec?.slot_key) overrideMap.set(`${rec.date}|${rec.store_id}|${rec.slot_key}`, rec);
  }
  const appUserById = new Map();
  for (const u of appUsers) if (u?.user_id) appUserById.set(u.user_id, u);
  const cityById = new Map(cities.map((c) => [c.id, c]));

  // 2. Resolve today's working drivers
  // scheduleMap: driverId -> { slotStart, storeName, storeCityId }
  const scheduleMap = new Map();
  const noteDriver = (driverId, store, slotKey) => {
    if (!driverId || driverId === '__booked_off__' || driverId === '__none__') return;
    if (!scheduleMap.has(driverId)) scheduleMap.set(driverId, {});
    const slotStart = slotStartFor(store, slotKey);
    const schedEntry = scheduleMap.get(driverId);
    if (slotStart && (!schedEntry.slotStart || slotStart < schedEntry.slotStart)) schedEntry.slotStart = slotStart;
    if (store?.city_id) schedEntry.storeCityId = store.city_id;
  };
  for (const store of stores) {
    for (const sk of slotKeysFor(dow)) {
      if (!slotEnabledFor(store, sk)) continue;
      const override = overrideMap.get(`${today}|${store.id}|${sk}`);
      const effective = override ? override.driver_id : defaultDriverIdFor(store, sk);
      noteDriver(effective, store, sk);
    }
  }

  // Delivery-driven: drivers with patient/InterStore deliveries today
  const deliveryDriverIds = new Set();
  const routeDeliveriesByDriver = new Map(); // driverId -> non-cancelled non-cycling deliveries
  for (const dRaw of (todaysDeliveries?.data || todaysDeliveries || [])) {
    const d = unwrapEntityRecord(dRaw) || dRaw;
    if (!d?.driver_id) continue;
    if (d.status === 'cancelled') continue;
    const isPatient = !!(d.patient_id && d.patient_id !== '');
    const isInterStore = !!(d._interstore_source_id || d._interstore_dest_id);
    if (!isPatient && !isInterStore) continue;
    if (d.is_cycling_marker) continue;
    deliveryDriverIds.add(d.driver_id);
    if (!routeDeliveriesByDriver.has(d.driver_id)) routeDeliveriesByDriver.set(d.driver_id, []);
    routeDeliveriesByDriver.get(d.driver_id).push(d);
  }

  // 3. Outstanding COD totals per driver (dedupe parity with driverCodBriefing)
  let codTotalByDriver = new Map();
  let catalogItems = await listAll(base44, 'SquareCatalogItems', '-updated_date');
  const seenCodKeys = new Set();
  catalogItems = catalogItems.filter((x) => {
    const key = x.delivery_id || `nodel:${x.item_name}|${x.amount}|${x.store_id}`;
    if (seenCodKeys.has(key)) return false;
    seenCodKeys.add(key);
    return true;
  });
  if (catalogItems.length) {
    const deliveryIds = catalogItems.map((x) => x.delivery_id).filter(Boolean);
    const codDeliveries = await fetchByIds(base44, 'Delivery', deliveryIds);
    const deliveryById = new Map(codDeliveries.map((d) => [d?.id, d]));
    for (const item of catalogItems) {
      const del = item.delivery_id ? deliveryById.get(item.delivery_id) : null;
      if (!del?.driver_id) continue;
      codTotalByDriver.set(del.driver_id, (codTotalByDriver.get(del.driver_id) || 0) + (Number(item.amount) || 0));
    }
  }

  // 4. Build per-driver briefings
  const allDriverIds = new Set([...scheduleMap.keys(), ...deliveryDriverIds]);
  if (testDriverId) {
    allDriverIds.clear();
    if (scheduleMap.has(testDriverId) || deliveryDriverIds.has(testDriverId)) allDriverIds.add(testDriverId);
  }

  const briefings = [];
  const weatherFailures = [];
  for (const driverId of allDriverIds) {
    const au = appUserById.get(driverId);
    const driverName = au?.full_name || au?.name || (routeDeliveriesByDriver.get(driverId)?.[0]?.driver_name) || 'Driver';
    const sched = scheduleMap.get(driverId) || {};

    // City resolution: driver's assigned city → store's city → first city
    const cityId = au?.city_id || (Array.isArray(au?.city_ids) ? au.city_ids[0] : null) || sched.storeCityId || cities[0]?.id || null;
    const city = cityById.get(cityId) || null;
    let weather = null;
    if (city && Number.isFinite(Number(city.latitude)) && Number.isFinite(Number(city.longitude))) {
      weather = await getWeatherForCity(city.id, city.latitude, city.longitude);
      if (!weather) weatherFailures.push(driverName);
    } else {
      weatherFailures.push(driverName);
    }

    // Day preview
    const myDeliveries = routeDeliveriesByDriver.get(driverId) || [];
    const stopCount = myDeliveries.length;
    let firstPickup = sched.slotStart || null;
    for (const d of myDeliveries) {
      if (d.delivery_time_start && (!firstPickup || d.delivery_time_start < firstPickup)) firstPickup = d.delivery_time_start;
    }
    const codTotal = codTotalByDriver.get(driverId) || 0;

    // Compose body
    const lines = [];
    if (weather) {
      const w = weather;
      lines.push(`${w.current.text}, ${w.current.temp}°C (feels ${w.current.feels}°C)`);
      lines.push(`Today: ${w.daily.text}, high ${w.daily.high}° / low ${w.daily.low}°`);
      const bits = [];
      if (w.daily.precipProb != null) bits.push(`${w.daily.precipProb}% precip`);
      if (w.daily.snowCm && w.daily.snowCm > 0) bits.push(`${w.daily.snowCm} cm snow`);
      bits.push(`wind ${w.current.wind} km/h`);
      lines.push(bits.join(' · '));
      if (w.daily.low <= -10) lines.push('❄️ Cold day — bundle up.');
    } else {
      lines.push('Weather unavailable');
    }
    if (stopCount > 0) {
      lines.push(`Route: ${stopCount} stop${stopCount === 1 ? '' : 's'}${firstPickup ? ` · first stop ${firstPickup}` : ''}`);
    } else if (sched.slotStart) {
      lines.push(`Shift starts ${sched.slotStart}`);
    }
    if (codTotal > 0) lines.push(`COD to collect: ${money(codTotal)}`);
    if (lines.length === 1 && lines[0] === 'Weather unavailable') lines.push('No route or shift data for today.');

    briefings.push({
      driver_id: driverId,
      driver_name: driverName,
      city: city?.name || null,
      weather: weather ? { ...weather.current, high: weather.daily.high, low: weather.daily.low, precip: weather.daily.precipProb, snowCm: weather.daily.snowCm, forecast: weather.daily.text } : null,
      stop_count: stopCount,
      first_pickup: firstPickup,
      cod_total: Math.round(codTotal * 100) / 100,
      push_body: lines.join('\n'),
      scheduled: scheduleMap.has(driverId),
      delivery_driven: deliveryDriverIds.has(driverId),
    });
  }

  // 5. Push
  const pushes = [];
  if (!dryRun) {
    for (const b of briefings) {
      const title = `Morning Briefing — ${today.slice(5).replace('-', '/')}`;
      const push = await sendPushToUser(base44, b.driver_id, title, b.push_body, '/', `morning-briefing-${today}`);
      pushes.push({ driver_id: b.driver_id, driver_name: b.driver_name, sent: push.sent, skipped: push.skipped, removed: push.removed, errors: push.errors });
    }
  }

  return {
    success: true,
    dry_run: dryRun,
    generated_at: new Date().toISOString(),
    briefing_date: today,
    totals: { drivers: briefings.length, pushed: pushes.filter((p) => p.sent > 0).length },
    weather_failures: weatherFailures,
    drivers: briefings,
    pushes,
    duration_ms: Date.now() - startedAt,
  };
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  await requireAdminIfAuthenticated(base44);
  const params = await req.json().catch(() => ({}));
  return Response.json(await handleBriefing(base44, params));
});
