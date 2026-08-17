import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import webpush from 'npm:web-push@3.6.7';

// ── FCM HTTP v1 API — OAuth2 access token via service account JWT ──────
// Google deprecated the legacy FCM server-key API (June 2024). The v1 API
// requires a short-lived OAuth2 access token, obtained by signing a JWT
// with the service account's private key (RS256) and exchanging it at
// Google's token endpoint. Token is cached in-memory for ~50 minutes
// (tokens are valid 1hr) to avoid re-signing on every request within the
// same function instance.
let _cachedFcmToken: { token: string; expiresAt: number } | null = null;

function base64UrlEncode(input: ArrayBuffer | string): string {
  let bytes: Uint8Array;
  if (typeof input === 'string') {
    bytes = new TextEncoder().encode(input);
  } else {
    bytes = new Uint8Array(input);
  }
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

  // Return cached token if still valid (with 60s buffer)
  if (_cachedFcmToken && _cachedFcmToken.expiresAt - 60 > now) {
    return _cachedFcmToken.token;
  }

  let creds;
  try {
    creds = JSON.parse(serviceAccountJson);
  } catch {
    console.error('[sendPush] FCM_SERVICE_ACCOUNT_JSON is not valid JSON');
    return null;
  }

  const { client_email, private_key } = creds;
  if (!client_email || !private_key) {
    console.error('[sendPush] Service account JSON missing client_email or private_key');
    return null;
  }

  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedClaimSet = base64UrlEncode(JSON.stringify(claimSet));
  const signingInput = `${encodedHeader}.${encodedClaimSet}`;

  const keyData = pemToArrayBuffer(private_key);
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const jwt = `${signingInput}.${base64UrlEncode(signature)}`;

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!tokenResponse.ok) {
    const errText = await tokenResponse.text();
    console.error('[sendPush] FCM token exchange failed:', tokenResponse.status, errText);
    return null;
  }

  const tokenData = await tokenResponse.json();
  _cachedFcmToken = { token: tokenData.access_token, expiresAt: now + (tokenData.expires_in || 3600) };
  return tokenData.access_token;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { user_id, title, body, url, tag, requireInteraction, force, actions, data } = await req.json();
    if (!user_id || !title || !body) return Response.json({ error: 'user_id, title, and body are required' }, { status: 400 });

    const vapidPublicKey = Deno.env.get('VAPID_PUBLIC_KEY');
    const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY');
    const vapidSubject = Deno.env.get('VAPID_SUBJECT');

    // FCM v1 config
    const fcmServiceAccountJson = Deno.env.get('FCM_SERVICE_ACCOUNT_JSON');
    const fcmProjectId = (() => {
      try {
        return fcmServiceAccountJson ? JSON.parse(fcmServiceAccountJson).project_id : null;
      } catch {
        return null;
      }
    })();

    console.log('[sendPush] === FCM DIAGNOSTIC ===');
    console.log('[sendPush] FCM_SERVICE_ACCOUNT_JSON set:', !!fcmServiceAccountJson);
    console.log('[sendPush] FCM_SERVICE_ACCOUNT_JSON length:', fcmServiceAccountJson?.length || 0);
    console.log('[sendPush] FCM project_id:', fcmProjectId);
    console.log('[sendPush] user_id:', user_id);

    let deviceProfiles = {};
    let hasAnyExplicitFalse = false;
    if (!force) {
      const userSettingsRecords = await base44.asServiceRole.entities.UserSettings.filter({ user_id }).catch(() => []);
      deviceProfiles = userSettingsRecords?.[0]?.device_settings_profiles || {};
      hasAnyExplicitFalse = Object.values(deviceProfiles).some(
        (p: any) => p?.notifications_enabled === false
      );
    }

    const subscriptions = await base44.asServiceRole.entities.PushSubscription.filter({ user_id });
    console.log('[sendPush] total subscriptions:', subscriptions?.length || 0);
    console.log('[sendPush] FCM subscriptions:', subscriptions?.filter(s => s.endpoint?.startsWith('fcm://')).length || 0);
    console.log('[sendPush] Web Push subscriptions:', subscriptions?.filter(s => !s.endpoint?.startsWith('fcm://')).length || 0);
    if (!subscriptions || subscriptions.length === 0) return Response.json({ sent: 0, message: 'No push subscriptions for this user' });

    const notifData = { title, body, url: url || '/', tag: tag || undefined, requireInteraction: !!requireInteraction };
    if (actions) notifData.actions = actions;
    if (data) notifData.data = data;

    // Pre-fetch FCM access token ONCE if we have any FCM subscriptions
    const hasFcmSub = subscriptions.some((s: any) => s.endpoint?.startsWith('fcm://'));
    let fcmAccessToken: string | null = null;
    if (hasFcmSub && fcmServiceAccountJson && fcmProjectId) {
      fcmAccessToken = await getFcmAccessToken(fcmServiceAccountJson);
      console.log('[sendPush] FCM access token acquired:', !!fcmAccessToken);
    } else {
      console.log('[sendPush] FCM access token NOT acquired — hasFcmSub:', hasFcmSub, 'jsonSet:', !!fcmServiceAccountJson, 'projectId:', fcmProjectId);
    }

    let sent = 0, removed = 0, skipped = 0, fcmSent = 0, webSent = 0;
    const errors = [];

    await Promise.all(subscriptions.map(async (sub) => {
      const isFCM = sub.endpoint?.startsWith('fcm://');

      // FCM (APK) subscriptions ALWAYS receive pushes — device profile
      // filtering only applies to web push subscriptions. This ensures
      // WEB-to-APK notifications always go through regardless of any
      // stale device settings profiles from other devices.
      if (!force && !isFCM) {
        let deviceEnabled = true;
        if (sub.device_identifier && deviceProfiles[sub.device_identifier]) {
          deviceEnabled = deviceProfiles[sub.device_identifier].notifications_enabled ?? true;
        } else if (hasAnyExplicitFalse) {
          deviceEnabled = false;
        }
        if (!deviceEnabled) { skipped++; return; }
      }

      if (isFCM) {
        const fcmToken = sub.endpoint.replace('fcm://', '');
        console.log('[sendPush] FCM send attempt — token prefix:', fcmToken?.substring(0, 20), 'hasAccessToken:', !!fcmAccessToken, 'projectId:', fcmProjectId);
        if (!fcmToken) { skipped++; console.log('[sendPush] FCM skipped: empty token'); return; }
        if (!fcmAccessToken || !fcmProjectId) {
          errors.push({ endpoint: sub.endpoint, error: 'FCM_SERVICE_ACCOUNT_JSON not configured or token exchange failed' });
          console.log('[sendPush] FCM FAILED: no access token or project ID');
          return;
        }
        try {
          const fcmPayload = {
            message: {
              token: fcmToken,
              notification: { title, body },
              data: Object.fromEntries(
                Object.entries({ url: url || '/', ...(data || {}) }).map(([k, v]) => [k, String(v)])
              ),
              android: {
                priority: 'high',
                notification: {
                  tag: tag || undefined,
                  channel_id: 'default',
                  // Pass URL via data only — click_action expects an Android
                  // intent action name, not a URL. Capacitor's tap handler
                  // reads the URL from notification.data.url instead.
                },
              },
            },
          };

          const fcmResponse = await fetch(
            `https://fcm.googleapis.com/v1/projects/${fcmProjectId}/messages:send`,
            {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${fcmAccessToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(fcmPayload),
            }
          );

          if (fcmResponse.ok) {
            sent++; fcmSent++;
            console.log('[sendPush] FCM SUCCESS for token prefix:', fcmToken.substring(0, 20));
          } else {
            const errBody = await fcmResponse.json().catch(() => ({}));
            const errStatus = errBody?.error?.status;
            if (errStatus === 'NOT_FOUND' || errStatus === 'INVALID_ARGUMENT' || fcmResponse.status === 404) {
              // Stale/invalid token — remove subscription
              await base44.asServiceRole.entities.PushSubscription.delete(sub.id).catch(() => {});
              removed++;
            } else {
              errors.push({ endpoint: sub.endpoint, error: `FCM v1 HTTP ${fcmResponse.status}: ${JSON.stringify(errBody)}` });
            }
          }
        } catch (err) {
          errors.push({ endpoint: sub.endpoint, error: err.message || String(err) });
        }
      } else {
        if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
          errors.push({ endpoint: sub.endpoint, error: 'VAPID keys not configured' });
          return;
        }
        try {
          webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
          const pushSubscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh_key, auth: sub.auth_key } };
          await webpush.sendNotification(pushSubscription, JSON.stringify(notifData));
          sent++; webSent++;
        } catch (err) {
          if (err?.statusCode === 410 || err?.statusCode === 404) {
            await base44.asServiceRole.entities.PushSubscription.delete(sub.id).catch(() => {});
            removed++;
          } else {
            errors.push({ endpoint: sub.endpoint, error: err.message || String(err) });
          }
        }
      }
    }));

    console.log('[sendPush] === SUMMARY === sent:', sent, 'fcmSent:', fcmSent, 'webSent:', webSent, 'skipped:', skipped, 'removed:', removed, 'errors:', errors.length);
    return Response.json({ sent, removed, skipped, fcmSent, webSent, errors });
  } catch (error) {
    return Response.json({ error: error.message || 'Unknown error' }, { status: 500 });
  }
});
