// checkCallingwoodArrival — geofence probe for the owner's Callingwood arrival
// reminder (owner request Oct 22 2026: "remind me tomorrow when I reach
// Callingwood or I'm on my way there"). Called every 10 minutes on Oct 23 2026
// by the Superagent "Callingwood Arrival Reminder" workflow via the Superagent
// app's pollCallingwoodArrival relay function.
//
// Unauthenticated-safe (polled from a scheduled workflow with no session):
// reads Robert's live AppUser GPS via service role, and when he is inside the
// ~2 km zone around the Callingwood shopping centre on the expected Edmonton
// date, CLAIMS a one-shot AppSettings marker so repeat polls never re-claim.
// Only booleans are returned — no coordinates, no personal data over the
// public URL.
//
// Returns:
//   { in_zone: false, reason: "wrong_day", today }        — before/after Oct 23 MDT
//   { in_zone: false, reason: "no_gps" }                  — no coords on his AppUser
//   { in_zone: false, reason: "outside" }                 — GPS outside the zone
//   { in_zone: true, already_sent: true }                 — in zone, reminder already fired
//   { in_zone: true, already_sent: false, claimed: true } — in zone, FIRST detection (claim)

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  const base44 = await createClientFromRequest(req);

  const EXPECTED_DATE = '2026-10-23';        // Edmonton calendar date
  const OWNER_USER_ID = '68570f3cd01bfa2d2408a9d7';
  const CENTER_LAT = 53.50162;               // Callingwood pickup (route stop)
  const CENTER_LNG = -113.62892;
  const RADIUS = 0.018;                      // ~2 km box
  const MARKER_KEY = 'callingwood_reminder_fired_at';

  // ── Date guard: never claim outside Oct 23 Edmonton time ──────────────────
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton' }).format(new Date());
  if (today !== EXPECTED_DATE) {
    return Response.json({ in_zone: false, reason: 'wrong_day', today });
  }

  try {
    // ── One-shot marker check (AppSettings) ────────────────────────────────
    const existing = await base44.asServiceRole.entities.AppSettings.filter({ setting_key: MARKER_KEY }).catch(() => []);
    if (existing && existing.length > 0) {
      // Already fired once — stay quiet but report in-zone so the workflow
      // doesn't think the poll failed.
      return Response.json({ in_zone: true, already_sent: true });
    }

    // ── Robert's live GPS ───────────────────────────────────────────────────
    const rows = await base44.asServiceRole.entities.AppUser.filter({ user_id: OWNER_USER_ID }).catch(() => []);
    const owner = rows && rows[0];
    if (!owner || owner.current_latitude == null || owner.current_longitude == null) {
      return Response.json({ in_zone: false, reason: 'no_gps' });
    }
    const lat = Number(owner.current_latitude);
    const lng = Number(owner.current_longitude);
    const inZone = Math.abs(lat - CENTER_LAT) <= RADIUS && Math.abs(lng - CENTER_LNG) <= RADIUS;
    if (!inZone) {
      return Response.json({ in_zone: false, reason: 'outside' });
    }

    // ── First detection: claim the one-shot marker NOW (atomic-first-wins) ──
    await base44.asServiceRole.entities.AppSettings.create({
      setting_key: MARKER_KEY,
      setting_value: { fired_at: new Date().toISOString() },
      description: 'One-shot marker: Callingwood arrival reminder fired (owner request Oct 22 2026)',
    }).catch(() => {});

    return Response.json({ in_zone: true, already_sent: false, claimed: true });
  } catch (e) {
    return Response.json({ in_zone: false, reason: 'error', error: String(e?.message || e).slice(0, 120) });
  }
});
