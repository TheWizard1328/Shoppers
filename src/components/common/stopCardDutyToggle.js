/**
 * stopCardDutyToggle — extracted from useStopCardActions.jsx (Sep 6 2026).
 * Pure code movement, zero behavior change.
 *
 * Owns the "Start/Restart puts the driver on duty" rule (Robert, 2026-09-03):
 * today-only guard, self vs admin-toggle-for-stop's-driver targeting,
 * optimistic IDB + UI flip with backend-failure revert.
 */
import { useCallback } from "react";
import { setDriverStatus } from "@/functions/setDriverStatus";
import { locationTracker } from "../utils/locationTracker";
import { isAppOwner } from '../utils/userRoles';

export function useStopCardDutyToggle({
  currentUser,
  appUsers,
  delivery,
  localDeviceTodayStr,
  onDriverStatusChange,
  updateDeliveriesLocally,
  userHasRole,
}) {
  const ensureDriverOnline = useCallback(async ({ allowAdminToggleForDriver = false } = {}) => {
    // GUARD 1 (Robert's rule, 2026-09-03): Starting a stop toggles the driver on
    // duty ONLY when the stop is for TODAY. Future-dated or past stops must NOT
    // change the duty status.
    if (delivery?.delivery_date !== localDeviceTodayStr) {
      console.log(`[ensureDriverOnline] Skipped — stop is for ${delivery?.delivery_date}, not today (${localDeviceTodayStr})`);
      return;
    }

    // ── Resolve the TARGET driver ──────────────────────────────────────────────
    // Self case: the acting user starting their own stop → toggle themselves.
    // Admin case (Start/Restart only, allowAdminToggleForDriver): an admin,
    // dispatcher, or app-owner starting or restarting a stop on a driver's behalf
    // → toggle the STOP'S ASSIGNED DRIVER (Robert's rule, 2026-09-03: "when I
    // restarted the stop it should have set the driver status to On Duty if was
    // Off Duty"). The backend setDriverStatus supports targetUserId for this.
    const isOwnStop = !!(currentUser?.id && delivery?.driver_id && currentUser.id === delivery.driver_id);
    let targetUserId = currentUser?.id || null;

    if (!isOwnStop) {
      const canToggleOthers = allowAdminToggleForDriver &&
        (isAppOwner(currentUser) || userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher'));
      if (!canToggleOthers || !delivery?.driver_id) {
        console.log('[ensureDriverOnline] Skipped — actor is not the stop\'s driver and lacks admin toggle permission for this action');
        return;
      }
      targetUserId = delivery.driver_id;
      const targetAppUserCheck = appUsers.find((u) => u?.user_id === delivery.driver_id) || null;
      const targetStatusCheck = targetAppUserCheck?.driver_status || null;
      // Only flip drivers who are off_duty or on_break (or status unknown — the
      // backend validates and is idempotent). Never touch an on_duty driver.
      if (targetStatusCheck === 'on_duty') {
        console.log('[ensureDriverOnline] Skipped — target driver already on_duty');
        return;
      }
      console.log(`[ensureDriverOnline] Admin toggling stop's driver (${targetUserId}) on_duty (current: ${targetStatusCheck || 'unknown'})`);
    }

    // NOTE (self case): We intentionally do NOT early-return if appUsers shows 'on_duty'.
    // The appUsers array can be stale — the driver may have toggled off_duty/on_break
    // via the DriverStatusToggle, but the React state hasn't propagated to the StopCard
    // closure yet. The backend setDriverStatus has its own idempotency guard (NO-OP if
    // already on_duty with open segment), so calling it is always safe.

    // ── OPTIMISTIC FLIP (immediate UI) ──────────────────────────────────────────
    // The backend setDriverStatus takes 5-15s when it runs the on-duty restore
    // tail (setNextDeliveryFlag + refetch + regenerateType1Polyline). Flip the
    // local IDB record + UI events NOW; if the backend then fails, revert.
    let optimisticApplied = false;
    let optimisticPrevStatus = null;
    try {
      const { offlineDB } = await import('../utils/offlineDatabase');
      const records = await offlineDB.getByIndex(offlineDB.STORES.APP_USERS, 'user_id', targetUserId).catch(() => []);
      const existingRecord = records?.[0] || null;
      optimisticPrevStatus = existingRecord?.driver_status || null;
      if (optimisticPrevStatus !== 'on_duty') {
        const nowIso = new Date().toISOString();
        const updatedRecord = {
          ...(existingRecord || {}),
          ...(isOwnStop ? currentUser : {}),
          driver_status: 'on_duty',
          location_tracking_enabled: true,
          updated_date: nowIso,
          user_id: targetUserId,
          ...(existingRecord?.id ? { id: existingRecord.id } : {}),
        };
        await offlineDB.save(offlineDB.STORES.APP_USERS, updatedRecord);
        optimisticApplied = true;
        // Snap the DriverStatusToggle + all AppUser-consuming UI to "On" immediately.
        window.dispatchEvent(new CustomEvent('appUserUpdated', { detail: { appUser: updatedRecord } }));
        window.dispatchEvent(new CustomEvent('driverLocationsUpdated', { detail: { appUsers: [updatedRecord], mergeMode: 'merge' } }));
        window.dispatchEvent(new CustomEvent('driverStatusChanged', { detail: { userId: targetUserId, newStatus: 'on_duty' } }));
        console.log(`[ensureDriverOnline] Optimistic on_duty flip applied for ${isOwnStop ? 'self' : 'target driver'} (was: ${optimisticPrevStatus || 'unknown'})`);
      } else {
        console.log('[ensureDriverOnline] Already on_duty locally — no optimistic flip needed');
      }
    } catch (idbErr) {
      console.warn('[ensureDriverOnline] Optimistic flip failed (non-critical, backend will still run):', idbErr?.message);
    }

    // NO-OP GATE (owner spec Oct 14 2026): if the FRESH IDB read (done just above,
    // not stale React state) already shows on_duty, the backend call is a guaranteed
    // idempotent no-op — and a wasted API call on every Accept/Start/Complete during
    // rate-limit storms. Skip it entirely. Fail-open: if the IDB read above threw,
    // optimisticPrevStatus stays null and the backend call proceeds as before.
    if (optimisticPrevStatus === 'on_duty') {
      console.log('[ensureDriverOnline] Skipped backend setDriverStatus — already on_duty (no-op write avoided)');
      return;
    }

    try {
      const { data, appUserId, previousStatus: _prevStatus } = await setDriverStatus({
        newStatus: 'on_duty',
        selectedDate: delivery?.delivery_date || localDeviceTodayStr,
        ...(isOwnStop ? {} : { targetUserId }),
      });
      console.log(`[ensureDriverOnline] Backend confirmed on_duty for ${isOwnStop ? 'self' : `driver ${targetUserId}`} (previousStatus: ${_prevStatus})`);
      const deliveryDate = delivery?.delivery_date;

      // CRITICAL: Update the local IDB AppUser record so a page refresh doesn't
      // show a stale status. IDB is the boot-time source of truth.
      if (appUserId) {
        try {
          const { offlineDB } = await import('../utils/offlineDatabase');
          const existingRecord = await offlineDB.getById(offlineDB.STORES.APP_USERS, appUserId).catch(() => ({})) || {};
          const nowIso = new Date().toISOString();
          const updatedRecord = {
            ...existingRecord,
            ...(isOwnStop ? currentUser : {}),
            driver_status: 'on_duty',
            location_tracking_enabled: true,
            location_updated_at: nowIso,
            updated_date: nowIso,
            id: appUserId,
            user_id: targetUserId,
          };
          await offlineDB.save(offlineDB.STORES.APP_USERS, updatedRecord);

          // Broadcast to the DriverStatusToggle and all other UI listeners so the
          // toggle visually snaps to "On" without requiring a WebSocket round-trip.
          window.dispatchEvent(new CustomEvent('appUserUpdated', { detail: { appUser: updatedRecord } }));
          window.dispatchEvent(new CustomEvent('driverLocationsUpdated', { detail: { appUsers: [updatedRecord], mergeMode: 'merge' } }));
          window.dispatchEvent(new CustomEvent('driverStatusChanged', { detail: { userId: targetUserId, newStatus: 'on_duty' } }));

          // Fetch the current route deliveries (backend has set isNextDelivery) and
          // push them to IDB + UI immediately so the stop cards reflect the new flag
          // without waiting for the next smart refresh cycle.
          // Skip when the driver was already on_duty — the flags are already correct
          // and the refetch would clobber any optimistic writes from the Start action.
          if (deliveryDate && _prevStatus !== 'on_duty') {
            try {
              const { base44 } = await import('@/api/base44Client');
              // Owner rule (Oct 16 2026): a REAL transition into on_duty — the
              // driver resumes, or a dispatcher/admin triggers them on from a stop
              // card — re-anchors ALL remaining stops' ETAs from the driver's
              // current position. POLYLINE FIRST (owner spec): project the
              // driver's position onto the next stop's leg polyline and chain the
              // ETA calculator — ZERO API calls. Off-path / missing leg → full
              // fallback: one backend router call chains the whole route. The
              // refetch below lands the fresh ETAs in the same pull either way.
              let _dutyEtaApplied = false;
              try {
                const freshDeliveriesPre = await base44.entities.Delivery.filter({
                  driver_id: targetUserId,
                  delivery_date: deliveryDate,
                });
                const TERMINAL_DUTY = ['completed', 'failed', 'cancelled'];
                const orderedStops = (freshDeliveriesPre || [])
                  .filter((d) => d && d.status !== 'pending' && !TERMINAL_DUTY.includes(String(d.status || '').toLowerCase()))
                  .sort((a, b) => (Number(a?.stop_order) || 0) - (Number(b?.stop_order) || 0));
                if (orderedStops.length > 0) {
                  const { computeDutyResumeEtas } = await import('../utils/onDutyPolylineEta');
                  const { commitDeliveryUpdatesSilently, fireRouteCommitMarker } = await import('../utils/routeCommitMarker');
                  // Driver's current position: fresh IDB APP_USERS read first
                  // (the driver's own device uploads every 15s), state fallback.
                  let _driverRec = null;
                  try {
                    const _recs = await offlineDB.getByIndex(offlineDB.STORES.APP_USERS, 'user_id', targetUserId).catch(() => []);
                    _driverRec = _recs?.[0] || null;
                  } catch (_) {}
                  if (!_driverRec) _driverRec = appUsers.find((u) => u?.user_id === targetUserId) || null;
                  const nowD = new Date();
                  const proj = computeDutyResumeEtas({
                    orderedStops,
                    currentLocation: {
                      lat: Number(_driverRec?.current_latitude),
                      lng: Number(_driverRec?.current_longitude),
                    },
                    nowMinutes: nowD.getHours() * 60 + nowD.getMinutes(),
                  });
                  if (proj?.mode === 'polyline') {
                    // SINGLE SILENT COMMIT pattern (Accept All, Oct 13): local
                    // event + IDB bulkSave + one silent commit + one marker.
                    const etaById = new Map(proj.etaUpdates.map((u) => [u.id, u.delivery_time_eta]));
                    const etaRecords = orderedStops
                      .map((st) => ({ ...st, delivery_time_eta: etaById.get(st.id) || st.delivery_time_eta }))
                      .filter((st) => etaById.has(st.id));
                    window.dispatchEvent(new CustomEvent('etaUpdated', { detail: { driverId: targetUserId, updates: proj.etaUpdates.map((u) => ({ deliveryId: u.id, newEta: u.delivery_time_eta })) } }));
                    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, etaRecords).catch(() => {});
                    for (const u of proj.etaUpdates) {
                      if (!window.__localDeliveryWrites) window.__localDeliveryWrites = new Map();
                      window.__localDeliveryWrites.set(u.id, Date.now() + 90 * 1000);
                    }
                    const committed = await commitDeliveryUpdatesSilently(proj.etaUpdates.map((u) => ({ id: u.id, data: { delivery_time_eta: u.delivery_time_eta } })));
                    await fireRouteCommitMarker(orderedStops[0].id, committed);
                    console.log(`[ensureDriverOnline] duty-resume polyline ETAs: ${proj.etaUpdates.length} stop(s), first leg ${proj.remainingMinutes}min, ${proj.deviatedMeters}m off-path`);
                    _dutyEtaApplied = true;
                  } else {
                    console.log(`[ensureDriverOnline] duty-resume polyline projection unavailable (${proj?.reason}) — full ETA refresh fallback`);
                  }
                }
              } catch (projErr) {
                console.warn('[ensureDriverOnline] duty-resume polyline ETAs failed (non-blocking):', projErr?.message || projErr);
              }
              if (!_dutyEtaApplied) {
                try {
                  const etaRes = await base44.functions.invoke('refreshDriverEtasOnLocationUpdate', {
                    driverId: targetUserId,
                    deliveryDate,
                    routeChangeSource: 'duty_resume',
                    forceEtaRefresh: true,
                  });
                  console.log(`[ensureDriverOnline] duty-resume ETA refresh: ${etaRes?.total_updated_deliveries || 0} stop(s) updated (reason: ${etaRes?.results?.[0]?.reason || 'updated'})`);
                } catch (etaErr) {
                  console.warn('[ensureDriverOnline] duty-resume ETA refresh failed (non-blocking):', etaErr?.message || etaErr);
                }
              }
              const freshDeliveries = await base44.entities.Delivery.filter({
                driver_id: targetUserId,
                delivery_date: deliveryDate,
              });
              if (freshDeliveries?.length > 0) {
                await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);
                updateDeliveriesLocally?.(freshDeliveries, false);
                window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
                  detail: {
                    triggeredBy: 'ensureDriverOnline',
                    driverId: targetUserId,
                    deliveryDate,
                    freshDeliveries,
                    fullReplacement: false,
                    preserveLocalState: true,
                    trustIsNextDelivery: true,
                  }
                }));
                // Scroll to the next delivery card (self case only — the admin's
                // device doesn't need to scroll the driver's route)
                if (isOwnStop) {
                  const nextStop = freshDeliveries.find(d => d?.isNextDelivery === true);
                  if (nextStop) {
                    setTimeout(() => window.dispatchEvent(new CustomEvent('centerNextDeliveryCard')), 300);
                  }
                }
              }
            } catch (fetchErr) {
              console.warn('[ensureDriverOnline] Could not sync deliveries after status toggle:', fetchErr?.message);
            }
          }
        } catch (idbErr) {
          console.warn('[ensureDriverOnline] IDB update failed (non-critical):', idbErr?.message);
        }
      }
      if (_prevStatus !== 'on_duty') {
        // Self case only: start location tracking on the ACTING user's device.
        if (isOwnStop) {
          try { await locationTracker.startTracking({ ...currentUser, appUserId }); } catch {}
          // Sync liveDistanceTracker internal state (NOT segment writes — those are
          // handled by the backend setDriverStatus function which was just called).
          try {
            const { liveDistanceTracker } = await import('../utils/liveDistanceTracker');
            if (liveDistanceTracker.isTracking) {
              await liveDistanceTracker.updateDriverStatus('on_duty');
            }
          } catch {}
        }
      }
      if (onDriverStatusChange) onDriverStatusChange('on_duty');
    } catch (error) {
      console.error('[ensureDriverOnline] Backend setDriverStatus FAILED:', error?.message || error);
      // Revert the optimistic flip so the UI doesn't lie about a server state
      // that never landed. (The server record is untouched on failure.)
      if (optimisticApplied) {
        const revertStatus = optimisticPrevStatus || 'off_duty';
        try {
          const { offlineDB } = await import('../utils/offlineDatabase');
          const records = await offlineDB.getByIndex(offlineDB.STORES.APP_USERS, 'user_id', targetUserId).catch(() => []);
          const existingRecord = records?.[0] || null;
          if (existingRecord) {
            const nowIso = new Date().toISOString();
            const revertedRecord = { ...existingRecord, driver_status: revertStatus, updated_date: nowIso };
            await offlineDB.save(offlineDB.STORES.APP_USERS, revertedRecord);
            window.dispatchEvent(new CustomEvent('appUserUpdated', { detail: { appUser: revertedRecord } }));
            window.dispatchEvent(new CustomEvent('driverLocationsUpdated', { detail: { appUsers: [revertedRecord], mergeMode: 'merge' } }));
            window.dispatchEvent(new CustomEvent('driverStatusChanged', { detail: { userId: targetUserId, newStatus: revertStatus } }));
            console.warn(`[ensureDriverOnline] Reverted optimistic flip to '${revertStatus}' after backend failure`);
          }
        } catch (revertErr) {
          console.warn('[ensureDriverOnline] Revert after backend failure failed:', revertErr?.message);
        }
      }
    }
  }, [currentUser, appUsers, delivery?.driver_id, delivery?.delivery_date, localDeviceTodayStr, onDriverStatusChange, updateDeliveriesLocally]);

  return { ensureDriverOnline };
}
