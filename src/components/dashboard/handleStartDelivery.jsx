/**
 * handleStartDelivery - Extracted from Dashboard.jsx for maintainability.
 * Handles the full start-delivery flow:
 * 1. Updates isNextDelivery flags
 * 2. Transitions stop to in_transit/en_route
 * 3. Re-orders stop_order so this stop is next
 * 4. Calls optimizeRemainingStops with driver's current location for accurate ETAs
 * 5. Merges optimized ETAs/stop_order/polylines into refreshed deliveries
 * 6. Persists to offline DB and updates UI state
 */

import { base44 } from '@/api/base44Client';
import { offlineDB } from '@/components/utils/offlineDatabase';
import { invalidate } from '@/components/utils/dataManager';
import { smartRefreshManager } from '@/components/utils/smartRefreshManager';
import { pauseOfflineMutations, resumeOfflineMutations } from '@/components/utils/offlineMutations';
import { pauseOfflineSync, resumeOfflineSync } from '@/components/utils/offlineSync';
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
  setIsEntityUpdating(true);
  pauseOfflineMutations();
  pauseOfflineSync();
  smartRefreshManager.pause();

  await new Promise((resolve) => setTimeout(resolve, 100));

  let newNextDeliveryId = deliveryId;

  try {
    const deliveryFromUI = deliveriesWithStopOrder.find((d) => d?.id === deliveryId);
    if (!deliveryFromUI) throw new Error('Delivery not found in local state');

    const driverId = deliveryFromUI.driver_id;
    const deliveryDate = deliveryFromUI.delivery_date;
    const isPickup = !deliveryFromUI.patient_id;
    const newStatus = isPickup ? 'en_route' : 'in_transit';
    const now = new Date();
    const etaMinutes = now.getHours() * 60 + now.getMinutes() + 5;
    const etaString = `${String(Math.floor(etaMinutes / 60) % 24).padStart(2, '0')}:${String(etaMinutes % 60).padStart(2, '0')}`;

    // STEP 1: Clear ALL isNextDelivery flags for this driver/date
    const allDriverDeliveries = await base44.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    });

    const resetPromises = allDriverDeliveries
      .filter((d) => d.isNextDelivery)
      .map((d) => base44.entities.Delivery.update(d.id, { isNextDelivery: false }));

    if (resetPromises.length > 0) await Promise.all(resetPromises);

    // STEP 2: Set isNextDelivery=true and update status + stop_order
    const finishedStatusesStep2 = ['completed', 'failed', 'cancelled', 'returned'];
    const completedStopsStep2 = allDriverDeliveries.filter((d) => finishedStatusesStep2.includes(d.status));
    const nextStopOrderStep2 = completedStopsStep2.length + 1;

    const startUpdatePayload = {
      isNextDelivery: true,
      status: newStatus,
      stop_order: nextStopOrderStep2,
      delivery_time_start: etaString,
      delivery_time_eta: etaString
    };

    await base44.entities.Delivery.update(deliveryId, startUpdatePayload);
    window.dispatchEvent(new CustomEvent('deliveryUpdated', {
      detail: { deliveryId, updates: startUpdatePayload, driverId, deliveryDate, source: 'startDelivery' }
    }));

    // STEP 3: Verify the update persisted
    const refreshedDeliveriesAfterFlag = await base44.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    });
    const verifyNext = refreshedDeliveriesAfterFlag.find((d) => d.id === deliveryId);
    if (!verifyNext?.isNextDelivery || verifyNext?.status !== newStatus) {
      await base44.entities.Delivery.update(deliveryId, startUpdatePayload);
    }

    // STEP 4: Get driver's current GPS location for optimization
    let driverCurrentLat = null;
    let driverCurrentLon = null;
    try {
      const driverAppUser = appUsers.find((u) => u?.user_id === driverId);
      if (driverAppUser?.current_latitude && driverAppUser?.current_longitude) {
        driverCurrentLat = driverAppUser.current_latitude;
        driverCurrentLon = driverAppUser.current_longitude;
      } else if (driverLocation?.latitude && driverLocation?.longitude && driverId === currentUser?.id) {
        driverCurrentLat = driverLocation.latitude;
        driverCurrentLon = driverLocation.longitude;
      }
    } catch (_) {}

    // STEP 5: Optimize remaining stops with driver location for accurate ETAs
    let optimizedRouteFromBackend = null;
    try {
      const localTimeString = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const optimizeResponse = await base44.functions.invoke('optimizeRemainingStops', {
        driverId,
        deliveryDate,
        currentLocalTime: localTimeString,
        deviceTime: now.toISOString(),
        currentLocation: driverCurrentLat && driverCurrentLon ? {
          lat: driverCurrentLat,
          lon: driverCurrentLon
        } : undefined,
        bypassDeduplication: true,
        bypassHistoricalCheck: true,
        bypassDriverStatus: true
      });
      optimizedRouteFromBackend = optimizeResponse?.data?.optimizedRoute || optimizeResponse?.optimizedRoute || null;
    } catch (optimizeError) {
      console.warn('⚠️ [handleStartDelivery] Route optimization failed:', optimizeError.message);
    }

    // STEP 6: Fetch fresh deliveries from backend
    invalidate('Delivery');
    const refreshedDeliveries = await base44.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    });

    // STEP 7: Merge optimized route data (ETAs, stop_order, polylines) into refreshed deliveries
    if (optimizedRouteFromBackend && Array.isArray(optimizedRouteFromBackend)) {
      const optimizedMap = new Map(
        optimizedRouteFromBackend
          .filter((stop) => stop?.deliveryId || stop?.delivery_id)
          .map((stop) => [stop.deliveryId || stop.delivery_id, stop])
      );
      for (const delivery of refreshedDeliveries) {
        if (!delivery?.id) continue;
        const optimized = optimizedMap.get(delivery.id);
        if (!optimized) continue;
        if (Number.isFinite(Number(optimized.stop_order))) delivery.stop_order = Number(optimized.stop_order);
        if (optimized.newETA || optimized.eta) delivery.delivery_time_eta = optimized.newETA || optimized.eta;
        if (typeof optimized.travel_dist === 'number') delivery.travel_dist = optimized.travel_dist;
        if (typeof optimized.encoded_polyline === 'string') delivery.encoded_polyline = optimized.encoded_polyline;
        if (typeof optimized.estimated_distance_km === 'number') delivery.estimated_distance_km = optimized.estimated_distance_km;
        if (typeof optimized.estimated_duration_minutes === 'number') delivery.estimated_duration_minutes = optimized.estimated_duration_minutes;
      }
    }

    // STEP 8: Persist to offline DB immediately (ETAs + stop_order + polylines all updated)
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, refreshedDeliveries);

    const newNextDelivery = refreshedDeliveries.find((d) => d.isNextDelivery === true);
    newNextDeliveryId = newNextDelivery?.id || deliveryId;

    // STEP 9: Update UI state immediately
    if (updateDeliveriesLocally) {
      const otherDeliveries = deliveries.filter((d) => d && d.delivery_date !== deliveryDate);
      updateDeliveriesLocally([...otherDeliveries, ...refreshedDeliveries], true);
    }

    // Dispatch events to update map and stats
    window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
      detail: { driverId, deliveryDate, triggeredBy: 'startDelivery', freshDeliveries: refreshedDeliveries, fullReplacement: false }
    }));

    // STEP 10: Update blue polyline (driver → next stop)
    try {
      const driver = users.find((u) => u && u.id === driverId);
      if (driver && driver.driver_status === 'on_duty' && driver.location_tracking_enabled === true) {
        const segment = determinePolylineSegment(refreshedDeliveries, driver, patients, stores);
        if (segment) {
          const polyline = await fetchPolylineForSegment(
            segment.originLat, segment.originLon, segment.destLat, segment.destLon
          );
          setCurrentToNextPolyline(Array.isArray(polyline) && polyline.length > 1 ? polyline : null);
        }
      }
    } catch (polylineError) {
      console.warn('⚠️ [handleStartDelivery] Blue polyline update failed:', polylineError.message);
    }

    // STEP 11: Scroll to next delivery card
    setTimeout(() => {
      const nextCard = refreshedDeliveries.find((d) => d && d.isNextDelivery === true);
      if (nextCard) {
        const cardElement = document.getElementById(`stop-card-${nextCard.id}`);
        if (cardElement) cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }
    }, 800);

    // STEP 12: Send notification
    try {
      const deliveryStore = stores.find((s) => s?.id === deliveryFromUI?.store_id);
      await notifyDriverStarted({
        driver: currentUser,
        patientName: deliveryFromUI?.patient_name || 'Unknown',
        delivery: deliveryFromUI,
        store: deliveryStore,
        appUsers
      });
    } catch (notifyError) {
      console.warn('⚠️ [handleStartDelivery] Notification failed:', notifyError);
    }

  } catch (error) {
    console.error('❌ [handleStartDelivery] Error:', error);
    if (error.response?.status === 401 || error.message?.includes('Unauthorized') || error.message?.includes('session')) {
      alert('Your session has expired. The page will now reload.');
      window.location.reload();
      return;
    }
    alert(`Failed to start delivery: ${error.message}`);
  } finally {
    // Final refresh to offline DB
    try {
      const delivery = deliveriesWithStopOrder.find((d) => d?.id === deliveryId);
      if (delivery?.driver_id && delivery?.delivery_date) {
        const finalRefreshed = await base44.entities.Delivery.filter({
          driver_id: delivery.driver_id,
          delivery_date: delivery.delivery_date
        });
        await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, finalRefreshed);
        finalRefreshed.forEach((d) => {
          if (d?.id) smartRefreshManager.registerPendingUpdate(d.id, d.driver_id, d.delivery_date);
        });
        if (updateDeliveriesLocally) updateDeliveriesLocally(finalRefreshed, false);
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: { driverId: finalRefreshed[0]?.driver_id, deliveryDate: finalRefreshed[0]?.delivery_date, triggeredBy: 'startDeliveryFinalRefresh', freshDeliveries: finalRefreshed, fullReplacement: false }
        }));
      }
    } catch (refreshError) {
      console.error('❌ [handleStartDelivery] Final refresh failed:', refreshError);
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
    resumeOfflineMutations();
    resumeOfflineSync();
    smartRefreshManager.resume();
    setIsEntityUpdating(false);
  }
}