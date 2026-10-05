/**
 * handleStartDelivery - Offline-first Accept/Assign All flow:
 *
 * 1. Pause all sync processes
 * 2. Compute all transitions locally, save to offlineDB only
 * 3. Immediate UI update from local state
 * 4. Batch sync transitioned stops to online DB
 * 5. Invoke route optimizer (server now sees consistent state)
 * 6. Invoke polyline generator
 * 7. Remaining processes (blue polyline, notifications, scroll)
 * 8. Final UI update from fresh server data
 */

import { toast } from 'sonner';
import { base44 } from '@/api/base44Client';
import { offlineDB } from '@/components/utils/offlineDatabase';
import { invalidate } from '@/components/utils/dataManager';
import { smartRefreshManager } from '@/components/utils/smartRefreshManager';
import { pauseOfflineMutations, resumeOfflineMutations } from '@/components/utils/offlineMutations';
import { pauseOfflineSync, resumeOfflineSync } from '@/components/utils/offlineSync';
import { backgroundSyncManager } from '@/components/utils/backgroundSyncManager';
import { notifyDriverStarted } from '@/components/utils/deliveryMessaging';
import { determinePolylineSegment, fetchPolylineForSegment } from '@/components/utils/dynamicPolylineManager';
import { performRouteOptimization } from '@/components/utils/routeOptimizationCoordinator';

