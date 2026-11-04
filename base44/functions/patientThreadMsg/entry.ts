import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import webpush from 'npm:web-push@3.6.7';

/**
 * patientThreadMsg — patient <-> driver thread writes (owner report Nov 3 2026).
 *
 * WHY THIS EXISTS: patientPush could not be updated (git pushes deploy every
 * other function, but that one kept serving its old code), and its driver
 * lookups were broken: Delivery.driver_id / DriverDailyActivity.driver_id store
 * the AUTH user id, which lives on AppUser.user_id, while AppUser.id is a
 * DIFFERENT record id. Every lookup therefore missed, so the portal read every
 * driver as off duty AND a patient message aimed at a driver silently fell back
 * into the pharmacy (store) thread with the store staff alerted instead.
 *
 * This function owns the DRIVER-THREAD side of patient messaging only. The
 * store thread keeps using patientPush.
 *
 * Thread shape: conversation_id `driver:<driverId>:patient:<patientId>`,
 * patient_id + driver_id set, patient rows sender_id `patient:<patientId>`.
 *
 * Actions:
 *   directory  → drivers this patient may message + live duty status
 *   send       → public: patient writes into a DRIVER thread (pushes the driver)
 *   markRead   → public: read receipt for one driver thread
 *   staffSend  → AUTH: pharmacy reply inside a driver thread (pushes patient + driver)
 *   notifyDriver → AUTH: alert one driver's devices
 */

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import webpush from 'npm:web-push@3.6.7';


// ── Driver identity (owner report Nov 3 2026) ────────────────────────────
// Delivery.driver_id and DriverDailyActivity.driver_id store the AUTH user id,
// which lives on AppUser.user_id — AppUser.id is a DIFFERENT record id. Keying
// the old lookup by AppUser.id therefore never matched a real driver, so the
// portal always read duty_status 'off_duty' AND patient→driver sends silently
// fell back to the store thread (the driver profile resolved to null).
// This map indexes every AppUser by BOTH keys.
async function loadAppUsersByDriverId(base44: any): Promise<Map<string, any>> {
  const map = new Map<string, any>();
  const users = await base44.asServiceRole.entities.AppUser.filter({}, '-created_date', 500).catch(() => []);
  for (const u of users || []) {
    if (u?.user_id) map.set(String(u.user_id), u);
    if (u?.id) map.set(String(u.id), u);
  }
  return map;
}

// ── FULL DIRECTORY SEARCH (owner request Nov 3 2026) ──────────────────────
// The old `directory` action could only ever return drivers who had ALREADY
// delivered to this patient, so the portal search found nobody new. The owner
// needs the full AppUser list (every active driver) and the full store list, so
// a patient can reach whoever is out driving now, or any pharmacy.
const AP_RANK_ACTIVE = 0;

async function loadAllAppUsers(base44: any): Promise<any[]> {
  return await base44.asServiceRole.entities.AppUser.filter({}, '-created_date', 500).catch(() => []) || [];
}

function userIsDriver(user: any): boolean {
  // Store/dispatcher accounts also carry a driver_status ('online'), which used
  // to make every pharmacy profile look like a driver. The role is the signal;
  // a real driver without the role still qualifies through delivery history.
  const roles = Array.isArray(user?.app_roles) ? user.app_roles : [];
  return roles.includes('driver');
}

function userIsActiveStaff(user: any): boolean {
  return user?.status === 'active' || (!user?.status && user?.driver_status !== 'inactive');
}

function userDisplayName(user: any): string {
  return user?.user_name || user?.full_name || '';
}

function storeStaffUserIds(users: any[], storeId: string): string[] {
  const ids = new Set<string>();
  for (const u of users || []) {
    if (!u) continue;
    if (u.status === 'inactive') continue;
    const roles = Array.isArray(u.app_roles) ? u.app_roles : [];
    const isStaff = roles.some((r: string) => ['dispatcher', 'store_owner', 'admin', 'app_owner'].includes(r));
    if (!isStaff) continue;
    const stores = Array.isArray(u.store_ids) ? u.store_ids : [];
    if (stores.map(String).includes(String(storeId))) {
      if (u.user_id) ids.add(String(u.user_id));
      else if (u.id) ids.add(String(u.id));
    }
  }
  return Array.from(ids);
}

