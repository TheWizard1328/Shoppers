import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import webpush from 'npm:web-push@3.6.7';

/**
 * patientPush — push notifications for PATIENT PORTAL devices.
 *
 * Patients are not Base44 users, so their subscriptions are stored in the
 * normal PushSubscription entity under a synthetic owner key:
 *   user_id = `patient:<patient_id>`
 * Staff pushes (sendPushNotification) keep using the AppUser id, so the two
 * audiences never collide.
 *
 * Actions (body.action):
 *   'vapid'      → returns the VAPID public key (no auth — the portal needs it
 *                  to subscribe; the key is public by design)
 *   'register'   → save/refresh this device's subscription for a patient
 *   'unregister' → drop this device's subscription
 *   'send'       → STAFF ONLY: push a notification to every device the patient
 *                  has registered (used for new patient messages)
 *
 * Body: { action, patient_id, subscription, device_identifier, user_agent,
 *         title, body, url, tag }
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    const action = String(payload.action || 'send');
    const ownerKey = (patientId: string) => `patient:${patientId}`;

    if (action === 'vapid') {
      const publicKey = Deno.env.get('VAPID_PUBLIC_KEY') || null;
      return Response.json({ publicKey });
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

      const now = new Date().toISOString();
      const record = {
        user_id: userKey,
        user_name: patient.full_name || 'Patient',
        endpoint,
        p256dh_key: subscription.keys.p256dh,
        auth_key: subscription.keys.auth,
        device_identifier: device_identifier || '',
        user_agent: user_agent || '',
        last_used_at: now,
      };

      const match = (existing || []).find((s: any) => s.endpoint === endpoint);
      if (match) {
        await base44.asServiceRole.entities.PushSubscription.update(match.id, record);
      } else {
        await base44.asServiceRole.entities.PushSubscription.create(record);
      }

      // Housekeeping: a patient only ever needs a handful of live devices.
      const all = await base44.asServiceRole.entities.PushSubscription
        .filter({ user_id: userKey }, '-last_used_at', 20)
        .catch(() => []);
      const extra = (all || []).slice(4);
      for (const sub of extra) {
        await base44.asServiceRole.entities.PushSubscription.delete(sub.id).catch(() => {});
      }

      return Response.json({ ok: true, devices: Math.min((all || []).length, 4) });
    }

    // ── Patient → staff alert (no auth: fired by the public portal page) ────
    // A patient message must reach the store's phones even when nobody has the
    // Messaging panel open. Recipients are the AppUsers of that store (plus
    // admins), pushed through the same VAPID keys as everything else.
    if (action === 'notifyStaff') {
      const { patient_id, store_id, title, body, url } = payload;
      if (!patient_id) return Response.json({ ok: false, error: 'patient_id is required' }, { status: 400 });

      const vapidPub = Deno.env.get('VAPID_PUBLIC_KEY');
      const vapidPriv = Deno.env.get('VAPID_PRIVATE_KEY');
      const vapidSubj = Deno.env.get('VAPID_SUBJECT');
      if (!vapidPub || !vapidPriv || !vapidSubj) {
        return Response.json({ ok: false, error: 'VAPID keys not configured' }, { status: 500 });
      }

      const users = await base44.asServiceRole.entities.AppUser.filter({}, '-created_date', 200).catch(() => []);
      const recipients = (users || []).filter((u: any) => {
        if (!u?.id) return false;
        const roles = Array.isArray(u.app_roles) ? u.app_roles : [];
        const isAdmin = roles.includes('admin') || roles.includes('app_owner') || u.role === 'admin';
        const stores = Array.isArray(u.store_ids) ? u.store_ids : (u.store_id ? [u.store_id] : []);
        if (store_id) return isAdmin || stores.includes(store_id);
        return isAdmin;
      }).slice(0, 15);

      if (recipients.length === 0) return Response.json({ ok: true, sent: 0, message: 'No staff recipients' });

      webpush.setVapidDetails(vapidSubj, vapidPub, vapidPriv);
      const notification = {
        title: title || 'New patient message',
        body: body || '',
        url: url || '/',
        tag: `patient-thread-${patient_id}`,
        timestamp: Date.now(),
        requireInteraction: false,
      };

      let sent = 0, removed = 0;
      for (const staffUser of recipients) {
        const subs = await base44.asServiceRole.entities.PushSubscription
          .filter({ user_id: staffUser.id })
          .catch(() => []);
        for (const sub of subs || []) {
          if (sub.endpoint?.startsWith('fcm://')) continue; // web push only here
          try {
            await webpush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh_key, auth: sub.auth_key } },
              JSON.stringify(notification)
            );
            sent++;
          } catch (err: any) {
            if (err?.statusCode === 404 || err?.statusCode === 410) {
              await base44.asServiceRole.entities.PushSubscription.delete(sub.id).catch(() => {});
              removed++;
            }
          }
        }
      }
      return Response.json({ ok: true, sent, removed, recipients: recipients.length });
    }

    // ── Send: staff only ────────────────────────────────────────────────────
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    const { patient_id, title, body, url, tag } = payload;
    if (!patient_id || !title) {
      return Response.json({ ok: false, error: 'patient_id and title are required' }, { status: 400 });
    }

    const vapidPublicKey = Deno.env.get('VAPID_PUBLIC_KEY');
    const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY');
    const vapidSubject = Deno.env.get('VAPID_SUBJECT');
    if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
      return Response.json({ ok: false, error: 'VAPID keys not configured' }, { status: 500 });
    }

    const subs = await base44.asServiceRole.entities.PushSubscription
      .filter({ user_id: ownerKey(patient_id) })
      .catch(() => []);
    if (!subs || subs.length === 0) return Response.json({ ok: true, sent: 0, message: 'No patient devices registered' });

    const notification = {
      title,
      body: body || '',
      url: url || '/patient-portal',
      tag: tag || 'rxdeliver-patient',
      timestamp: Date.now(),
      requireInteraction: false,
    };

    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

    let sent = 0, removed = 0;
    const errors = [];
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
