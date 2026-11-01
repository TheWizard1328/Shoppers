/* global Deno */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ═══════════════════════════════════════════════════════════════════════════
// freezePayrollKmOverrides — Freeze Paid Km Overrides at payroll finalize
// ═══════════════════════════════════════════════════════════════════════════
//
// OWNER SPEC (Nov 1 2026): "when a driver clicks Confirm My Payroll or an admin
// clicks Finalize All, update all of the Paid Km Overrides for all deliveries
// that are >10km for the Patient Km with the Patient Km ... so any finalized
// payrolls do not get altered if a patient's Km is altered on a future date."
//
// One driver, one pay cycle per call. Payroll math already prefers
// delivery.paid_km_override when > 0 and falls back to the patient's
// distance_from_store otherwise — so once the override is stamped, a later edit
// to the patient's distance can no longer move a finalized payroll.
//
// Rule: for every delivery in the window whose PATIENT km exceeds the 10 km
// free limit, set paid_km_override = that patient km (2dp). Deliveries at or
// under 10 km pay no extra km, so they are left untouched (no override churn on
// thousands of rows). InterStore rows carry no patient_id and are skipped.
//
// Writes are USER-SCOPED (not asServiceRole) on purpose: each update must fire
// its own WebSocket broadcast so other devices converge without a manual
// refresh (same reasoning as bulkUpdateDeliveries).

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FREE_KM_LIMIT = 10;
const round2 = (n) => Math.round(Number(n) * 100) / 100;

function pageAll(fn, query, pageSize = 500, maxRows = 20000) {
  const out = [];
  let skip = 0;
  while (skip < maxRows) {
    const rows = fn(query, skip, pageSize);
    const list = Array.isArray(rows) ? rows : (rows?.data || []);
    if (!list.length) break;
    out.push(...list);
    if (list.length < pageSize) break;
    skip += pageSize;
  }
  return out;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const driverId = String(body?.driver_id || '').trim();
    const periodStart = String(body?.period_start || '').slice(0, 10);
    const periodEnd = String(body?.period_end || '').slice(0, 10);
    const dryRun = body?.dry_run === true;

    if (!driverId) return Response.json({ error: 'driver_id is required' }, { status: 400 });
    if (!DATE_RE.test(periodStart) || !DATE_RE.test(periodEnd)) {
      return Response.json({ error: 'period_start and period_end must be YYYY-MM-DD' }, { status: 400 });
    }
    if (periodEnd < periodStart) {
      return Response.json({ error: 'period_end must be on or after period_start' }, { status: 400 });
    }

    // ── 1. Deliveries for this driver inside the pay cycle ──────────────────
    const deliveries = [];
    for (let skip = 0; skip < 20000; skip += 500) {
      const rows = await base44.entities.Delivery.filter(
        { driver_id: driverId, delivery_date: { $gte: periodStart, $lte: periodEnd } },
        'delivery_date',
        500,
        skip
      ).catch(() => []);
      const list = Array.isArray(rows) ? rows : [];
      deliveries.push(...list);
      if (list.length < 500) break;
    }

    // Patient-backed rows only (ISD/ISP inter-store rows have no patient).
    const candidates = deliveries.filter((d) => d && d.patient_id && d.id && d.status !== 'cancelled');
    if (!candidates.length) {
      return Response.json({ success: true, driver_id: driverId, period_start: periodStart, period_end: periodEnd, scanned: deliveries.length, updated: 0, unchanged: 0, skipped_under_limit: 0, skipped_no_patient_km: 0 });
    }

    // ── 2. Patient km for those patients (chunked id lookups) ───────────────
    const patientIds = [...new Set(candidates.map((d) => String(d.patient_id)))];
    const patientKmById = new Map();
    for (let i = 0; i < patientIds.length; i += 100) {
      const chunk = patientIds.slice(i, i + 100);
      const rows = await base44.entities.Patient.filter({ id: { $in: chunk } }, null, 200, 0).catch(() => []);
      for (const p of (Array.isArray(rows) ? rows : [])) {
        const km = Number(p?.distance_from_store);
        if (Number.isFinite(km) && km > 0) patientKmById.set(String(p.id), km);
      }
    }

    // ── 3. Decide the freezes ───────────────────────────────────────────────
    const updates = [];
    let unchanged = 0;
    let underLimit = 0;
    let noPatientKm = 0;
    for (const d of candidates) {
      const patientKm = patientKmById.get(String(d.patient_id));
      if (!Number.isFinite(patientKm) || patientKm <= 0) { noPatientKm += 1; continue; }
      if (patientKm <= FREE_KM_LIMIT) { underLimit += 1; continue; }
      const target = round2(patientKm);
      const current = Number(d.paid_km_override);
      if (Number.isFinite(current) && current > 0 && Math.abs(current - target) < 0.005) { unchanged += 1; continue; }
      updates.push({ id: String(d.id), paid_km_override: target });
    }

    if (dryRun || !updates.length) {
      return Response.json({
        success: true,
        dry_run: dryRun,
        driver_id: driverId,
        period_start: periodStart,
        period_end: periodEnd,
        scanned: deliveries.length,
        candidates: candidates.length,
        updated: 0,
        would_update: updates.length,
        unchanged,
        skipped_under_limit: underLimit,
        skipped_no_patient_km: noPatientKm,
        sample: updates.slice(0, 10)
      });
    }

    // ── 4. Write them (user-scoped → each write broadcasts over WS) ─────────
    let updated = 0;
    const failed = [];
    for (let i = 0; i < updates.length; i += 20) {
      const chunk = updates.slice(i, i + 20);
      const results = await Promise.allSettled(chunk.map((u) =>
        base44.entities.Delivery.update(u.id, { paid_km_override: u.paid_km_override })
      ));
      results.forEach((r, idx) => {
        if (r.status === 'fulfilled') updated += 1;
        else failed.push({ id: chunk[idx].id, error: r.reason?.message || 'update failed' });
      });
    }

    if (failed.length) console.warn(`[freezePayrollKmOverrides] ${failed.length}/${updates.length} writes failed for driver ${driverId}`);
    console.log(`[freezePayrollKmOverrides] driver=${driverId} ${periodStart}..${periodEnd} frozen=${updated} unchanged=${unchanged} under10=${underLimit} noKm=${noPatientKm}`);

    return Response.json({
      success: failed.length === 0,
      driver_id: driverId,
      period_start: periodStart,
      period_end: periodEnd,
      scanned: deliveries.length,
      candidates: candidates.length,
      updated,
      unchanged,
      skipped_under_limit: underLimit,
      skipped_no_patient_km: noPatientKm,
      failed_count: failed.length,
      sample_failures: failed.slice(0, 5)
    });
  } catch (error) {
    console.error('[freezePayrollKmOverrides] error:', error?.message || error);
    return Response.json({ error: error?.message || 'Unexpected error' }, { status: 500 });
  }
});
