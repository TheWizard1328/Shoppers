// payrollArrearsRemind — daily arrears reminder for RxDeliver payroll.
//
// SAFETY: dry_run DEFAULTS TO TRUE. Nothing is pushed unless the caller passes
// { dry_run: false }. The scheduled workflow must pass that explicitly once the
// owner has approved the copy in preview.
//
// Owner spec (Nov 21 2026):
//   1. Driver is told FIRST, so they can fix a wrong paid_amount themselves.
//   2. Riyaz gets the remainder-unpaid list (including drivers who ignored it).
//   3. The app owner (Robert) gets the "70% of the period passed, remaining is
//      rolling over" push, and a confirmation of whether Riyaz's push landed.
//   4. Blank paid_amount is ignored until the cutoff has passed.
//   5. Windows (owner's dates): semi-monthly 5th/20th cutoffs -> nudge 6th-10th
//      and 21st-25th; monthly 5th -> 6th-10th; weekly/bi-weekly -> Mon-Thu.
//      The LAST day of each window is the 70% last-call day.
//
// FIELD RULE (critical): Payroll stores gross and net SWAPPED. `gross_pay` is
// the true net owed (the UI's "Net"), `net_pay` is the gross. Always
// gross_pay - paid_amount.
//
// Params: { dry_run?: boolean, riyaz_user_id?: string, owner_user_id?: string }
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

// ── FCM HTTP v1 access token ────────────────────────────────────────────────
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

// ── Push sending (inlined parity with driverWeatherBriefing) ───────────────
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
  if (!subscriptions || subscriptions.length === 0) return { sent: 0, skipped: 0, removed: 0, errors: [], subscribed: false };

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
          notification: { title, body },
        };
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
  return { sent, skipped, removed, errors, subscribed: true };
}

// ── Helpers ────────────────────────────────────────────────────────────────
const EDMONTON = 'America/Edmonton';

const edmontonParts = (d = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: EDMONTON, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return { y: get('year'), mo: get('month'), d: get('day'), wd: get('weekday') };
};
const edmontonTodayKey = (d = new Date()) => { const p = edmontonParts(d); return `${p.y}-${p.mo}-${p.d}`; };

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const dayOnly = (v) => String(v || '').slice(0, 10);
const isBlank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;

