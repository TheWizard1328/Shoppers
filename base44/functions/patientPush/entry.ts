import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import webpush from 'npm:web-push@3.6.7';

/**
 * patientPush — patient portal messaging support (push + service-role writes).
 *
 * Patients are NOT Base44 users, so:
 *   • their device subscriptions live in PushSubscription under
 *     user_id = `patient:<patientId>`
 *   • their Message writes and read receipts run service-role here, because the
 *     portal is a public page with no Base44 user session
 *
 * THREAD SHAPES (see src/components/messaging/patientThreads.jsx)
 *   store thread  : conversation_id `patient:<patientId>`, driver_id empty.
 *                   Every dispatcher of that store shares it.
 *   driver thread : conversation_id `driver:<driverId>:patient:<patientId>`,
 *                   patient_id + driver_id set.
 *   patient rows use sender_id `patient:<patientId>`.
 *
 * Actions (body.action):
 *   vapid            → VAPID public key (public by design, no auth needed)
 *   register         → save/refresh this device's subscription for a patient
 *   unregister       → drop this device's subscription
 *   driverDirectory  → drivers this patient may message (current + past), with
 *                      their live duty status (on_duty / on_break / off_duty)
 *   patientSend      → patient writes a message (store thread or driver thread)
 *                      and the right people are pushed in the same call
 *   patientMarkRead  → service-role read receipts for one thread
 *   notifyStaff      → portal-triggered alert to the store's staff phones
 *   send             → AUTHENTICATED staff/driver push to the patient's devices
 */

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
async function notifyStoreStaff(base44: any, { patient_id, store_id, title, body, url }: any) {
  const users = await base44.asServiceRole.entities.AppUser.filter({}, '-created_date', 200).catch(() => []);
  const recipients = (users || []).filter((u: any) => {
    if (!u?.id) return false;
    const roles = Array.isArray(u.app_roles) ? u.app_roles : [];
    const isAdmin = roles.includes('admin') || roles.includes('app_owner') || u.role === 'admin';
    const stores = Array.isArray(u.store_ids) ? u.store_ids : (u.store_id ? [u.store_id] : []);
    if (store_id) return isAdmin || stores.includes(store_id);
    return isAdmin;
  }).slice(0, 15);

  let sent = 0, removed = 0;
  for (const staffUser of recipients) {
    const result = await pushToUser(base44, staffUser.id, {
      title: title || 'New patient message',
      body: body || '',
      url: url || '/',
      tag: `patient-thread-${patient_id || 'x'}`,
      patient_id,
    });
    sent += result.sent || 0;
    removed += result.removed || 0;
  }
  return { sent, removed, recipients: recipients.length };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    const action = String(payload.action || 'send');
    const ownerKey = (patientId: string) => `patient:${patientId}`;

    if (action === 'vapid') {
      return Response.json({ publicKey: Deno.env.get('VAPID_PUBLIC_KEY') || null });
    }

    // ── Device registration (no auth: the portal is a public page) ──────────
    if (action === 'register' || action === 'unregister') {
      const { patient_id, subscription, device_identifier, user_agent } = payload;
      if (!patient_id) return Response.json({ ok: false, error: 'patient_id is required' }, { status: 400 });

      let patient = null;
      try {
        patient = await base44.asServiceRole.entities.Patient.get(patient_id);
      } catch (_) {
        return Response.json({ ok: false, error: 'Patient not found' }, { status: 404 });
      }
      if (!patient || patient.status === 'inactive') {
        return Response.json({ ok: false, error: 'Patient not found' }, { status: 404 });
      }

      const userKey = ownerKey(patient_id);
      const endpoint = subscription?.endpoint || '';
      const existing = await base44.asServiceRole.entities.PushSubscription
        .filter({ user_id: userKey })
        .catch(() => []);

      if (action === 'unregister') {
        const doomed = (existing || []).filter((s: any) => !endpoint || s.endpoint === endpoint);
        for (const sub of doomed) {
          await base44.asServiceRole.entities.PushSubscription.delete(sub.id).catch(() => {});
        }
        return Response.json({ ok: true, removed: doomed.length });
      }

      if (!endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
        return Response.json({ ok: false, error: 'A valid push subscription is required' }, { status: 400 });
      }

      const record = {
        user_id: userKey,
        user_name: patient.full_name || 'Patient',
        endpoint,
        p256dh_key: subscription.keys.p256dh,
        auth_key: subscription.keys.auth,
        device_identifier: device_identifier || '',
        user_agent: user_agent || '',
        last_used_at: new Date().toISOString(),
      };

      const match = (existing || []).find((s: any) => s.endpoint === endpoint);
      if (match) await base44.asServiceRole.entities.PushSubscription.update(match.id, record);
      else await base44.asServiceRole.entities.PushSubscription.create(record);

      const all = await base44.asServiceRole.entities.PushSubscription
        .filter({ user_id: userKey }, '-last_used_at', 20)
        .catch(() => []);
      for (const sub of (all || []).slice(4)) {
        await base44.asServiceRole.entities.PushSubscription.delete(sub.id).catch(() => {});
      }

      return Response.json({ ok: true, devices: Math.min((all || []).length, 4) });
    }

    // ── Which drivers may this patient message, and are they on duty? ───────
    if (action === 'driverDirectory') {
      const { patient_id } = payload;
      if (!patient_id) return Response.json({ ok: false, error: 'patient_id is required' }, { status: 400 });

      const today = albertaTodayKey();
      const deliveries = await base44.asServiceRole.entities.Delivery
        .filter({ patient_id }, '-delivery_date', 200)
        .catch(() => []);
      const users = await base44.asServiceRole.entities.AppUser.filter({}, '-created_date', 200).catch(() => []);
      const userById = new Map((users || []).map((u: any) => [u.id, u]));

      const byDriver = new Map<string, any>();
      for (const d of deliveries || []) {
        if (!d?.driver_id) continue;
        const entry = byDriver.get(d.driver_id) || {
          driver_id: d.driver_id,
          driver_name: d.driver_name || userById.get(d.driver_id)?.full_name || 'Driver',
          last_delivery_date: '',
          is_current: false,
          is_past: false,
        };
        const date = String(d.delivery_date || '').slice(0, 10);
        if (date === today) { entry.is_current = true; entry.driver_name = d.driver_name || entry.driver_name; }
        if (['completed', 'delivered'].includes(String(d.status))) entry.is_past = true;
        if (date > entry.last_delivery_date) entry.last_delivery_date = date;
        byDriver.set(d.driver_id, entry);
      }

      const drivers = Array.from(byDriver.values())
        .filter((d) => d.is_current || d.is_past)
        .map((d) => {
          const user = userById.get(d.driver_id);
          const status = String(user?.driver_status || 'off_duty');
          return {
            ...d,
            duty_status: ['on_duty', 'on_break', 'off_duty'].includes(status) ? status : 'off_duty',
            phone: '',
          };
        })
        .sort((a, b) => {
          if (a.is_current !== b.is_current) return a.is_current ? -1 : 1;
          return String(b.last_delivery_date).localeCompare(String(a.last_delivery_date));
        });

      return Response.json({ ok: true, today, drivers });
    }

    // ── Patient side writes (no auth: the portal is a public page) ──────────
    if (action === 'patientSend' || action === 'patientMarkRead') {
      const { patient_id, driver_id } = payload;
      if (!patient_id) return Response.json({ ok: false, error: 'patient_id is required' }, { status: 400 });

      let patient = null;
      try {
        patient = await base44.asServiceRole.entities.Patient.get(patient_id);
      } catch (_) {
        return Response.json({ ok: false, error: 'Patient not found' }, { status: 404 });
      }
      if (!patient || patient.status === 'inactive') {
        return Response.json({ ok: false, error: 'Patient not found' }, { status: 404 });
      }

      const patientSenderId = `patient:${patient_id}`;
      const threadFilter: any = { patient_id, read: false };
      if (driver_id) threadFilter.driver_id = driver_id;

      if (action === 'patientMarkRead') {
        const rows = await base44.asServiceRole.entities.Message
          .filter(threadFilter, '-created_date', 100)
          .catch(() => []);
        const unread = (rows || []).filter((m: any) => m.sender_id !== patientSenderId);
        for (const m of unread) {
          await base44.asServiceRole.entities.Message.update(m.id, { read: true }).catch(() => {});
        }
        return Response.json({ ok: true, marked: unread.length });
      }

      const text = String(payload.content || '').trim().slice(0, 2000);
      if (!text) return Response.json({ ok: false, error: 'Message text is required' }, { status: 400 });

      // Driver thread: only drivers who have delivered to this patient (today
      // or in the past) may be messaged.
      let driver: any = null;
      if (driver_id) {
        const prior = await base44.asServiceRole.entities.Delivery
          .filter({ patient_id, driver_id }, '-delivery_date', 5)
          .catch(() => []);
        if (!prior || prior.length === 0) {
          return Response.json({ ok: false, error: 'That driver has no delivery with this patient' }, { status: 403 });
        }
        try { driver = await base44.asServiceRole.entities.AppUser.get(driver_id); } catch (_) { driver = null; }
      }

      const created = await base44.asServiceRole.entities.Message.create({
        sender_id: patientSenderId,
        sender_name: patient.full_name || 'Patient',
        receiver_id: driver ? driver_id : '',
        receiver_name: driver ? (driver.full_name || 'Driver') : 'Pharmacy',
        conversation_id: driver ? `driver:${driver_id}:patient:${patient_id}` : `patient:${patient_id}`,
        content: text,
        message_type: 'text',
        read: false,
        patient_id,
        store_id: patient.store_id || '',
        driver_id: driver ? driver_id : '',
      });

      let alerted = { sent: 0 };
      if (driver) {
        alerted = await pushToUser(base44, driver_id, {
          title: `Message from ${patient.full_name || 'a patient'}`,
          body: text.length > 140 ? `${text.slice(0, 137)}...` : text,
          url: '/',
          tag: `driver-thread-${patient_id}`,
          patient_id,
        }).catch(() => ({ sent: 0 }));
      } else {
        alerted = await notifyStoreStaff(base44, {
          patient_id,
          store_id: patient.store_id || '',
          title: `New message from ${patient.full_name || 'a patient'}`,
          body: text.length > 140 ? `${text.slice(0, 137)}...` : text,
          url: '/',
        }).catch(() => ({ sent: 0 }));
      }

      return Response.json({ ok: true, message: created, alerted });
    }

    // ── Patient → staff alert (portal-triggered) ────────────────────────────
    if (action === 'notifyStaff') {
      const { patient_id, store_id, title, body, url } = payload;
      if (!patient_id) return Response.json({ ok: false, error: 'patient_id is required' }, { status: 400 });
      const result = await notifyStoreStaff(base44, { patient_id, store_id, title, body, url });
      return Response.json({ ok: true, ...result });
    }

    // ── Send to a patient's devices (authenticated staff OR driver) ─────────
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    const { patient_id, title, body, url, tag } = payload;
    if (!patient_id || !title) {
      return Response.json({ ok: false, error: 'patient_id and title are required' }, { status: 400 });
    }

    const subs = await base44.asServiceRole.entities.PushSubscription
      .filter({ user_id: ownerKey(patient_id) })
      .catch(() => []);
    if (!subs || subs.length === 0) return Response.json({ ok: true, sent: 0, message: 'No patient devices registered' });

    const notification = {
      title,
      body: body || '',
      url: url || '/patient-portal',
      tag: tag || `patient-msg-${patient_id}`,
      timestamp: Date.now(),
      requireInteraction: false,
    };

    const vapidPublicKey = Deno.env.get('VAPID_PUBLIC_KEY');
    const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY');
    const vapidSubject = Deno.env.get('VAPID_SUBJECT');
    if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
      return Response.json({ ok: false, error: 'VAPID keys not configured' }, { status: 500 });
    }

    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
    let sent = 0, removed = 0;
    const errors: string[] = [];
    await Promise.all(subs.map(async (sub: any) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh_key, auth: sub.auth_key } },
          JSON.stringify(notification)
        );
        sent++;
        await base44.asServiceRole.entities.PushSubscription
          .update(sub.id, { last_used_at: new Date().toISOString() })
          .catch(() => {});
      } catch (err: any) {
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await base44.asServiceRole.entities.PushSubscription.delete(sub.id).catch(() => {});
          removed++;
        } else {
          errors.push(err?.message || String(err));
        }
      }
    }));

    return Response.json({ ok: true, sent, removed, errors });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Unknown error' }, { status: 500 });
  }
});