export async function handleStartDelivery({
  deliveryId,
  deliveriesWithStopOrder,
  deliveries,
  users,
  patients,
  stores,
  appUsers,
  currentUser,
  driverLocation,
  updateDeliveriesLocally,
  setIsEntityUpdating,
  setCurrentToNextPolyline,
}) {
  // ─── STEP 1: Pause ALL sync processes ────────────────────────────────────
  pauseOfflineMutations();
  pauseOfflineSync();
  smartRefreshManager.pause();
  backgroundSyncManager.pause();

  const deliveryFromUI = deliveriesWithStopOrder.find((d) => d?.id === deliveryId);
  if (!deliveryFromUI) {
    resumeOfflineMutations();
    resumeOfflineSync();
    smartRefreshManager.resume();
    backgroundSyncManager.resume();
    console.error('❌ [handleStartDelivery] Delivery not found in local state:', deliveryId);
    alert('Failed to start delivery: stop not found in local state.');
    return;
  }

  const driverId = deliveryFromUI.driver_id;
  const deliveryDate = deliveryFromUI.delivery_date;
  const isCyclingMarker = !!deliveryFromUI.is_cycling_marker;
  // Cycling markers are NOT pickups (no patient_id but also not a store pickup).
  // InterStore stops (ISP/ISD) also have no patient_id but are NOT regular store pickups —
  // they use in_transit → completed transitions only.
  // Regular pickups use en_route; patient stops, cycling markers, and interstore stops use in_transit.
  const isInterStoreStop = !!(deliveryFromUI._interstore_source_id || deliveryFromUI._interstore_dest_id);
  const isPickup = !deliveryFromUI.patient_id && !isCyclingMarker && !isInterStoreStop;
  const newStatus = isPickup ? 'en_route' : 'in_transit';
  const now = new Date();
  const etaMinutes = now.getHours() * 60 + now.getMinutes() + 5;
  const etaString = `${String(Math.floor(etaMinutes / 60) % 24).padStart(2, '0')}:${String(etaMinutes % 60).padStart(2, '0')}`;

  // Track which delivery IDs were mutated locally so we can batch-sync them
  const transitionedIds = new Set();
  // Hoisted so the finally block can inspect the coordinator result (serverCommitFailed)
  let coordResult = null;

  try {
    // ─── STEP 2: Compute all transitions locally, write ONLY to offlineDB ────
    // Read the current driver route from IndexedDB (source of truth while syncs are paused)
    const allLocalDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
    const driverLocalDeliveries = allLocalDeliveries.filter(
      (d) => d && d.driver_id === driverId && d.delivery_date === deliveryDate
    );

    const finishedStatuses = new Set(['completed', 'failed', 'cancelled']);

    // ── STEP 2b: Renumber — the started stop takes the current next position ──
    // (owner directive, Sep 28 2026 — reverses the Sep 21 frozen-number policy).
    // The frozen-number policy kept the started stop's OLD stop_order, so the
    // isNextDelivery flag moved it to "next" on the map/banner while the card
    // list kept sorting it by its stale number — the stop sat in its old slot
    // with a mismatched number. Now Start renumbers the route in one pass:
    //   - finished stops: 1..K, ordered by actual_delivery_time ASC
    //     (same rule as repair passes — values only change if stale)
    //   - the started stop: K+1 (the current next position)
    //   - remaining incomplete stops (cycling markers INCLUDED): K+2..N,
    //     preserving their existing relative order (stop_order, ETA tie-break,
    //     pending last)
    const finishedStopsLocal = driverLocalDeliveries
      .filter((d) => d && finishedStatuses.has(String(d.status || '')));
    const finishedSorted = [...finishedStopsLocal].sort((a, b) => {
      const ta = a.actual_delivery_time ? new Date(a.actual_delivery_time).getTime() : Number.MAX_SAFE_INTEGER;
      const tb = b.actual_delivery_time ? new Date(b.actual_delivery_time).getTime() : Number.MAX_SAFE_INTEGER;
      if (ta !== tb) return ta - tb;
      return (Number(a.stop_order) || 0) - (Number(b.stop_order) || 0);
    });
    const remainingIncomplete = driverLocalDeliveries
      .filter((d) => d && !finishedStatuses.has(String(d.status || '')) && d.id !== deliveryId)
      .sort((a, b) => {
        const aPending = a.status === 'pending' && !a.is_cycling_marker;
        const bPending = b.status === 'pending' && !b.is_cycling_marker;
        if (aPending !== bPending) return aPending ? 1 : -1;
        const ao = Number(a.stop_order) || 0;
        const bo = Number(b.stop_order) || 0;
        if (ao > 0 && bo > 0 && ao !== bo) return ao - bo;
        const ea = a.delivery_time_eta || a.delivery_time_start || '';
        const eb = b.delivery_time_eta || b.delivery_time_start || '';
        if (ea !== eb) return String(ea).localeCompare(String(eb));
        return String(a.created_date || '').localeCompare(String(b.created_date || ''));
      });
    const newOrderMap = new Map();
    finishedSorted.forEach((d, i) => newOrderMap.set(d.id, i + 1));
    const newTargetStopOrder = finishedSorted.length + 1;
    newOrderMap.set(deliveryId, newTargetStopOrder);
    remainingIncomplete.forEach((d, i) => newOrderMap.set(d.id, finishedSorted.length + 2 + i));
    const renumberedIds = new Set();

    // Build the full mutated set we'll write to IndexedDB in one go
    const mutatedDeliveries = driverLocalDeliveries.map((d) => {
      if (!d) return d;

      const nextOrder = newOrderMap.get(d.id);
      const orderChanged = nextOrder != null && Number(d.stop_order) !== nextOrder;
      if (orderChanged) { transitionedIds.add(d.id); renumberedIds.add(d.id); }

      // Transition the target stop (renumbered to K+1 — see STEP 2b above)
      if (d.id === deliveryId) {
        transitionedIds.add(d.id);
        return {
          ...d,
          isNextDelivery: true,
          status: newStatus,
          stop_order: nextOrder,
          delivery_time_start: etaString,
          delivery_time_eta: etaString,
          updated_date: new Date().toISOString(),
        };
      }

      // Clear stale isNextDelivery from every other stop + apply renumbers
      if (d.isNextDelivery) transitionedIds.add(d.id);
      if (!d.isNextDelivery && !orderChanged) return d;
      return {
        ...d,
        ...(d.isNextDelivery ? { isNextDelivery: false } : {}),
        ...(orderChanged ? { stop_order: nextOrder } : {}),
        updated_date: new Date().toISOString(),
      };
    });

    // Write ALL mutations to offlineDB atomically
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, mutatedDeliveries);
    console.log(`✅ [handleStartDelivery] Step 2 complete — ${transitionedIds.size} stops written to offlineDB`);

    // ─── STEP 3: Immediate UI update from local state ─────────────────────
    if (updateDeliveriesLocally) {
      // CRITICAL: Keep all other drivers' deliveries for the same date — only replace
      // deliveries that belong to THIS driver on THIS date.
      const otherDeliveries = (deliveries || []).filter(
        (d) => d && !(d.driver_id === driverId && d.delivery_date === deliveryDate)
      );
      updateDeliveriesLocally([...otherDeliveries, ...mutatedDeliveries], true);
    }
    window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
      detail: {
        driverId,
        deliveryDate,
        triggeredBy: 'startDelivery_localFlush',
        freshDeliveries: mutatedDeliveries,
        fullReplacement: false,
      },
    }));
    console.log('✅ [handleStartDelivery] Step 3 complete — UI updated from local state');

    // ─── STEP 4: Silent server sync — ONE write, NO WebSocket broadcasts ────
    // (owner request, Oct 5 2026: "Start button should push ONE final WebSocket
    // broadcast like the Accept All button flow".)
    //
    // Previously this step did TWO broadcasting writes — a direct user-scoped
    // base44.entities.Delivery.update (Step 4a) plus a per-record broadcasting
    // bulkUpdateDeliveries for the renumbers (Step 4a.5). Every user-scoped
    // write fires a WS broadcast, so other devices watched the route re-render
    // in partial states (status first, renumbers second, optimizer's final
    // order third) before it settled.
    //
    // Now BOTH land in ONE bulkUpdateDeliveries invoke with silent:true —
    // service-role server writes do NOT broadcast. The route-optimization
    // coordinator's final bulkUpdateDeliveries commit (Steps 5+6, user-scoped)
    // becomes the SINGLE final broadcast carrying status, stop_order, ETAs,
    // polylines, and isNextDelivery together — same pattern as Accept All.
    // If optimization fails or its server commit fails, the fallback block
    // after Step 8 fires one non-silent broadcast so other devices still sync.
    const startSilentUpdates = [];
    for (const id of renumberedIds) {
      if (id === deliveryId) continue;
      const d = mutatedDeliveries.find((x) => x?.id === id);
      if (d && Number.isFinite(Number(d.stop_order))) {
        startSilentUpdates.push({ id, data: { stop_order: Number(d.stop_order) } });
      }
    }
    // Target last — status + renumber + ETA in the same silent batch.
    startSilentUpdates.push({
      id: deliveryId,
      data: {
        status: newStatus,
        stop_order: newTargetStopOrder,
        delivery_time_start: etaString,
        delivery_time_eta: etaString,
      },
    });
    try {
      await base44.functions.invoke('bulkUpdateDeliveries', { updates: startSilentUpdates, silent: true });
      console.log(`✅ [handleStartDelivery] Step 4 complete — ${startSilentUpdates.length} silent update(s) synced (no WS broadcast; final broadcast comes from the coordinator)`);
    } catch (err) {
      console.warn(`⚠️ [handleStartDelivery] Step 4 silent sync failed:`, err?.message);
    }

    // Authoritative server-side clear-all-then-promote (asServiceRole, primary read):
    // clears every stale isNextDelivery=true on this driver+date route EXCEPT the
    // target, awaits all false broadcasts, then promotes the target LAST so the single
    // true arrives after every false on every receiving device.
    try {
      const res = await base44.functions.invoke('clearAndSetNextDelivery', { driverId, deliveryDate, promoteId: deliveryId });
      const clearedCount = (res?.data?.clearedIds || res?.clearedIds || []).length;
      console.log(`✅ [handleStartDelivery] Step 4b complete — cleared ${clearedCount} stale isNextDelivery=true flag(s), promoted ${deliveryId} (broadcast last)`);
    } catch (err) {
      console.warn(`⚠️ [handleStartDelivery] clearAndSetNextDelivery failed:`, err?.message);
    }

    // Brief pause to let DB writes propagate before the optimizer reads the delivery list.
    // Without this the optimizer may race the status writes and see the pickup as still 'pending'.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // ─── STEP 5+6: Unified route optimization (optimize + polyline regeneration) ──
    // ─── STEP 5+6: Unified route optimization (optimize + polyline regeneration) ──
    // Cycling markers are full stops with GPS coords — they go through the optimizer
    // just like any other stop. The optimizer preserves isNextDelivery and respects
    // the positional constraint (start before cycling-mode stops, end after).
    let driverCurrentLat = null;
    let driverCurrentLon = null;
    const driverAppUser = appUsers.find((u) => u?.user_id === driverId);
    if (driverAppUser?.current_latitude && driverAppUser?.current_longitude) {
      driverCurrentLat = driverAppUser.current_latitude;
      driverCurrentLon = driverAppUser.current_longitude;
    } else if (driverLocation?.latitude && driverLocation?.longitude && driverId === currentUser?.id) {
      driverCurrentLat = driverLocation.latitude;
      driverCurrentLon = driverLocation.longitude;
    }

    // Pass the just-mutated local deliveries directly to the client-side engine.
    // mutatedDeliveries already contains the full driver+date set from offlineDB
    // with the latest status/isNextDelivery/stop_order writes applied.
    coordResult = await performRouteOptimization({
      driverId,
      deliveryDate,
      currentLocation: driverCurrentLat && driverCurrentLon ? { lat: driverCurrentLat, lon: driverCurrentLon } : null,
      deliveries: mutatedDeliveries,
      patients,
      stores,
      appUsers,
      source: 'start_delivery',
      bypassDriverStatus: true,
      awaitServerWrite: true,
    });
    console.log('✅ [handleStartDelivery] Steps 5+6 complete — coordinator success:', coordResult?.success);

    if (coordResult?.isDegraded) {
      console.warn('⚠️ [handleStartDelivery] Route optimization degraded — HERE routing unavailable, used straight-line approximation', {
        usedFallbackOrdering: coordResult?.usedFallbackOrdering,
        usedFallbackPolyline: coordResult?.usedFallbackPolyline,
      });
      toast.warning('Route order approximated — HERE routing was unavailable, so stop order/map lines may not be fully optimized.');
    }

    // ─── STEP 6.5: Apply the optimized result to the UI immediately (pass 2) ───
    // Accept-All-parity UI choreography (owner directive, Sep 28 2026): the
    // start flow re-sorts the stop cards MULTIPLE times before settling —
    // pass 1 was the local renumber flush in Step 3; THIS pass applies the
    // HERE-optimized order/ETAs the coordinator just produced; Step 8 then
    // settles with the final merged state + scroll. The visible multi-pass
    // rearrange gives the driver the same "optimization is working" feedback
    // the Accept All button provides.
    if (coordResult?.success && Array.isArray(coordResult.freshDeliveries) && coordResult.freshDeliveries.length > 0 && updateDeliveriesLocally) {
      const otherDeliveriesOpt = (deliveries || []).filter(
        (d) => d && !(d.driver_id === driverId && d.delivery_date === deliveryDate)
      );
      updateDeliveriesLocally([...otherDeliveriesOpt, ...coordResult.freshDeliveries], true);
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: {
          driverId,
          deliveryDate,
          triggeredBy: 'startDelivery_optimized',
          freshDeliveries: coordResult.freshDeliveries,
          fullReplacement: false,
        },
      }));
      console.log('✅ [handleStartDelivery] Step 6.5 complete — UI pass 2 applied (optimized order)');
    }

    // ─── STEP 7: Remaining processes ─────────────────────────────────────
    // 7a: Blue polyline (driver → next stop)
    try {
      const driver = users.find((u) => u && u.id === driverId);
      if (driver?.driver_status === 'on_duty' && driver?.location_tracking_enabled === true) {
        // Fetch the latest delivery set before computing the segment
        const latestLocal = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
        const driverLatestDeliveries = latestLocal.filter(
          (d) => d && d.driver_id === driverId && d.delivery_date === deliveryDate
        );
        const segment = determinePolylineSegment(driverLatestDeliveries, driver, patients, stores);
        if (segment) {
          const polyline = await fetchPolylineForSegment(
            segment.originLat, segment.originLon, segment.destLat, segment.destLon
          );
          setCurrentToNextPolyline(Array.isArray(polyline) && polyline.length > 1 ? polyline : null);
        }
      }
    } catch (polylineError) {
      console.warn('⚠️ [handleStartDelivery] Step 7a — blue polyline failed:', polylineError?.message);
    }

    // 7b: Notification
    try {
      const deliveryStore = stores.find((s) => s?.id === deliveryFromUI?.store_id);
      const patientForNotify = patients.find((p) => p?.id === deliveryFromUI?.patient_id);
      const patientNameForNotify = patientForNotify?.full_name || deliveryFromUI?.patient_name || 'Unknown';
      await notifyDriverStarted({
        driver: currentUser,
        patientName: patientNameForNotify,
        delivery: deliveryFromUI,
        store: deliveryStore,
        appUsers,
      });
    } catch (notifyError) {
      console.warn('⚠️ [handleStartDelivery] Step 7b — notification failed:', notifyError);
    }

    // ─── STEP 8: Final UI update from fresh server data ───────────────────
    // coordinator already fetched + saved fresh deliveries to offlineDB via Step 5+6.
    // Use the coordinator's fresh data to update the UI.
    const freshDeliveries = coordResult?.freshDeliveries?.length > 0
      ? coordResult.freshDeliveries
      : await base44.entities.Delivery.filter({
          driver_id: driverId,
          delivery_date: deliveryDate,
        }).catch(() => []);

    // Merge in optimized route data (ETAs, stop_order) from the coordinator response
    if (coordResult?.optimizeData?.optimizedRoute && Array.isArray(coordResult.optimizeData.optimizedRoute)) {
      const optimizedMap = new Map(
        coordResult.optimizeData.optimizedRoute
          .filter((stop) => stop?.deliveryId || stop?.delivery_id)
          .map((stop) => [stop.deliveryId || stop.delivery_id, stop])
      );
      for (const delivery of freshDeliveries) {
        if (!delivery?.id) continue;
        const opt = optimizedMap.get(delivery.id);
        if (!opt) continue;
        if (Number.isFinite(Number(opt.stop_order))) delivery.stop_order = Number(opt.stop_order);
        if (opt.newETA || opt.eta) delivery.delivery_time_eta = opt.newETA || opt.eta;
        if (typeof opt.travel_dist === 'number') delivery.travel_dist = opt.travel_dist;
        if (typeof opt.estimated_distance_km === 'number') delivery.estimated_distance_km = opt.estimated_distance_km;
        if (typeof opt.estimated_duration_minutes === 'number') delivery.estimated_duration_minutes = opt.estimated_duration_minutes;
      }
    }

    // Persist final server state (including polylines) back to offlineDB
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);

    if (updateDeliveriesLocally) {
      // CRITICAL: Same as Step 3 — preserve other drivers' same-date deliveries.
      const otherDeliveries = (deliveries || []).filter(
        (d) => d && !(d.driver_id === driverId && d.delivery_date === deliveryDate)
      );
      updateDeliveriesLocally([...otherDeliveries, ...freshDeliveries], true);
    }

    window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
      detail: {
        driverId,
        deliveryDate,
        triggeredBy: 'startDelivery_finalRefresh',
        freshDeliveries,
        fullReplacement: false,
      },
    }));

    // Scroll to next stop card
    setTimeout(() => {
      const nextCard = freshDeliveries.find((d) => d?.isNextDelivery === true);
      if (nextCard) {
        const cardElement = document.getElementById(`stop-card-${nextCard.id}`);
        if (cardElement) cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }
    }, 800);

    console.log('✅ [handleStartDelivery] Step 8 complete — final UI updated from server');

    // ─── STEP 8.5: Fallback single broadcast when the coordinator did NOT ───
    // commit (engine failed, degraded without commit, or server commit failed).
    // Every server write so far was SILENT (Step 4 silent:true + Step 4b
    // asServiceRole) — the coordinator's user-scoped commit was supposed to be
    // the one final WS broadcast. When it doesn't happen, fire ONE non-silent
    // bulkUpdateDeliveries carrying the complete start state so other devices
    // sync in a single broadcast instead of waiting for the next poll.
    if (!coordResult?.success || coordResult?.serverCommitFailed === true) {
      try {
        const fallbackUpdates = [];
        for (const id of transitionedIds) {
          if (id === deliveryId) continue;
          const d = mutatedDeliveries.find((x) => x?.id === id);
          if (!d) continue;
          fallbackUpdates.push({ id, data: { stop_order: Number(d.stop_order), isNextDelivery: false } });
        }
        fallbackUpdates.push({
          id: deliveryId,
          data: {
            status: newStatus,
            stop_order: newTargetStopOrder,
            delivery_time_start: etaString,
            delivery_time_eta: etaString,
            isNextDelivery: true,
          },
        });
        await base44.functions.invoke('bulkUpdateDeliveries', { updates: fallbackUpdates });
        console.log(`✅ [handleStartDelivery] Step 8.5 — fallback single broadcast sent (${fallbackUpdates.length} updates, coordinator did not commit)`);
      } catch (err) {
        console.warn(`⚠️ [handleStartDelivery] Step 8.5 fallback broadcast failed:`, err?.message);
      }
    }

  } catch (error) {
    console.error('❌ [handleStartDelivery] Error:', error);
    if (
      error.response?.status === 401 ||
      error.message?.includes('Unauthorized') ||
      error.message?.includes('session')
    ) {
      alert('Your session has expired. The page will now reload.');
      window.location.reload();
      return;
    }
    alert(`Failed to start delivery: ${error.message}`);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    resumeOfflineMutations();
    resumeOfflineSync();
    smartRefreshManager.resume();
    backgroundSyncManager.resume();

    // ─── STEP 9: Priority delivery refresh — fires 3 sec after start completes ──
    // The start process is fully done once the sync managers above have resumed.
    // Schedule a priority delivery refresh 3 sec later so other drivers' deliveries
    // (and any server-side changes triggered by this start) are reconciled without
    // racing the just-resumed sync managers.
    // GUARD: if the coordinator's server commit failed (offline / server error), the
    // server still holds PRE-optimization stop_order/polyline state — a forced
    // refresh now would clobber the good local UI/IDB state (stale until refresh).
    // Skip it; the offline mutation queue re-pushes the writes when back online.
    const _serverCommitFailed = coordResult?.serverCommitFailed === true;
    if (_serverCommitFailed) {
      console.warn('⚠️ [handleStartDelivery] Step 9 skipped — optimization server commit failed; priority refresh would revert local state');
    }
    setTimeout(() => {
      if (_serverCommitFailed) return;
      import('@/components/utils/dataManager')
        .then(({ loadPriorityDeliveriesForSelection }) =>
          loadPriorityDeliveriesForSelection(deliveryDate, 'all', true)
        )
        .then((freshDeliveries) => {
          if (!Array.isArray(freshDeliveries) || freshDeliveries.length === 0) return;
          if (updateDeliveriesLocally) {
            // Merge (not replace) so other drivers' same-date deliveries are preserved.
            updateDeliveriesLocally(freshDeliveries, false);
          }
          window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
            detail: {
              driverId,
              deliveryDate,
              triggeredBy: 'startDelivery_priorityRefresh',
              freshDeliveries,
              fullReplacement: false,
            },
          }));
          window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
          console.log('✅ [handleStartDelivery] Step 9 complete — priority delivery refresh');
        })
        .catch((err) => {
          console.warn('⚠️ [handleStartDelivery] Priority delivery refresh failed:', err?.message || err);
        });
    }, 3000);
  }
}