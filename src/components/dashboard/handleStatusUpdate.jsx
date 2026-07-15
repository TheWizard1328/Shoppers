/**
 * handleStatusUpdate — extracted from Dashboard.jsx to reduce file size.
 * Called as: handleStatusUpdate(deliveryId, newStatus, extraData, skipAutoCenter)
 */
import { base44 } from '@/api/base44Client';
import { format } from 'date-fns';
import { offlineDB } from '@/components/utils/offlineDatabase';
import { pauseOfflineSync, resumeOfflineSync } from '@/components/utils/offlineSync';
import { smartRefreshManager } from '@/components/utils/smartRefreshManager';
import { backgroundSyncManager } from '@/components/utils/backgroundSyncManager';
import { createDeliveryLocal } from '@/components/utils/offlineMutations';
import { notifyDriverCompleted, notifyDriverFailed, notifyDriverRetry } from '@/components/utils/deliveryMessaging';
import { syncFabRefsForPhase } from '@/components/dashboard/handleSimpleDeliveryUpdates';
import { fabControlEvents } from '@/components/utils/fabControlEvents';
import { calculateDistance } from '@/components/dashboard/DashboardHelpers';
import { roundCompletionTime } from '@/components/dashboard/DashboardHelpers';
import { lockDeliveryFields } from '@/components/utils/completionLockout';
import { updatePreferredTravelMode } from '@/components/dashboard/travelModeHelpers';

const getEdmDate = () => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return `${p.find(x => x.type === 'year').value}-${p.find(x => x.type === 'month').value}-${p.find(x => x.type === 'day').value}`;
};