// ── FCM (APK devices) — OAuth2 access token from the service account ────
let _cachedFcmToken: { token: string; expiresAt: number } | null = null;

function base64UrlEncode(input: ArrayBuffer | string): string {
  let bytes: Uint8Array;
  if (typeof input === 'string') bytes = new TextEncoder().encode(input);
  else bytes = new Uint8Array(input);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function getFcmAccessToken(serviceAccountJson: string): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  if (_cachedFcmToken && _cachedFcmToken.expiresAt - 60 > now) return _cachedFcmToken.token;

  let creds: any;
  try {
    creds = JSON.parse(serviceAccountJson);
  } catch {
    return null;
  }
  const { client_email, private_key } = creds || {};
  if (!client_email || !private_key) return null;

  const signingInput = `${base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64UrlEncode(JSON.stringify({
    iss: client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }))}`;

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${base64UrlEncode(signature)}`;

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!tokenResponse.ok) return null;
  const tokenData = await tokenResponse.json();
  _cachedFcmToken = { token: tokenData.access_token, expiresAt: now + (tokenData.expires_in || 3600) };
  return tokenData.access_token;
}

async function sendFcmPush(token: string, notification: any): Promise<{ ok: boolean; status?: string }> {
  const serviceAccountJson = Deno.env.get('FCM_SERVICE_ACCOUNT_JSON');
  if (!serviceAccountJson) return { ok: false, status: 'NO_CONFIG' };
  let projectId: string | null = null;
  try { projectId = JSON.parse(serviceAccountJson).project_id; } catch { return { ok: false, status: 'BAD_CONFIG' }; }
  const accessToken = await getFcmAccessToken(serviceAccountJson);
  if (!accessToken || !projectId) return { ok: false, status: 'NO_TOKEN' };

  const body = JSON.stringify({
    message: {
      token,
      notification: { title: notification.title, body: notification.body || '' },
      data: Object.fromEntries(Object.entries({
        url: notification.url || '/',
        tag: notification.tag || 'rxdeliver-patient',
        timestamp: String(Date.now()),
        patient_id: notification.patient_id || '',
      }).map(([k, v]) => [k, String(v)])),
      android: {
        priority: 'high',
        notification: { tag: notification.tag || 'rxdeliver-patient', channel_id: 'default', icon: 'ic_stat_notify', color: '#22c55e' },
      },
    },
  });

  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body,
  });
  if (res.ok) return { ok: true };
  const errBody = await res.json().catch(() => ({}));
  return { ok: false, status: errBody?.error?.status || `HTTP_${res.status}` };
}

/** Push to every device registered for a Base44 user (web push + FCM). */
async function pushToUser(base44: any, userId: string, notification: any) {
  const vapidPub = Deno.env.get('VAPID_PUBLIC_KEY');
  const vapidPriv = Deno.env.get('VAPID_PRIVATE_KEY');
  const vapidSubj = Deno.env.get('VAPID_SUBJECT');

  const subs = await base44.asServiceRole.entities.PushSubscription
    .filter({ user_id: userId })
    .catch(() => []);
  if (!subs || subs.length === 0) return { sent: 0, removed: 0, reason: 'no_devices' };

  const payload = {
    title: notification.title || 'RxDeliver',
    body: notification.body || '',
    url: notification.url || '/',
    tag: notification.tag || 'rxdeliver-patient',
    timestamp: Date.now(),
    requireInteraction: false,
    data: { patient_id: notification.patient_id || '' },
  };

  let sent = 0, removed = 0;
  for (const sub of subs) {
    if (sub.endpoint?.startsWith('fcm://')) {
      const token = sub.endpoint.replace('fcm://', '');
      if (!token) continue;
      const result = await sendFcmPush(token, { ...payload, patient_id: notification.patient_id });
      if (result.ok) sent++;
      else if (result.status === 'NOT_FOUND' || result.status === 'UNREGISTERED') {
        await base44.asServiceRole.entities.PushSubscription.delete(sub.id).catch(() => {});
        removed++;
      }
      continue;
    }
    if (!vapidPub || !vapidPriv || !vapidSubj) continue;
    try {
      webpush.setVapidDetails(vapidSubj, vapidPub, vapidPriv);
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh_key, auth: sub.auth_key } },
        JSON.stringify(payload)
      );
      sent++;
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        await base44.asServiceRole.entities.PushSubscription.delete(sub.id).catch(() => {});
        removed++;
      }
    }
  }
  return { sent, removed };
}

/** Alberta (permanent UTC-6) calendar date, used for "today's driver". */
function albertaTodayKey() {
  return new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Alert the store's staff phones (dispatchers of that store + admins). */

// ── helpers ───────────────────────────────────────────────────────────────
const patientSenderIdOf = (patientId: string) => `patient:${patientId}`;
const driverThreadKey = (driverId: string, patientId: string) => `driver:${driverId}:patient:${patientId}`;

async function resolveDriverName(base44: any, driverId: string, deliveries: any[]) {
  const map = await loadAppUsersByDriverId(base44);
  const user = map.get(String(driverId));
  if (user) return user.user_name || user.full_name || 'Driver';
  const stamped = (deliveries || []).map((d) => d?.driver_name).find(Boolean);
  return stamped || 'Driver';
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    const action = payload?.action || '';
    const { patient_id, driver_id } = payload;

    // ── Full directory search: every active driver + every store ───────────
    if (action === 'searchDirectory') {
      if (!patient_id) return Response.json({ ok: false, error: 'patient_id is required' }, { status: 400 });

      const query = String(payload.query || '').trim().toLowerCase();
      const today = albertaTodayKey();

      const patient = await base44.asServiceRole.entities.Patient.get(patient_id).catch(() => null);
      if (!patient) return Response.json({ ok: false, error: 'Patient not found' }, { status: 404 });

      const users = await loadAllAppUsers(base44);

      // Drivers the patient has actually had, so those rows can be labelled.
      const priorRows = await base44.asServiceRole.entities.Delivery
        .filter({ patient_id }, '-delivery_date', 200)
        .catch(() => []);
      const priorDriverIds = new Set((priorRows || []).map((d: any) => String(d?.driver_id || '')).filter(Boolean));
      // Pharmacies this patient has actually had a delivery from (owner request
      // Nov 3 2026): the list stays short — home pharmacy + past pharmacies —
      // and other stores only appear when the patient searches for them.
      const priorStoreIds = new Set((priorRows || []).map((d: any) => String(d?.store_id || '')).filter(Boolean));
      const todayDriverIds = new Set(
        (priorRows || []).filter((d: any) => String(d?.delivery_date || '') === today)
          .map((d: any) => String(d?.driver_id || '')).filter(Boolean)
      );

      const drvKey = (u: any) => String(u?.user_id || u?.id || '');
      const drivers = users
        .filter((u: any) => userIsActiveStaff(u) && drvKey(u))
        .map((u: any) => {
          const id = drvKey(u);
          const status = String(u?.driver_status || 'off_duty');
          return {
            driver_id: id,
            driver_name: userDisplayName(u) || 'Driver',
            duty_status: ['on_duty', 'on_break', 'off_duty'].includes(status) ? status : 'off_duty',
            is_current: todayDriverIds.has(id),
            is_prior: priorDriverIds.has(id),
            _is_driver_role: userIsDriver(u),
          };
        })
        // A real driver by role, or somebody who actually drove for this patient.
        .filter((d: any) => d._is_driver_role || d.is_prior || d.is_current)
        .map((d: any) => { const { _is_driver_role, ...row } = d; return row; })
        // No query → only the drivers this patient has actually had (the list is
        // a message inbox, not a phone book). With a query → any active driver
        // whose name matches, whatever their duty, so a new driver is reachable.
        .filter((d: any) => {
          const onDuty = d.duty_status === 'on_duty' || d.duty_status === 'on_break';
          if (!query) return d.is_prior || d.is_current;
          return d.driver_name.toLowerCase().includes(query)
            || (query.length >= 3 && d.driver_name.toLowerCase().split(/\s+/).some((w: string) => w.startsWith(query)));
        })
        .sort((a: any, b: any) => {
          const score = (d: any) => (d.is_current ? 0 : (d.duty_status === 'on_duty' ? 1 : (d.duty_status === 'on_break' ? 2 : (d.is_prior ? 3 : 4))));
          if (score(a) !== score(b)) return score(a) - score(b);
          return a.driver_name.localeCompare(b.driver_name);
        })
        .slice(0, query ? 25 : 12);

      // Stores: the whole active list, the patient's own first.
      const storeRows = await base44.asServiceRole.entities.Store.filter({}, 'name', 200).catch(() => []);
      const stores = (storeRows || [])
        .filter((st: any) => String(st?.status || 'active') !== 'inactive')
        .filter((st: any) => {
          if (!query) return true;
          const hay = `${st?.name || ''} ${st?.abbreviation || ''} pharmacy`.toLowerCase();
          return hay.includes(query);
        })
        .map((st: any) => ({
          store_id: st.id,
          name: st.name || st.abbreviation || 'Pharmacy',
          abbreviation: String(st.abbreviation || '').toUpperCase(),
          city_id: st.city_id || '',
          is_home: String(st.id) === String(patient.store_id || ''),
          is_prior: priorStoreIds.has(String(st.id)),
        }))
        // No query: home pharmacy + the pharmacies this patient has used.
        .filter((st: any) => query || st.is_home || st.is_prior)
        .sort((a: any, b: any) => (a.is_home === b.is_home ? a.name.localeCompare(b.name) : (a.is_home ? -1 : 1)))
        .slice(0, query ? 25 : 12);

      return Response.json({ ok: true, today, query, drivers, stores, v: 'ptm2' });
    }

    // ── Which drivers may this patient message, and are they on duty? ──────
    if (action === 'directory') {
      if (!patient_id) return Response.json({ ok: false, error: 'patient_id is required' }, { status: 400 });

      const today = albertaTodayKey();
      const deliveries = await base44.asServiceRole.entities.Delivery
        .filter({ patient_id }, '-delivery_date', 200)
        .catch(() => []);
      const userByDriverId = await loadAppUsersByDriverId(base44);

      const byDriver = new Map<string, any>();
      for (const d of deliveries || []) {
        if (!d?.driver_id) continue;
        const user = userByDriverId.get(String(d.driver_id));
        const entry = byDriver.get(d.driver_id) || {
          driver_id: d.driver_id,
          driver_name: d.driver_name || user?.user_name || user?.full_name || 'Driver',
          last_delivery_date: '',
          is_current: false,
          is_past: false,
          duty_status: 'off_duty',
          resolved_profile: !!user,
        };
        const date = String(d.delivery_date || '');
        if (date > entry.last_delivery_date) entry.last_delivery_date = date;
        if (date === today) entry.is_current = true;
        if (date < today) entry.is_past = true;
        byDriver.set(d.driver_id, entry);
      }

      const drivers = Array.from(byDriver.values()).map((d: any) => {
        const user = userByDriverId.get(String(d.driver_id));
        const status = String(user?.driver_status || 'off_duty');
        return { ...d, duty_status: ['on_duty', 'on_break', 'off_duty'].includes(status) ? status : 'off_duty' };
      }).sort((a: any, b: any) => {
        if (a.is_current !== b.is_current) return a.is_current ? -1 : 1;
        return String(b.last_delivery_date).localeCompare(String(a.last_delivery_date));
      });

      // Last-resort duty signal: an OPEN activity segment today means working.
      const unresolved = drivers.filter((d: any) => !d.resolved_profile).map((d: any) => String(d.driver_id));
      if (unresolved.length) {
        const rows = await base44.asServiceRole.entities.DriverDailyActivity
          .filter({ activity_date: today }, '-activity_date', 300)
          .catch(() => []);
        const openIds = new Set((rows || [])
          .filter((r: any) => unresolved.includes(String(r.driver_id))
            && (Array.isArray(r.activity_segments) ? r.activity_segments : [])
              .some((seg: any) => seg && seg.start_time && !seg.end_time))
          .map((r: any) => String(r.driver_id)));
        drivers.forEach((d: any) => { if (openIds.has(String(d.driver_id))) d.duty_status = 'on_duty'; });
      }
      drivers.forEach((d: any) => { delete d.resolved_profile; });

      return Response.json({ ok: true, today, drivers, v: 'ptm1' });
    }

    // Everything below needs the patient row.
    if (!patient_id) return Response.json({ ok: false, error: 'patient_id is required' }, { status: 400 });
    const patient = await base44.asServiceRole.entities.Patient.get(patient_id).catch(() => null);
    if (!patient) return Response.json({ ok: false, error: 'Patient not found' }, { status: 404 });

    // ── Patient read receipt for one driver thread ─────────────────────────
    if (action === 'markRead') {
      if (!driver_id) return Response.json({ ok: false, error: 'driver_id is required' }, { status: 400 });
      const rows = await base44.asServiceRole.entities.Message
        .filter({ patient_id, driver_id }, '-created_date', 100)
        .catch(() => []);
      const unread = (rows || []).filter((m: any) => !m.read && m.sender_id !== patientSenderIdOf(patient_id));
      for (const m of unread) {
        await base44.asServiceRole.entities.Message.update(m.id, { read: true }).catch(() => {});
      }
      return Response.json({ ok: true, marked: unread.length });
    }

    const text = String(payload.content || '').trim().slice(0, 2000);

    // ── Pharmacy reply inside a driver thread (authenticated staff) ────────
    if (action === 'staffSend') {
      const user = await base44.auth.me();
      if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
      if (!driver_id) return Response.json({ ok: false, error: 'driver_id is required' }, { status: 400 });
      if (!text) return Response.json({ ok: false, error: 'Message text is required' }, { status: 400 });

      const prior = await base44.asServiceRole.entities.Delivery
        .filter({ patient_id, driver_id }, '-delivery_date', 5)
        .catch(() => []);
      const driverName = await resolveDriverName(base44, driver_id, prior || []);

      const created = await base44.asServiceRole.entities.Message.create({
        sender_id: user.id,
        sender_name: user.full_name || user.user_name || 'Pharmacy',
        receiver_id: patientSenderIdOf(patient_id),
        receiver_name: patient.full_name || 'Patient',
        conversation_id: driverThreadKey(driver_id, patient_id),
        content: text,
        message_type: 'text',
        read: false,
        patient_id,
        store_id: patient.store_id || '',
        driver_id,
      });

      const preview = text.length > 140 ? `${text.slice(0, 137)}...` : text;
      const patientAlert = await pushToUser(base44, patientSenderIdOf(patient_id), {
        title: `${user.full_name || user.user_name || 'Pharmacy'} · ${driverName}`,
        body: preview,
        url: '/patient-portal',
        tag: `driver-thread-${patient_id}`,
        patient_id,
      }).catch(() => ({ sent: 0 }));
      const driverAlert = await pushToUser(base44, driver_id, {
        title: `${user.full_name || user.user_name || 'Pharmacy'} · ${patient.full_name || 'Patient'}`,
        body: preview,
        url: '/',
        tag: `driver-thread-${patient_id}`,
        patient_id,
      }).catch(() => ({ sent: 0 }));

      return Response.json({ ok: true, message: created, alerted: { patient: patientAlert, driver: driverAlert } });
    }

    // ── Authenticated push to one driver ───────────────────────────────────
    if (action === 'notifyDriver') {
      const user = await base44.auth.me();
      if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
      if (!driver_id || !payload.title) return Response.json({ ok: false, error: 'driver_id and title are required' }, { status: 400 });
      const result = await pushToUser(base44, driver_id, {
        title: payload.title,
        body: payload.body || '',
        url: payload.url || '/',
        tag: payload.tag || `driver-thread-${patient_id || ''}`,
        patient_id: patient_id || '',
      }).catch(() => ({ sent: 0 }));
      return Response.json({ ok: true, ...result });
    }

    // ── Patient writes into a DRIVER thread (public portal) ────────────────
    if (action === 'send') {
      if (!driver_id) return Response.json({ ok: false, error: 'driver_id is required' }, { status: 400 });
      if (!text) return Response.json({ ok: false, error: 'Message text is required' }, { status: 400 });

      // WHO MAY BE MESSAGED (owner request Nov 3 2026): any driver who has
      // delivered to this patient, OR any driver who is on duty right now — the
      // portal now lists every active driver, so the send has to match.
      const prior = await base44.asServiceRole.entities.Delivery
        .filter({ patient_id, driver_id }, '-delivery_date', 5)
        .catch(() => []);
      const userByDriverId = await loadAppUsersByDriverId(base44);
      const targetUser = userByDriverId.get(String(driver_id)) || null;
      const targetRoles = Array.isArray(targetUser?.app_roles) ? targetUser.app_roles : [];
      const targetIsRealDriver = !!targetUser
        && userIsActiveStaff(targetUser)
        && (targetRoles.includes('driver') || (prior || []).length > 0);
      if (!targetIsRealDriver) {
        return Response.json({ ok: false, error: 'That driver is not available to message' }, { status: 403 });
      }
      const driverName = await resolveDriverName(base44, driver_id, prior || []);

      const created = await base44.asServiceRole.entities.Message.create({
        sender_id: patientSenderIdOf(patient_id),
        sender_name: patient.full_name || 'Patient',
        receiver_id: driver_id,
        receiver_name: driverName,
        conversation_id: driverThreadKey(driver_id, patient_id),
        content: text,
        message_type: 'text',
        read: false,
        patient_id,
        store_id: patient.store_id || '',
        driver_id,
      });

      const alerted = await pushToUser(base44, driver_id, {
        title: `Message from ${patient.full_name || 'a patient'}`,
        body: text.length > 140 ? `${text.slice(0, 137)}...` : text,
        url: '/',
        tag: `driver-thread-${patient_id}`,
        patient_id,
      }).catch(() => ({ sent: 0 }));

      return Response.json({ ok: true, message: created, alerted });
    }

    // ── Patient writes into a STORE thread (public portal) ────────────────
    // Each pharmacy keeps its own thread on the same patient conversation, told
    // apart by Message.store_id, and only THAT store's staff is pushed.
    if (action === 'sendStore' || action === 'markStoreRead') {
      const storeId = String(payload.store_id || '');
      if (!storeId) return Response.json({ ok: false, error: 'store_id is required' }, { status: 400 });

      const rows = await base44.asServiceRole.entities.Message
        .filter({ patient_id, store_id: storeId }, '-created_date', 100)
        .catch(() => []);

      if (action === 'markStoreRead') {
        const unread = (rows || []).filter((m: any) => !m.read && m.sender_id !== patientSenderIdOf(patient_id));
        for (const m of unread) {
          await base44.asServiceRole.entities.Message.update(m.id, { read: true }).catch(() => {});
        }
        return Response.json({ ok: true, marked: unread.length });
      }

      if (!text) return Response.json({ ok: false, error: 'Message text is required' }, { status: 400 });
      const store = await base44.asServiceRole.entities.Store.get(storeId).catch(() => null);
      const storeName = store?.name || 'Pharmacy';

      const created = await base44.asServiceRole.entities.Message.create({
        sender_id: patientSenderIdOf(patient_id),
        sender_name: patient.full_name || 'Patient',
        receiver_id: '',
        receiver_name: storeName,
        conversation_id: `patient:${patient_id}`,
        content: text,
        message_type: 'text',
        read: false,
        patient_id,
        store_id: storeId,
        driver_id: '',
      });

      const users = await loadAllAppUsers(base44);
      const staffIds = storeStaffUserIds(users, storeId).slice(0, 12);
      let sent = 0;
      for (const staffId of staffIds) {
        const res = await pushToUser(base44, staffId, {
          title: `New message from ${patient.full_name || 'a patient'}`,
          body: text.length > 140 ? `${text.slice(0, 137)}...` : text,
          url: '/',
          tag: `patient-store-${patient_id}`,
          patient_id,
        }).catch(() => ({ sent: 0 }));
        sent += res?.sent || 0;
      }

      return Response.json({ ok: true, message: created, alerted: { sent, staff: staffIds.length } });
    }

    return Response.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
});
