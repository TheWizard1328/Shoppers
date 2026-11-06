/**
 * reopenDutyOnRestart — clears the clock-out leg when a stop is restarted.
 *
 * OWNER DIRECTIVE (Nov 5 2026): if a driver (or an administrator acting for
 * them) restarts ANY stop while that driver is OFF DUTY on the current date,
 * the clock-out time on the final activity leg must be cleared. Otherwise the
 * driver goes back to work with a closed day: the restart re-opens the route,
 * but DriverDailyActivity still says they clocked out, so time on duty stops
 * accruing and the day reads as finished.
 *
 * Behaviour:
 *   • same-date guard — only today's record is touched; a restart on a
 *     past/future dated stop must never reopen today's duty.
 *   • the LAST leg with an end_time has its end_time/tot cleared, turning it
 *     back into the open leg (breaks stay closed; earlier legs are untouched).
 *   • the driver's AppUser.driver_status goes back to on_duty so the 15s duty
 *     ticker treats the open leg as live.
 *   • IDB is written first (a device with weak signal still shows the right
 *     number), then the server; a server failure is non-fatal.
 *   • the record is dispatched on `driverActivityUpdated` so the stats cards
 *     and duty ticker refresh immediately instead of on their next pull.
 */

const localDateString = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export async function reopenDutyOnRestart({ driverId, deliveryDate } = {}) {
  if (!driverId || !deliveryDate) return { skipped: 'missing_args' };

  const today = localDateString();
  if (String(deliveryDate).slice(0, 10) !== today) return { skipped: 'not_today' };

  let base44 = null;
  try {
    ({ base44 } = await import('@/api/base44Client'));
  } catch (_) {
    return { skipped: 'no_client' };
  }

  // ── 1. Which AppUser is this driver, and are they off duty? ───────────────
  // Delivery.driver_id holds the AUTH user id, which is AppUser.user_id —
  // never AppUser.id (identity trap, Nov 3 2026).
  let driverAppUser = null;
  try {
    const byUserId = await base44.entities.AppUser.filter({ user_id: driverId });
    driverAppUser = (Array.isArray(byUserId) ? byUserId : []).find((u) => u?.user_id === driverId) || null;
    if (!driverAppUser) {
      const all = await base44.entities.AppUser.list();
      driverAppUser = (Array.isArray(all) ? all : []).find((u) => u?.user_id === driverId || u?.id === driverId) || null;
    }
  } catch (_) { /* status unknown — the segment check below still decides */ }

  // ── 2. Today's activity record ───────────────────────────────────────────
  let record = null;
  try {
    const rows = await base44.entities.DriverDailyActivity.filter(
      { driver_id: driverId, activity_date: today },
      '-created_date',
      5
    );
    const list = Array.isArray(rows) ? rows : [];
    record = list.find((r) => Array.isArray(r?.activity_segments) && r.activity_segments.length > 0) || list[0] || null;
  } catch (_) {
    return { skipped: 'no_record' };
  }
  if (!record) return { skipped: 'no_record' };

  const segments = Array.isArray(record.activity_segments) ? [...record.activity_segments] : [];
  if (segments.length === 0) return { skipped: 'no_segments' };

  const hasOpenLeg = segments.some((s) => s?.start_time && !s?.end_time);
  const driverStatus = driverAppUser?.driver_status || null;
  // Owner spec: off duty. A restart also implies the driver is working again,
  // so a closed final leg with a missing/unknown status is reopened too.
  if (driverStatus && driverStatus !== 'off_duty') return { skipped: 'not_off_duty' };
  if (hasOpenLeg) return { skipped: 'already_open' };

  // ── 3. Clear the clock-out on the FINAL leg only ─────────────────────────
  let lastIdx = -1;
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (segments[i]?.start_time) { lastIdx = i; break; }
  }
  if (lastIdx === -1) return { skipped: 'no_openable_leg' };

  const clearedEndTime = segments[lastIdx]?.end_time || null;
  segments[lastIdx] = { ...segments[lastIdx], end_time: null, tot: null };
  const updated = { ...record, activity_segments: segments };

  // ── 4. IDB first, then server, then tell the UI ──────────────────────────
  try {
    const { offlineDB } = await import('./offlineDatabase');
    const store = offlineDB?.STORES?.DRIVER_DAILY_ACTIVITY;
    if (store) {
      const existing = await offlineDB.getById(store, record.id).catch(() => null);
      await offlineDB.save(store, { ...(existing || { id: record.id }), ...updated }).catch(() => {});
    }
  } catch (_) { /* IDB degraded — server write below still runs */ }

  try {
    await base44.entities.DriverDailyActivity.update(record.id, { activity_segments: segments });
  } catch (err) {
    console.warn('[Restart] Duty clock-out clear failed on server (kept locally):', err?.message || err);
  }

  // Back on duty so the open leg counts as live time.
  if (driverAppUser?.id && driverStatus !== 'on_duty') {
    base44.entities.AppUser.update(driverAppUser.id, { driver_status: 'on_duty' }).catch(() => null);
  }

  try {
    const { invalidateDriverDailyActivityCache } = await import('./driverDailyActivityCache.js');
    invalidateDriverDailyActivityCache(updated.driver_id, updated.activity_date);
  } catch (_) { /* cache module optional */ }

  window.dispatchEvent(new CustomEvent('driverActivityUpdated', {
    detail: { record: updated, fromRestartReopen: true },
  }));

  return { reopened: true, clearedEndTime, activityDate: today };
}

export default reopenDutyOnRestart;