export async function handleStatusUpdate(deliveryId, newStatus, extraData = {}, skipAutoCenter = false, ctx) {
  const {
    statusUpdateLockRef, deliveriesWithStopOrder, mapViewPhase, isMapViewLocked,
    mapLockTimeoutRef, mapLockExpiresAtRef, isMapViewLockedRef, mapViewPhaseRef, pendingPhaseRef,
    setIsMapViewLocked, setIsEntityUpdating, setSelectedCardId, setHighlightedCardId,
    cardExpandedAtRef, showBreadcrumbs, selectedDriverId, setBreadcrumbsData,
    stopCardsBaseHeight, horizontalStopCardsRef, setStopCardsBaseHeight,
    setMapViewPhase, setMapViewTrigger, lastProgrammaticMapMoveRef,
    updateDeliveriesLocally, currentUser, patients, stores, appUsers, drivers,
    isDispatcher, isAdmin, saveSetting, setEndOfDayDriver, setShowEndOfDayStats,
    hasShownSummaryRef, setMapViewPhaseRef, setPreferredTravelMode,
  } = ctx;

  const statusLockKey = `${deliveryId}:${newStatus}`;
  if (statusUpdateLockRef.current.has(statusLockKey)) return;
  statusUpdateLockRef.current.add(statusLockKey);
  let driverId = null, deliveryDate = null, pendingBreadcrumbDriverAppUserId = null;

  setIsEntityUpdating(true);
  pauseOfflineSync();
  smartRefreshManager.pause();
  backgroundSyncManager.pause();

  await new Promise((resolve) => setTimeout(resolve, 100));

  // CRITICAL: Read live refs for phase/lock state — closure values (mapViewPhase,
  // isMapViewLocked) may be stale if the user cycled the FAB after this handler was queued.
  const wasPhase2Locked = mapViewPhaseRef.current === 2 && isMapViewLockedRef.current;
  const currentPhase = mapViewPhaseRef.current;

  if (wasPhase2Locked) {
    // Only clear the timer — do NOT call setIsMapViewLocked(false) here.
    // Unlocking the state causes a React re-render that drops the visual lock
    // for the entire duration of the async handler. The re-lock at the end
    // (syncFabRefsForPhase) will set it back to true; no intermediate unlock needed.
    if (mapLockTimeoutRef.current) { clearTimeout(mapLockTimeoutRef.current); mapLockTimeoutRef.current = null; }
    mapLockExpiresAtRef.current = null;
  }

  document.documentElement.style.setProperty('--theme-transition-duration', '0s');

  try {
    const targetDelivery = deliveriesWithStopOrder.find((d) => d && d.id === deliveryId);
    if (!targetDelivery) throw new Error('Delivery not found');

    // Cycling markers only support in_transit, completed, and pending (restart) — guard all other transitions
    if (targetDelivery.is_cycling_marker && newStatus !== 'in_transit' && newStatus !== 'completed' && newStatus !== 'pending') {
      console.warn(`[handleStatusUpdate] Cycling marker ${deliveryId} cannot be set to status "${newStatus}" — only in_transit, completed, and pending are allowed.`);
      return;
    }

    driverId = targetDelivery.driver_id;
    deliveryDate = targetDelivery.delivery_date;

    const currentDate = getEdmDate();
    const isPickup = !targetDelivery.patient_id;
    const isRetry = targetDelivery.status === 'failed' && (newStatus === 'in_transit' || newStatus === 'en_route');

    if (isRetry) {
      const patient = patients.find((p) => p && p.id === targetDelivery.patient_id);
      const store = stores.find((s) => s && s.id === targetDelivery.store_id);
      const retryDeliveryData = {
        patient_id: targetDelivery.patient_id, store_id: targetDelivery.store_id,
        driver_id: targetDelivery.driver_id, driver_name: targetDelivery.driver_name,
        delivery_date: currentDate, delivery_time_start: targetDelivery.delivery_time_start,
        delivery_time_end: targetDelivery.delivery_time_end,
        status: isPickup ? 'en_route' : 'in_transit',
        delivery_notes: `RETRY From: ${targetDelivery.delivery_date}`,
        patient_name: patient?.full_name || targetDelivery.patient_name || '',
        patient_phone: patient?.phone || targetDelivery.patient_phone || '',
        store_phone: store?.phone || targetDelivery.store_phone || '',
        prescription_number: targetDelivery.prescription_number || '',
        delivery_instructions: targetDelivery.delivery_instructions || '',
        unit_number: targetDelivery.unit_number || '',
        cod_total_amount_required: targetDelivery.cod_total_amount_required || 0,
        signature_needed: targetDelivery.signature_needed || false,
        fridge_item: targetDelivery.fridge_item || false,
        oversized: targetDelivery.oversized || false,
        first_delivery: targetDelivery.first_delivery || false,
        mailbox_ok: targetDelivery.mailbox_ok || false,
        call_upon_arrival: targetDelivery.call_upon_arrival || false,
        ring_bell: targetDelivery.ring_bell || false,
        dont_ring_bell: targetDelivery.dont_ring_bell || false,
        back_door: targetDelivery.back_door || false
      };
      await createDeliveryLocal(retryDeliveryData);
      const { invalidate } = await import('@/components/utils/dataManager');
      const { refreshData } = ctx;
      invalidate('Delivery');
      await refreshData();
      return;
    }

    const currentTime = new Date();
    const _h = String(currentTime.getHours()).padStart(2, '0');
    const _m = String(currentTime.getMinutes()).padStart(2, '0');
    const _s = String(currentTime.getSeconds()).padStart(2, '0');
    const _yr = currentTime.getFullYear();
    const _mo = String(currentTime.getMonth() + 1).padStart(2, '0');
    const _dy = String(currentTime.getDate()).padStart(2, '0');
    let currentTimeISO = `${_yr}-${_mo}-${_dy}T${_h}:${_m}:${_s}`;

    // Rule: pickups must always be en_route unless completed or cancelled
    const resolvedStatus = isPickup && newStatus !== 'completed' && newStatus !== 'cancelled'
      ? 'en_route'
      : newStatus;

    const updateData = { status: resolvedStatus, ...extraData };

    if (newStatus === 'completed' && targetDelivery.cod_total_amount_required > 0) {
      const hasCODPayments = targetDelivery.cod_payments && Array.isArray(targetDelivery.cod_payments) && targetDelivery.cod_payments.length > 0 && targetDelivery.cod_payments.some((p) => p?.amount > 0);
      if (!hasCODPayments) { updateData.cod_payments = [{ type: 'Cash', amount: targetDelivery.cod_total_amount_required }]; }
    }

    if (newStatus === 'in_transit' || newStatus === 'en_route') {
      const now = new Date();
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      const startMinutes = currentMinutes + 5;
      updateData.delivery_time_start = `${String(Math.floor(startMinutes / 60) % 24).padStart(2, '0')}:${String(startMinutes % 60).padStart(2, '0')}`;
    }

    // Cycling marker "Start" (jump-queue): regular deliveries always start via
    // handleStartAction (which reorders the route and reassigns isNextDelivery), but
    // cycling markers only ever route through this generic handler. Without this, tapping
    // Start on a cycling marker that isn't already the active stop would leave isNextDelivery
    // untouched — fill that gap here, mirroring the same promote/demote pattern used below
    // for the completed/failed/cancelled path.
    const isCyclingMarkerStart = targetDelivery.is_cycling_marker && (newStatus === 'in_transit' || newStatus === 'en_route');
    if (isCyclingMarkerStart) {
      updateData.isNextDelivery = true;
    }

    if (['completed', 'failed', 'cancelled'].includes(newStatus)) {
      updateData.isNextDelivery = false;
      const finishedStatuses = ['completed', 'failed', 'cancelled'];
      const completedStops = deliveriesWithStopOrder.filter((d) => d && d.driver_id === driverId && d.delivery_date === deliveryDate && finishedStatuses.includes(d.status)).sort((a, b) => { if (!a.actual_delivery_time || !b.actual_delivery_time) return 0; return new Date(a.actual_delivery_time) - new Date(b.actual_delivery_time); });

      if (completedStops.length === 0) { updateData.travel_dist = 0; } else {
        const lastStop = completedStops[completedStops.length - 1];
        let lastLat, lastLon, currentLat, currentLon;
        if (lastStop.is_cycling_marker) { lastLat = lastStop.cycling_latitude; lastLon = lastStop.cycling_longitude; }
        else if (lastStop.patient_id) { const lp = patients.find((p) => p && p.id === lastStop.patient_id); lastLat = lp?.latitude; lastLon = lp?.longitude; } else if (lastStop.store_id) { const ls = stores.find((s) => s && s.id === lastStop.store_id); lastLat = ls?.latitude; lastLon = ls?.longitude; }
        if (targetDelivery.is_cycling_marker) { currentLat = targetDelivery.cycling_latitude; currentLon = targetDelivery.cycling_longitude; }
        else if (targetDelivery.patient_id) { const cp = patients.find((p) => p && p.id === targetDelivery.patient_id); currentLat = cp?.latitude; currentLon = cp?.longitude; } else if (targetDelivery.store_id) { const cs = stores.find((s) => s && s.id === targetDelivery.store_id); currentLat = cs?.latitude; currentLon = cs?.longitude; }
        if (lastLat && lastLon && currentLat && currentLon) { updateData.travel_dist = Math.round(calculateDistance(lastLat, lastLon, currentLat, currentLon) * 100) / 100; } else { updateData.travel_dist = 0; }
      }

      const driverAppUser = (appUsers || []).find((user) => user?.user_id === driverId);
      pendingBreadcrumbDriverAppUserId = driverAppUser?.id || null;
      const pendingBreadcrumbs = pendingBreadcrumbDriverAppUserId ? await offlineDB.getById(offlineDB.STORES.PENDING_BREADCRUMBS, pendingBreadcrumbDriverAppUserId) : null;
      if (Array.isArray(pendingBreadcrumbs?.breadcrumbs) && pendingBreadcrumbs.breadcrumbs.length) { updateData.delivery_route_breadcrumbs = JSON.stringify(pendingBreadcrumbs.breadcrumbs); }
    }

    if (['completed', 'failed', 'cancelled'].includes(newStatus)) {
      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
      const allDriverStops = deliveriesWithStopOrder.filter((d) => d && d.driver_id === driverId && d.delivery_date === deliveryDate);
      const completedStopsCount = allDriverStops.filter((d) => finishedStatuses.includes(d.status)).length;
      const isFirstStop = completedStopsCount === 0;
      const incompleteStopsCount = allDriverStops.filter((d) => !finishedStatuses.includes(d.status)).length;
      const isLastStop = incompleteStopsCount === 1;
      if (isFirstStop || isLastStop) { currentTimeISO = roundCompletionTime(currentTimeISO); }
      updateData.actual_delivery_time = currentTimeISO;
      // Cycling markers don't go through handleStartDelivery so set arrival_time here too
      if (targetDelivery.is_cycling_marker && !updateData.arrival_time) {
        updateData.arrival_time = currentTimeISO;
      }
    } else { updateData.actual_delivery_time = null; }

    if (['completed', 'failed', 'cancelled'].includes(newStatus)) { setSelectedCardId(null); setHighlightedCardId(null); cardExpandedAtRef.current = null; }

    // When a Cycling Route End marker is completed, revert travel mode to driving
    if (newStatus === 'completed' && targetDelivery.is_cycling_marker &&
        (targetDelivery.delivery_notes || '').toLowerCase().includes('end')) {
      updatePreferredTravelMode(appUsers, driverId, 'driving').catch(() => {});
      const { setPreferredTravelMode } = ctx;
      setPreferredTravelMode?.('driving');
    }

    const targetRecord = { ...targetDelivery, ...updateData };
    const siblingUpdates = [];
    if (isCyclingMarkerStart) {
      const allDDFStart = deliveriesWithStopOrder.filter((d) => d && d.driver_id === driverId && d.delivery_date === deliveryDate);
      allDDFStart.filter((d) => d.isNextDelivery && d.id !== deliveryId).forEach((d) => {
        siblingUpdates.push({ id: d.id, record: { ...d, isNextDelivery: false } });
      });
    }
    if (['completed', 'failed', 'cancelled'].includes(newStatus)) {
      const allDDF = deliveriesWithStopOrder.filter((d) => d && d.driver_id === driverId && d.delivery_date === deliveryDate);
      allDDF.filter((d) => d.isNextDelivery && d.id !== deliveryId).forEach((d) => { siblingUpdates.push({ id: d.id, record: { ...d, isNextDelivery: false } }); });
      // Sort incomplete non-pending stops by stop_order — cycling markers are eligible here too
      const inc = allDDF
        .filter((d) => d.id !== deliveryId && !['completed', 'failed', 'cancelled'].includes(d.status) && d.status !== 'pending')
        .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
      if (inc.length > 0) {
        const nextStop = inc[0];
        const existingIdx = siblingUpdates.findIndex((s) => s.id === nextStop.id);
        if (existingIdx >= 0) {
          siblingUpdates[existingIdx].record.isNextDelivery = true;
        } else {
          siblingUpdates.push({ id: nextStop.id, record: { ...nextStop, isNextDelivery: true } });
        }
        // Log when a cycling marker is promoted to next stop
        if (nextStop.is_cycling_marker) {
          console.log(`[handleStatusUpdate] Promoting cycling marker ${nextStop.id} (${nextStop.delivery_notes}) to isNextDelivery=true`);
        }
      }
    }

    const allAffectedRecords = [targetRecord, ...siblingUpdates.map((s) => s.record)];
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, allAffectedRecords);

    // CRITICAL: Lock isNextDelivery (and status for the completed stop) against WebSocket
    // reversion BEFORE dispatching the optimistic UI update. The backend fires 2-3 rapid
    // WebSocket events during this transition; without lockout the intermediate events would
    // briefly flip the badge back to the old stop, causing the visible bounce.
    lockDeliveryFields(deliveryId, ['status', 'isNextDelivery']);
    siblingUpdates.forEach((s) => lockDeliveryFields(s.id, ['isNextDelivery']));

    if (updateDeliveriesLocally) {
      const uiPatches = [targetRecord, ...siblingUpdates.map((s) => ({ id: s.id, isNextDelivery: s.record.isNextDelivery }))];
      updateDeliveriesLocally(uiPatches, false);
    }

    await Promise.all(allAffectedRecords.map((rec) => base44.entities.Delivery.update(rec.id, rec)));
    window.dispatchEvent(new CustomEvent('deliveryUpdated', { detail: { deliveryId, affectedIds: allAffectedRecords.map((r) => r.id), updates: updateData, driverId, deliveryDate, source: 'statusUpdate' } }));
    if (pendingBreadcrumbDriverAppUserId) {
      await offlineDB.deleteRecord(offlineDB.STORES.PENDING_BREADCRUMBS, pendingBreadcrumbDriverAppUserId);
      if (showBreadcrumbs && selectedDriverId === driverId) setBreadcrumbsData((prev) => ({ ...prev, current: [] }));
    }

    if (['completed', 'failed'].includes(newStatus) && targetDelivery.patient_id) {
      base44.entities.Patient.update(targetDelivery.patient_id, { last_delivery_date: deliveryDate }).catch((error) => console.warn('⚠️ Patient last_delivery_date update failed:', error));
    }

    // If a pickup (no patient_id) is completed and any linked delivery has fridge_item=true,
    // fire an event to show the fridge temperature dialog.
    if (newStatus === 'completed' && !targetDelivery.patient_id) {
      const hasFridgeLinkedDelivery = deliveriesWithStopOrder.some(
        (d) => d && d.puid === targetDelivery.puid && d.fridge_item === true && d.id !== deliveryId
      );
      if (hasFridgeLinkedDelivery) {
        window.dispatchEvent(new CustomEvent('showFridgeTempDialog'));
      }
    }


    const finishedStatuses = ['completed', 'failed', 'cancelled'];
    const isReturnByMarkers = (d) => { if (!d || !d.patient_id) return false; const patient = patients.find((p) => p && p.id === d.patient_id); const notes = d.delivery_notes || ''; const patientName = d.patient_name || ''; const patientFullName = patient?.full_name || ''; return notes.toLowerCase().includes('(rtn)') || patientName.toLowerCase().includes('(rtn)') || patientFullName.toLowerCase().includes('(rtn)') || /\breturn\b/i.test(notes) || /\breturn\b/i.test(patientName) || /\breturn\b/i.test(patientFullName); };

    const allDriverDeliveries = deliveriesWithStopOrder.filter((d) => d && d.driver_id === driverId && d.delivery_date === deliveryDate);
    const activeStatuses = ['in_transit', 'en_route'];
    // Route is complete when this stop transitions to a terminal status AND no other stop
    // on this route is still in_transit or en_route.
    // CRITICAL: Exclude the delivery being updated from the active-stop check — it still
    // carries its OLD status in deliveriesWithStopOrder (pre-update snapshot). We treat it
    // as already finished (newStatus) for this calculation.
    const hasActiveStops = allDriverDeliveries.some((d) => {
      if (d.id === deliveryId) return activeStatuses.includes(newStatus); // use the new status for the updating stop
      return activeStatuses.includes(d.status);
    });
    const routeComplete = finishedStatuses.includes(newStatus) && !hasActiveStops;

    const wasLastStop = !hasActiveStops;
    let wasLastDispatcherStop = false;
    if (isDispatcher && !isAdmin && wasLastStop) {
      const dispatcherStoreIds = new Set((currentUser?.store_ids || []).map((id) => String(id)));
      const allDateDeliveries = deliveriesWithStopOrder.filter((d) => d && d.delivery_date === deliveryDate);
      const remainingDispatcherActive = allDateDeliveries.filter((d) => {
        if (!d || d.id === deliveryId) return false;
        return dispatcherStoreIds.has(String(d.store_id)) && activeStatuses.includes(d.status);
      });
      wasLastDispatcherStop = remainingDispatcherActive.length === 0;
    }

    const currentPhaseNow = mapViewPhaseRef.current || currentPhase;

    // For dispatcher's last stop (not a full route complete), also reset to phase 1
    if (wasLastDispatcherStop && !routeComplete) {
      if (mapLockTimeoutRef.current) { clearTimeout(mapLockTimeoutRef.current); mapLockTimeoutRef.current = null; }
      mapLockExpiresAtRef.current = null;
      mapViewPhaseRef.current = 1; isMapViewLockedRef.current = false;
      setMapViewPhase(1); setIsMapViewLocked(false);
      if (currentPhaseNow > 1) {
        lastProgrammaticMapMoveRef.current = Date.now(); window._lastProgrammaticMapMove = Date.now();
        setMapViewTrigger((prev) => prev + 1);
      }
      if (currentUser?.id) saveSetting(currentUser.id, 'fab_map_cycle_phase', 1);
    }

    if (routeComplete) {
      // Set selected driver off duty and disable location sharing
      const driverAppUserForOffDuty = (appUsers || []).find((au) => au?.user_id === driverId);
      if (driverAppUserForOffDuty?.id) {
        base44.entities.AppUser.update(driverAppUserForOffDuty.id, {
          driver_status: 'off_duty',
          location_tracking_enabled: false,
          current_latitude: null,
          current_longitude: null,
          location_updated_at: null,
        }).then(() => {
          window.dispatchEvent(new CustomEvent('driverLocationsUpdated', { detail: { appUsers: [{ ...driverAppUserForOffDuty, driver_status: 'off_duty', location_tracking_enabled: false }], singleUpdate: true } }));
        }).catch((e) => console.warn('⚠️ Failed to auto set driver off_duty:', e.message));
      }

      // Reset map to phase 1
      if (mapLockTimeoutRef.current) { clearTimeout(mapLockTimeoutRef.current); mapLockTimeoutRef.current = null; }
      mapLockExpiresAtRef.current = null;
      mapViewPhaseRef.current = 1; isMapViewLockedRef.current = false;
      setMapViewPhase(1); setIsMapViewLocked(false);
      if (currentPhaseNow > 1) {
        lastProgrammaticMapMoveRef.current = Date.now(); window._lastProgrammaticMapMove = Date.now();
        setMapViewTrigger((prev) => prev + 1);
      }
      if (currentUser?.id) saveSetting(currentUser.id, 'fab_map_cycle_phase', 1);

      // Fire final polyline regeneration for the completed route (fire-and-forget)
      base44.functions.invoke('purgeAndRegeneratePolylines', {
        driverId,
        deliveryDate,
        reason: 'route_completed',
      }).catch((e) => console.warn('⚠️ Final polyline regen failed (non-critical):', e?.message));

      // Show end-of-day dialog — dedup by key so it only shows once per driver/date
      const summaryKey = `${driverId}_${deliveryDate}`;
      if (!hasShownSummaryRef.current.has(summaryKey)) {
        hasShownSummaryRef.current.add(summaryKey);
        const driverForDialog = driverAppUserForOffDuty || currentUser;
        setEndOfDayDriver(driverForDialog);
        setShowEndOfDayStats(true);
      }
      setSelectedCardId(null);
      setTimeout(() => { if (horizontalStopCardsRef.current) { const newHeight = horizontalStopCardsRef.current.offsetHeight; if (newHeight > 0 && newHeight !== stopCardsBaseHeight) { setStopCardsBaseHeight(newHeight); } } }, 1000);
    }

    if (['completed', 'failed', 'cancelled'].includes(newStatus)) {
      setTimeout(() => { const nextCard = deliveriesWithStopOrder.find((d) => d && d.isNextDelivery === true); if (nextCard) { const cardElement = document.getElementById(`stop-card-${nextCard.id}`); if (cardElement) cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }); } }, 500);
    }

    // CRITICAL: Only re-sync FAB refs when CURRENTLY in phase 2 or 3 (read live ref, not
    // stale closure value of currentPhase). If the user is in phase 1, do NOT lock the
    // FAB or set pendingPhase — that would cause useDriverLocationSync to reposition the
    // map to phase 2 on the very next GPS tick.
    const livePhaseNow = mapViewPhaseRef.current;
    if (livePhaseNow > 1) {
      syncFabRefsForPhase(livePhaseNow, { isMapViewLockedRef, mapViewPhaseRef, pendingPhaseRef, mapLockTimeoutRef, mapLockExpiresAtRef, setIsMapViewLocked, setMapViewPhase });
      // Visually reactivate the FAB AND reposition the map to the new next stop
      fabControlEvents.reactivateFAB(true, { forceWhileUserInteracting: true });
      // Re-trigger map positioning so it pans to the new next stop in phase 2/3
      lastProgrammaticMapMoveRef.current = Date.now();
      window._lastProgrammaticMapMove = Date.now();
      setMapViewTrigger((prev) => prev + 1);
    }

    window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { driverId, deliveryDate, triggeredBy: 'statusUpdate' } }));

    if (['completed', 'failed'].includes(newStatus) && targetDelivery.patient_id) {
      base44.entities.Patient.update(targetDelivery.patient_id, { last_delivery_date: deliveryDate }).catch((error) => console.warn('⚠️ Patient update failed:', error));
    }

    if (['completed', 'failed'].includes(newStatus)) {
      const deliveryStore = stores.find((s) => s?.id === targetDelivery?.store_id);
      const patientForMsg = patients.find((p) => p?.id === targetDelivery?.patient_id);
      const patientName = patientForMsg?.full_name || targetDelivery?.patient_name || 'Unknown';
      if (newStatus === 'completed') { notifyDriverCompleted({ driver: currentUser, patientName, delivery: targetDelivery, store: deliveryStore, appUsers }).catch((error) => console.warn('⚠️ Notification failed:', error)); }
      else if (newStatus === 'failed') { notifyDriverFailed({ driver: currentUser, patientName, delivery: targetDelivery, store: deliveryStore, appUsers, failureReason: extraData?.delivery_notes || null }).catch((error) => console.warn('⚠️ Notification failed:', error)); }
    }

    // Route optimization intentionally removed from status update path.
    // Completing/failing/cancelling a stop does not change the route order —
    // only the status and completion time of the current stop change.
    // Re-optimization is handled by the FAB or explicit user action only.

  } catch (error) {
    console.error('❌ [STATUS] FINAL ERROR CATCH', error);
    if (error.response?.status === 401 || error.message?.includes('Unauthorized') || error.message?.includes('session')) {
      alert('Your session has expired. The page will now reload.');
      window.location.reload();
      return;
    }
    alert(`Failed to update status: ${error.message || 'Unknown error - check console'}`);
    throw error;
  } finally {
    statusUpdateLockRef.current.delete(statusLockKey);
    resumeOfflineSync();
    smartRefreshManager.resume();
    backgroundSyncManager.resume();
    ctx.setIsEntityUpdating(false);
    document.documentElement.style.setProperty('--theme-transition-duration', '0.3s');
  }
}