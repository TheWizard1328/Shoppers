// appIssueMonitor — scheduled app health watchdog (Oct 11 2026, owner spec).
//
// Scans RemoteLogEntry for the last N minutes and detects three issue classes
// per user:
//   1. app_restarts — frequent app starts (event_type 'app_start' rows written
//      by the client boot beacon in AppIssueSupport.jsx)
//   2. rate_limit   — repeated rate-limit hits (429 / "rate limit" in captured logs)
//   3. errors       — elevated error volume (level 'error', excluding rate-limit rows)
//
// On detection (thresholds in AppSettings 'app_issue_monitor', cooldowns in
// 'app_issue_monitor_state', per user+issue-type):
//   - In-app Message to the app owner from "App Issues" (sender_id 'app_issues')
//     describing the issue + affected user (skipped when the affected user IS
//     the owner — the owner copy is worded for that case).
//   - In-app Message to the affected user telling them the issue was detected
//     and the developer has been notified.
//   - Push to the owner: "App Issue — <Name>" / simple description. Tapping
//     opens the app to the App Issues conversation (deep link
//     /?app_issue_message=<ownerMessageId> — handled by AppIssueSupport.jsx).
//
// Push delivery is INLINED (web-push VAPID + FCM v1 HTTP API) — this function
// runs unauthenticated from a scheduled workflow, so it cannot call
// sendPushNotification (which requires an authenticated user session), and
// cross-function base44.functions.invoke does not forward auth anyway (see
// driverCodBriefing for the same pattern).
//
// Params: { dry_run? } — dry_run=true computes everything but does NOT create
// messages, send pushes, or write state (used for testing).
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import webpush from 'npm:web-push@3.6.7';

