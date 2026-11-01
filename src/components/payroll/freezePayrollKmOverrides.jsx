import { base44 } from '@/api/base44Client';

/**
 * freezePayrollKmOverrides (owner spec Nov 1 2026)
 * -------------------------------------------------
 * Called when a driver confirms their payroll or an admin finalizes it, one
 * driver + one pay cycle at a time. On the back end every delivery in the
 * cycle whose PATIENT km is above the 10 km free limit gets
 * paid_km_override = that patient km (2dp), so a patient distance edited on a
 * later date can never move an already-finalized payroll.
 *
 * The backend writes are user-scoped, so each one broadcasts over WebSocket and
 * other devices converge without a manual refresh.
 *
 * Never throws: payroll finalizing must not fail because of this.
 */
export async function freezePayrollKmOverrides({ driverId, periodStart, periodEnd, dryRun = false } = {}) {
  if (!driverId || !periodStart || !periodEnd) {
    return { skipped: true, reason: 'missing_driver_or_period' };
  }
  try {
    const res = await base44.functions.invoke('freezePayrollKmOverrides', {
      driver_id: driverId,
      period_start: periodStart,
      period_end: periodEnd,
      dry_run: dryRun === true,
    });
    const data = res?.data || res || {};
    console.log(
      `[Payroll] Paid km frozen for ${driverId} ${periodStart}..${periodEnd}:`,
      `updated=${data.updated ?? 0} unchanged=${data.unchanged ?? 0} under10=${data.skipped_under_limit ?? 0}`
    );
    return data;
  } catch (error) {
    console.warn('[Payroll] Freeze paid km overrides failed (payroll continues):', error?.message || error);
    return { error: error?.message || 'failed' };
  }
}

export default freezePayrollKmOverrides;