async function listAll(entity, sort = '-created_date') {
  const out = [];
  const PAGE = 500;
  for (let skip = 0; skip < 5000; skip += PAGE) {
    const page = await entity.list(sort, PAGE, skip).catch(() => null);
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

// Nudge windows, owner's dates. Each entry is a closed day-of-month range; the
// LAST day is the 70% last-call day. Weekly/bi-weekly run Monday..Thursday.
const WINDOWS = {
  semimonthly: [[6, 10], [21, 25]],
  semimonthly2: [[6, 10], [21, 25]],
  monthly: [[6, 10]],
};
const WEEKLY_LIKE = new Set(['weekly', 'biweekly', 'bi-weekly', 'bi_weekly']);

/** Derive the real cycle from the period itself.
 *  Owner report Nov 21 2026: Sharuk's Nov 1-15 row is stored as 'weekly', so the
 *  Mon-Thu gate silently gave him NO nudge while the smaller balances got one.
 *  A 15-day period starting on the 1st or 16th is semi-monthly whatever the
 *  stored type says. Span wins for short periods; the stored type is only a
 *  fallback when the span is unusable. */
function deriveCycle(cycle, startStr, endStr) {
  const key = String(cycle || '').toLowerCase().replace(/[-\s_]/g, '');
  const s = new Date(`${startStr}T00:00:00Z`);
  const e = new Date(`${endStr}T00:00:00Z`);
  const span = Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
  if (!Number.isFinite(span) || span <= 0) return key || 'semimonthly';
  if (span <= 8) return 'weekly';
  const startDay = Number(String(startStr).slice(8, 10));
  if (startDay === 1 || startDay === 16) return 'semimonthly';
  if (span <= 15) return 'biweekly';
  if (span >= 26) return 'monthly';
  return key || 'semimonthly';
}

/** Where are we in the reminder window for this cycle? */
function windowState(cycle, now = new Date()) {
  const key = String(cycle || '').toLowerCase().replace(/[-\s]/g, '');
  const p = edmontonParts(now);
  const dom = Number(p.d);
  if (WEEKLY_LIKE.has(key)) {
    const isWeekday = ['Mon', 'Tue', 'Wed', 'Thu'].includes(p.wd);
    return { inWindow: isWeekday, lastCall: p.wd === 'Thu', window: 'Mon-Thu' };
  }
  const ranges = WINDOWS[key] || WINDOWS.semimonthly;
  for (const [start, end] of ranges) {
    if (dom >= start && dom <= end) {
      return { inWindow: true, lastCall: dom === end, window: `${start}-${end}` };
    }
  }
  return { inWindow: false, lastCall: false, window: ranges.map(([a, b]) => `${a}-${b}`).join(',') };
}

Deno.serve(async (req) => {
  try {
    const b44 = createClientFromRequest(req);
    await requireAdminIfAuthenticated(b44);
    const body = await req.json().catch(() => ({}));
    const dryRun = body?.dry_run !== false; // SAFE DEFAULT: no sends

    const db = b44.asServiceRole.entities;
    const [payrolls, appUsers] = await Promise.all([
      listAll(db.Payroll, '-pay_period_end'),
      listAll(db.AppUser),
    ]);

    const userByUserId = new Map();
    for (const u of appUsers) if (u?.user_id) userByUserId.set(String(u.user_id), u);

    const today = edmontonTodayKey();

    // ── SCOPE: the current arrears window only ────────────────────────────
    // Owner correction (Nov 21 2026): chasing must look at the CURRENT period
    // (Nov 1-15), not each driver's own last finished cycle — that reached back
    // to May/June and flagged former drivers as arrears. So: take the newest
    // finished period end across the whole table, then keep only records that
    // ended within 7 days of it. Older history is never arrears.
    const finishedEnds = payrolls
      .map((r) => dayOnly(r?.pay_period_end))
      .filter((e) => !!e && e < today)
      .sort();
    const maxEnd = finishedEnds.length ? finishedEnds[finishedEnds.length - 1] : null;
    const windowStart = maxEnd
      ? new Date(new Date(`${maxEnd}T00:00:00Z`).getTime() - 7 * 86400000).toISOString().slice(0, 10)
      : null;

    // Most recent finished cycle per driver INSIDE that window.
    const latest = new Map();
    for (const r of payrolls) {
      const driverId = r?.driver_id;
      const end = dayOnly(r?.pay_period_end);
      if (!driverId || !end || end >= today) continue;   // unfinished cycles never count
      if (windowStart && end < windowStart) continue;    // stale cycles are not arrears
      const cur = latest.get(driverId);
      if (!cur || end > dayOnly(cur.pay_period_end)) latest.set(driverId, r);
    }

    const owed = [];
    const blankPaid = [];
    let totalOwed = 0;

    for (const [driverId, r] of latest) {
      const net = round2(r.gross_pay);      // SWAPPED: gross_pay IS the true net
      const u = userByUserId.get(String(driverId));
      const name = r.driver_name || u?.user_name || 'Driver';
      // Cycle comes from the PERIOD SPAN, not the stored label (see deriveCycle).
      const cycle = deriveCycle(r.pay_period_type, dayOnly(r.pay_period_start), dayOnly(r.pay_period_end));

      if (isBlank(r.paid_amount)) {
        blankPaid.push({ driver_id: driverId, driver_name: name, net_owed: net, period_end: dayOnly(r.pay_period_end) });
        continue;
      }
      const paid = round2(r.paid_amount);
      const stillOwed = round2(net - paid);
      if (stillOwed <= 0.005) continue;

      const ws = windowState(cycle);
      // UNPAID = nothing entered at all for this cycle. OWING = a partial payment
      // was recorded and the rest is short. The owner wants the two counted
      // separately ("2 owing, 1 unpaid").
      const isUnpaid = paid <= 0.005;
      owed.push({
        driver_id: driverId, driver_name: name, cycle,
        period_start: dayOnly(r.pay_period_start), period_end: dayOnly(r.pay_period_end),
        net_owed: net, paid, owed: stillOwed,
        unpaid: isUnpaid, owing: !isUnpaid,
        in_window: ws.inWindow, last_call: ws.lastCall, window: ws.window,
      });
      totalOwed = round2(totalOwed + stillOwed);
    }
    owed.sort((a, b) => b.owed - a.owed);

    // ── Message plan ───────────────────────────────────────────────────────
    const driverMessages = owed
      .filter((d) => d.in_window)
      .map((d) => ({
        driver_id: d.driver_id,
        driver_name: d.driver_name,
        title: d.paid <= 0.005 ? `Payroll: ${money(d.owed)} still owing` : `Payroll: ${money(d.owed)} still owing`,
        body: `${d.period_start} to ${d.period_end}: you were paid ${money(d.paid)} of ${money(d.net_owed)}.`
          + (d.last_call
            ? ` If ${money(d.paid)} is correct, the remaining ${money(d.owed)} moves to your next pay period tomorrow.`
            : ' Update the Paid amount in the app if this is wrong.'),
        url: '/payroll',
        tag: `payroll-owed-${d.period_end}`,
      }));

    const owingCount = owed.filter((d) => d.owing).length;
    const unpaidCount = owed.filter((d) => d.unpaid).length;
    const parts = [];
    if (owingCount) parts.push(`${owingCount} owing`);
    if (unpaidCount) parts.push(`${unpaidCount} unpaid`);

    const riyazTitle = owed.length
      ? `Payroll ${owed[0].period_start} to ${owed[0].period_end}: ${parts.join(', ')} (${money(totalOwed)})`
      : 'Payroll: nobody owes money';
    const riyazBody = owed.length
      ? owed.map((d) => `${d.driver_name} ${d.unpaid ? 'unpaid' : 'owing'} ${money(d.owed)}`).join(', ')
      : 'Every driver in this period is paid in full.';

    // Owner gets the rollover push on the last-call day only.
    const rollover = owed.filter((d) => d.last_call);
    const ownerTitle = rollover.length
      ? `${rollover.length} payroll amount${rollover.length === 1 ? '' : 's'} rolling over`
      : null;
    const ownerBody = rollover.length
      ? rollover.map((d) => `${d.driver_name} ${money(d.owed)}`).join(', ') + ' rolls into the next pay period tomorrow morning.'
      : null;

    // ── Resolve recipients ─────────────────────────────────────────────────
    const findUserId = (explicit, nameMatch) => {
      if (explicit) return String(explicit);
      const hit = appUsers.find((u) => String(u.user_name || '').toLowerCase().includes(nameMatch));
      return hit?.user_id || hit?.id || null;
    };
    const riyazUserId = findUserId(body?.riyaz_user_id, 'riyaz');
    const ownerUserId = findUserId(body?.owner_user_id, 'robert');

    const plan = {
      checked_at: new Date().toISOString(),
      today,
      dry_run: dryRun,
      owed,
      blank_paid: blankPaid,
      count: owed.length,
      owing_count: owingCount,
      unpaid_count: unpaidCount,
      total_owed: totalOwed,
      driver_messages: driverMessages,
      riyaz: { user_id: riyazUserId, title: riyazTitle, body: riyazBody, url: '/payroll' },
      owner: { user_id: ownerUserId, title: ownerTitle, body: ownerBody, url: '/payroll' },
      sends: [],
    };

    if (dryRun) return Response.json(plan);

    // ── Live sends ─────────────────────────────────────────────────────────
    for (const msg of driverMessages) {
      const res = await sendPushToUser(b44, msg.driver_id, msg.title, msg.body, msg.url, msg.tag);
      plan.sends.push({ kind: 'driver', to: msg.driver_name, user_id: msg.driver_id, ...res });
    }

    let riyazResult = null;
    if (riyazUserId && owed.length) {
      riyazResult = await sendPushToUser(b44, riyazUserId, riyazTitle, riyazBody, '/payroll', 'payroll-owed-list');
      plan.sends.push({ kind: 'riyaz', user_id: riyazUserId, ...riyazResult });
    }

    // Owner confirmation: did Riyaz's push actually go out?
    if (ownerUserId) {
      const confirmTitle = 'Payroll reminder status';
      const confirmBody = owed.length
        ? (riyazResult?.sent
          ? `Riyaz was sent the list of ${owed.length} unpaid driver${owed.length === 1 ? '' : 's'} (${riyazResult.sent} device${riyazResult.sent === 1 ? '' : 's'}).`
          : `Riyaz's reminder did NOT go out${riyazResult?.subscribed === false ? ' (no push subscription on his account)' : ''}.`)
        : 'No arrears today, nothing sent to Riyaz.';
      const ownerRes = await sendPushToUser(b44, ownerUserId, confirmTitle, confirmBody, '/payroll', 'payroll-reminder-status');
      plan.sends.push({ kind: 'owner_status', user_id: ownerUserId, ...ownerRes });
    }

    if (ownerUserId && ownerTitle) {
      const rolloverRes = await sendPushToUser(b44, ownerUserId, ownerTitle, ownerBody, '/payroll', 'payroll-rollover');
      plan.sends.push({ kind: 'owner_rollover', user_id: ownerUserId, ...rolloverRes });
    }

    return Response.json(plan);
  } catch (err) {
    return Response.json({ error: err?.message || String(err) }, { status: err?.status || 500 });
  }
});
