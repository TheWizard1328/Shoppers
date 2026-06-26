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

import { base44 } from '@/api/base44Client';
import { offlineDB } from '@/components/utils/offlineDatabase';
import { invalidate } from '@/components/utils/dataManager';
import { smartRefreshManager } from '@/components/utils/smartRefreshManager';
import { pauseOfflineMutations, resumeOfflineMutations } from '@/components/utils/offlineMutations';
import { pauseOfflineSync, resumeOfflineSync } from '@/components/utils/offlineSync';
import { backgroundSyncManager } from '@/components/utils/backgroundSyncManager';
import { notifyDriverStarted } from '@/components/utils/deliveryMessaging';
import { determinePolylineSegment, fetchPolylineForSegment } from '@/components/utils/dynamicPolylineManager';

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
  const isPickup = !deliveryFromUI.patient_id;
  const newStatus = isPickup ? 'en_route' : 'in_transit';
  const now = new Date();
  const etaMinutes = now.getHours() * 60 + now.getMinutes() + 5;
  const etaString = `${String(Math.floor(etaMinutes / 60) % 24).padStart(2, '0')}:${String(etaMinutes % 60).padStart(2, '0')}`;

  // Track which delivery IDs were mutated locally so we can batch-sync them
  const transitionedIds = new Set();

  try {
    // ─── STEP 2: Compute all transitions locally, write ONLY to offlineDB ────
    // Read the current driver route from IndexedDB (source of truth while syncs are paused)
    const allLocalDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
    const driverLocalDeliveries = allLocalDeliveries.filter(
      (d) => d && d.driver_id === driverId && d.delivery_date === deliveryDate
    );

    const finishedStatuses = new Set(['completed', 'failed', 'cancelled', 'returned']);
    const completedCount = driverLocalDeliveries.filter((d) => finishedStatuses.has(d.status)).length;
    const nextStopOrder = completedCount + 1;

    // Build the full mutated set we'll write to IndexedDB in one go
    const mutatedDeliveries = driverLocalDeliveries.map((d) => {
      if (!d) return d;

      // Clear stale isNextDelivery from every other stop
      if (d.id !== deliveryId && d.isNextDelivery) {
        transitionedIds.add(d.id);
        return { ...d, isNextDelivery: false, updated_date: new Date().toISOString() };
      }

      // Transition the target stop
      if (d.id === deliveryId) {
        transitionedIds.add(d.id);
        return {
          ...d,
          isNextDelivery: true,
          status: newStatus,
          stop_order: nextStopOrder,
          delivery_time_start: etaString,
          delivery_time_eta: etaString,
          updated_date: new Date().toISOString(),
        };
      }

      return d;
    });

    // Write ALL mutations to offlineDB atomically
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, mutatedDeliveries);
    console.log(`✅ [handleStartDelivery] Step 2 complete — ${transitionedIds.size} stops written to offlineDB`);

    // ─── STEP 3: Immediate UI update from local state ─────────────────────
    if (updateDeliveriesLocally) {
      const otherDeliveries = (deliveries || []).filter(
        (d) => d && d.delivery_date !== deliveryDate
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

    // ─── STEP 4: Batch sync transitioned stops to online DB ──────────────
    // Build minimal payloads for only the records that changed
    const syncPromises = [];
    for (const d of mutatedDeliveries) {
      if (!d || !transitionedIds.has(d.id)) continue;
      const isTarget = d.id === deliveryId;
      const payload = isTarget
        ? {
            isNextDelivery: true,
            status: newStatus,
            stop_order: nextStopOrder,
            delivery_time_start: etaString,
            delivery_time_eta: etaString,
          }
        : { isNextDelivery: false };
      syncPromises.push(
        base44.entities.Delivery.update(d.id, payload).catch((err) => {
          console.warn(`⚠️ [handleStartDelivery] Sync failed for ${d.id}:`, err?.message);
        })
      );
    }
    await Promise.all(syncPromises);
    console.log(`✅ [handleStartDelivery] Step 4 complete — ${syncPromises.length} stops synced to online DB`);

    // Brief pause to let DB writes propagate before the optimizer reads the delivery list.
    // Without this the optimizer may race the status writes and see the pickup as still 'pending'.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // ─── STEP 5: Invoke route optimizer ──────────────────────────────────
    // Online DB is now consistent — optimizer will see the correct in_transit status
    let optimizeData = null;
    let optimizedRouteFromBackend = null;

    try {
      const localTimeString = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

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

      const optimizeResponse = await base44.functions.invoke('optimizeRemainingStops', {
        driverId,
        deliveryDate,
        currentLocalTime: localTimeString,
        deviceTime: now.toISOString(),
        currentLocation: driverCurrentLat && driverCurrentLon
          ? { lat: driverCurrentLat, lon: driverCurrentLon }
          : undefined,
        bypassDeduplication: true,
        bypassHistoricalCheck: true,
        bypassDriverStatus: true,
      });
      optimizeData = optimizeResponse?.data || optimizeResponse || null;
      optimizedRouteFromBackend = optimizeData?.optimizedRoute || null;
      console.log('✅ [handleStartDelivery] Step 5 complete — optimizer success:', optimizeData?.success);
    } catch (optimizeError) {
      console.warn('⚠️ [handleStartDelivery] Step 5 — optimizer failed:', optimizeError?.message);
    }

    // ─── STEP 6: Invoke polyline generator ───────────────────────────────
    if (optimizeData?.success) {
      const orderedDeliveryIds =
        Array.isArray(optimizeData?.orderedDeliveryIds) && optimizeData.orderedDeliveryIds.length > 0
          ? optimizeData.orderedDeliveryIds
          : null;
      const trueOriginCoords = optimizeData?.trueOriginCoords || null;

      try {
        await base44.functions.invoke('purgeAndRegeneratePolylines', {
          driverId,
          deliveryDate,
          ...(orderedDeliveryIds ? { orderedDeliveryIds } : { scope: 'active_only' }),
          ...(trueOriginCoords ? { currentPosition: trueOriginCoords } : {}),
          reason: 'post_start_delivery',
          sourcePage: 'Dashboard',
          bypassDriverStatus: true,
          recalculateEtas: false,
        });
        console.log('✅ [handleStartDelivery] Step 6 complete — polylines regenerated');
      } catch (e) {
        console.warn('⚠️ [handleStartDelivery] Step 6 — polyline regeneration failed:', e?.message);
      }
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
      await notifyDriverStarted({
        driver: currentUser,
        patientName: deliveryFromUI?.patient_name || 'Unknown',
        delivery: deliveryFromUI,
        store: deliveryStore,
        appUsers,
      });
    } catch (notifyError) {
      console.warn('⚠️ [handleStartDelivery] Step 7b — notification failed:', notifyError);
    }

    // ─── STEP 8: Final UI update from fresh server data ───────────────────
    invalidate('Delivery');
    const freshDeliveries = await base44.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate,
    });

    // Merge in optimized route data (ETAs, stop_order) from the backend response
    if (optimizedRouteFromBackend && Array.isArray(optimizedRouteFromBackend)) {
      const optimizedMap = new Map(
        optimizedRouteFromBackend
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
      const otherDeliveries = (deliveries || []).filter(
        (d) => d && d.delivery_date !== deliveryDate
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
  }
}