const SETTINGS_KEY = 'app_issue_monitor';
const STATE_KEY = 'app_issue_monitor_state';
const APP_ISSUES_SENDER_ID = 'app_issues';
const APP_ISSUES_SENDER_NAME = 'App Issues';
const OWNER_PLATFORM_USER_ID = '68570f3cd01bfa2d2408a9d7';

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }

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
    if (isFCM) {
      const fcmToken = sub.endpoint.replace('fcm://', '');
      if (!fcmToken) { skipped++; return; }
      if (!fcmAccessToken || !fcmProjectId) { errors.push({ error: 'FCM not configured or token exchange failed' }); return; }
      try {
        // FCM v1 field placement: icon/color are ANDROID-only fields — they
        // must live in android.notification, NOT the generic notification object.
        const fcmMessage = {
          token: fcmToken,
          data: { url: url || '/' },
          android: { priority: 'high', notification: { tag: tag || undefined, channel_id: 'default', icon: 'ic_stat_notify', color: '#ef4444' } },
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

async function listAll(base44, entityName, sortField, limit = 2000) {
  const out = [];
  const res = await base44.asServiceRole.entities[entityName].list(sortField, limit);
  const rows = Array.isArray(res) ? res : (Array.isArray(res?.data) ? res.data : []);
  rows.forEach((r) => { const u = unwrapEntityRecord(r); if (u) out.push(u); });
  return out;
}

// Edmonton-time HH:MM for message contents (never UTC — sandbox runs UTC).
const edmTime = (iso) => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  } catch (_) { return String(iso || ''); }
};

const DEFAULT_CONFIG = {
  enabled: true,
  window_minutes: 30,
  restarts_threshold: 4,     // app_start rows per user in window
  rate_limit_threshold: 5,   // rate-limit-matching rows per user in window
  errors_threshold: 12,      // level 'error' rows per user in window (rate-limit excluded)
  cooldown_minutes: 120,     // per user + issue type
  max_alerts_per_run: 5,
  log_fetch_limit: 3000,
};

const ISSUE_META = {
  app_restarts: {
    label: 'frequent app restarts',
    push_body: 'Frequent app restarts detected',
  },
  rate_limit: {
    label: 'repeated rate limit issues',
    push_body: 'Repeated rate limit issues detected',
  },
  errors: {
    label: 'repeated app errors',
    push_body: 'Repeated app errors detected',
  },
};

const RATE_LIMIT_RX = /\b429\b|rate.?limit/i;

const classifyRow = (row) => {
  const msg = String(row.message || '');
  const isAppStart = row.event_type === 'app_start' || /\[DEVICE_HEALTH\] app_start/.test(msg);
  const isRateLimit = !isAppStart && RATE_LIMIT_RX.test(msg);
  const isError = row.level === 'error' && !isRateLimit && !isAppStart;
  return { isAppStart, isRateLimit, isError };
};

// ── Main ─────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const startedAt = Date.now();
  let payload = {};
  try { payload = await req.json(); } catch (_) {}
  const dryRun = !!payload?.dry_run;

  try {
    const base44 = createClientFromRequest(req);
    await requireAdminIfAuthenticated(base44);

    // ── Config (AppSettings 'app_issue_monitor') — abort on read failure
    // (weather-bar lesson: never blind-create on a transient read failure).
    const cfgRows = await base44.asServiceRole.entities.AppSettings.filter({ setting_key: SETTINGS_KEY }, '-updated_date', 50, 0).catch(() => null);
    if (!cfgRows) {
      return Response.json({ success: false, skipped_reason: 'config read failed — aborting instead of risking duplicate alerts' });
    }
    const cfg = { ...DEFAULT_CONFIG, ...(cfgRows[0]?.setting_value || {}) };
    if (cfg.enabled === false) {
      return Response.json({ success: true, skipped_reason: 'monitor_disabled' });
    }

    // ── Cooldown state (AppSettings 'app_issue_monitor_state').
    // Also abort on read failure — without state we cannot enforce cooldowns.
    const stateRows = await base44.asServiceRole.entities.AppSettings.filter({ setting_key: STATE_KEY }, '-updated_date', 50, 0).catch(() => null);
    if (!stateRows) {
      return Response.json({ success: false, skipped_reason: 'state read failed — aborting to avoid alert spam' });
    }
    // Duplicate same-key rows: converge on the freshest, delete the rest.
    if (stateRows.length > 1) {
      for (const extra of stateRows.slice(1)) {
        await base44.asServiceRole.entities.AppSettings.delete(extra.id).catch(() => {});
      }
    }
    const state = { lastAlertAt: {}, ...(stateRows[0]?.setting_value || {}) };
    const cooldownMs = (Number(cfg.cooldown_minutes) || 120) * 60 * 1000;
    const now = Date.now();

    // ── Owner resolution (pinned platform id + AppUser name lookup).
    let ownerName = 'App Owner';
    try {
      const appUsers = await listAll(base44, 'AppUser', '-updated_date', 2000);
      const ownerAppUser = (appUsers || []).find((a) => a?.user_id === OWNER_PLATFORM_USER_ID);
      if (ownerAppUser?.user_name) ownerName = ownerAppUser.user_name;
    } catch (err) {
      console.log('[appIssueMonitor] AppUser lookup failed (non-fatal):', err?.message || String(err));
    }

    // ── Scan the log window.
    const cutoff = now - (Number(cfg.window_minutes) || 30) * 60 * 1000;
    let rows = [];
    try {
      rows = await listAll(base44, 'RemoteLogEntry', '-created_date', Number(cfg.log_fetch_limit) || 3000);
    } catch (err) {
      return Response.json({ success: false, skipped_reason: 'RemoteLogEntry read failed', error: err?.message || String(err) });
    }

    const perUser = new Map();
    let inWindow = 0;
    for (const row of rows) {
      if (!row?.user_id) continue;
      const tsRaw = row.created_date || row.timestamp;
      const ts = tsRaw ? new Date(tsRaw).getTime() : 0;
      if (!ts || ts < cutoff) continue; // rows are newest-first; timestamps can jitter from buffered flushes
      inWindow++;
      const { isAppStart, isRateLimit, isError } = classifyRow(row);
      if (!isAppStart && !isRateLimit && !isError) continue;

      const uid = row.user_id;
      if (!perUser.has(uid)) {
        perUser.set(uid, { user_id: uid, user_name: row.user_name || 'Unknown user', appStarts: 0, rateLimits: 0, errors: 0, samples: [], devices: new Set() });
      }
      const u = perUser.get(uid);
      if (row.device_identifier) u.devices.add(row.device_identifier);
      if (isAppStart) {
        u.appStarts++;
        if (u.samples.length < 4) u.samples.push(`${edmTime(tsRaw)} · app started`);
      } else if (isRateLimit) {
        u.rateLimits++;
        if (u.samples.length < 4) u.samples.push(`${edmTime(tsRaw)} · ${String(row.message || '').slice(0, 140)}`);
      } else if (isError) {
        u.errors++;
        if (u.samples.length < 4) u.samples.push(`${edmTime(tsRaw)} · ${String(row.message || '').slice(0, 140)}`);
      }
    }

    // ── Detect issues per user.
    const alerts = [];
    for (const u of perUser.values()) {
      const candidates = [];
      if (u.appStarts >= (Number(cfg.restarts_threshold) || 4)) candidates.push('app_restarts');
      if (u.rateLimits >= (Number(cfg.rate_limit_threshold) || 5)) candidates.push('rate_limit');
      if (u.errors >= (Number(cfg.errors_threshold) || 12)) candidates.push('errors');
      for (const type of candidates) {
        // Owner request (Oct 13 2026): the owner's primary phone restarts on
        // every preview-update reload — expected behavior, not an issue. Never
        // alert (in-app or push) on the owner's own app restarts. Rate-limit and
        // error alerts for the owner are unaffected.
        if (type === 'app_restarts' && u.user_id === OWNER_PLATFORM_USER_ID) continue;
        const key = `${u.user_id}:${type}`;
        const last = state.lastAlertAt[key] ? new Date(state.lastAlertAt[key]).getTime() : 0;
        if (last && now - last < cooldownMs) continue; // cooldown active
        alerts.push({ type, user: u });
      }
    }
    alerts.sort((a, b) => (b.user.appStarts + b.user.rateLimits + b.user.errors) - (a.user.appStarts + a.user.rateLimits + a.user.errors));
    const capped = alerts.slice(0, Number(cfg.max_alerts_per_run) || 5);

    const results = [];
    for (const alert of capped) {
      const meta = ISSUE_META[alert.type];
      const u = alert.user;
      const isOwner = u.user_id === OWNER_PLATFORM_USER_ID;
      const deviceNote = u.devices.size ? ` (device: ${Array.from(u.devices)[0]})` : '';

      // Owner message — description + affected user.
      const countLine =
        alert.type === 'app_restarts' ? `${u.appStarts} app starts within the last ${cfg.window_minutes} minutes.`
        : alert.type === 'rate_limit' ? `${u.rateLimits} rate limit hits within the last ${cfg.window_minutes} minutes.`
        : `${u.errors} app errors within the last ${cfg.window_minutes} minutes.`;
      const ownerContent = isOwner
        ? `Issue detected: ${meta.label} on your device.\n${countLine}\nRecent activity:\n${u.samples.map((s) => `- ${s}`).join('\n')}`
        : `Issue detected: ${meta.label}.\nAffected user: ${u.user_name}${deviceNote}\n${countLine}\nRecent activity:\n${u.samples.map((s) => `- ${s}`).join('\n')}\nThe user has been notified in-app.`;

      // Affected-user message — the issue was detected and the developer notified.
      const userContent =
        `We automatically detected a problem with the app on this device: ${meta.label}.\n` +
        `${isOwner ? 'You are the developer, so no one else was notified.' : 'The developer has been notified and is looking into it.'}\n` +
        `No action is needed from you right now.`;

      if (dryRun) {
        results.push({ type: alert.type, user_id: u.user_id, user_name: u.user_name, dry_run: true, counts: { appStarts: u.appStarts, rateLimits: u.rateLimits, errors: u.errors } });
        continue;
      }

      // Owner in-app message (from "App Issues").
      const ownerMessage = await base44.asServiceRole.entities.Message.create({
        sender_id: APP_ISSUES_SENDER_ID,
        sender_name: APP_ISSUES_SENDER_NAME,
        receiver_id: OWNER_PLATFORM_USER_ID,
        receiver_name: ownerName,
        conversation_id: [APP_ISSUES_SENDER_ID, OWNER_PLATFORM_USER_ID].sort().join('_'),
        content: ownerContent,
        read: false,
      }).catch((err) => { console.error('[appIssueMonitor] owner Message create failed:', err?.message || String(err)); return null; });

      // Affected-user in-app message (skipped for the owner).
      if (!isOwner) {
        await base44.asServiceRole.entities.Message.create({
          sender_id: APP_ISSUES_SENDER_ID,
          sender_name: APP_ISSUES_SENDER_NAME,
          receiver_id: u.user_id,
          receiver_name: u.user_name,
          conversation_id: [APP_ISSUES_SENDER_ID, u.user_id].sort().join('_'),
          content: userContent,
          read: false,
        }).catch((err) => { console.error('[appIssueMonitor] user Message create failed:', err?.message || String(err)); });
      }

      // Owner push — simple: user's name + simple description. Tap opens the
      // App Issues conversation via the deep-link param.
      const firstName = String(u.user_name || 'User').trim().split(/\s+/)[0];
      const pushTitle = isOwner ? 'App Issue — your device' : `App Issue — ${firstName}`;
      const pushUrl = ownerMessage?.id ? `/?app_issue_message=${ownerMessage.id}` : '/';
      const push = await sendPushToUser(base44, OWNER_PLATFORM_USER_ID, pushTitle, meta.push_body, pushUrl, 'app_issues');

      state.lastAlertAt[`${u.user_id}:${alert.type}`] = new Date(now).toISOString();
      results.push({
        type: alert.type,
        user_id: u.user_id,
        user_name: u.user_name,
        counts: { appStarts: u.appStarts, rateLimits: u.rateLimits, errors: u.errors },
        owner_message_id: ownerMessage?.id || null,
        push,
      });
    }

    // ── Persist cooldown state.
    if (!dryRun) {
      state.lastRunAt = new Date(now).toISOString();
      const stateRec = stateRows[0];
      if (stateRec?.id) {
        await base44.asServiceRole.entities.AppSettings.update(stateRec.id, { setting_value: state }).catch((err) => {
          console.error('[appIssueMonitor] state update failed:', err?.message || String(err));
        });
      } else {
        await base44.asServiceRole.entities.AppSettings.create({ setting_key: STATE_KEY, setting_value: state }).catch((err) => {
          console.error('[appIssueMonitor] state create failed:', err?.message || String(err));
        });
      }
    }

    return Response.json({
      success: true,
      dry_run: dryRun,
      window_minutes: cfg.window_minutes,
      logs_in_window: inWindow,
      users_with_activity: perUser.size,
      alerts_detected: alerts.length,
      alerts_sent: results.length,
      alerts: results,
      cooldowns_active: Object.keys(state.lastAlertAt).length,
      duration_ms: Date.now() - startedAt,
    });
  } catch (error) {
    console.error('[appIssueMonitor] failed:', error);
    return Response.json({ error: error?.message || String(error), duration_ms: Date.now() - startedAt }, { status: error instanceof HttpError ? error.status : 500 });
  }
});
