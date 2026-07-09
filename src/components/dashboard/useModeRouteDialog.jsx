import { useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { getCurrentDriverLocation, getNearbyModeStops } from '@/components/dashboard/modeButtonHelpers';
import { updatePreferredTravelMode } from '@/components/dashboard/travelModeHelpers';
import { useAppData } from '@/components/utils/AppDataContext';
import { base44 } from '@/api/base44Client';
import { format } from 'date-fns';

// ── Haversine crow-flies distance (km) ────────────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default function useModeRouteDialog({
  currentUser,
  appUsers,
  driverLocation,
  deliveriesWithStopOrder,
  patients,
  stores,
  setPreferredTravelMode,
  selectedDate,
}) {
  const { applyDeliveryChangesLocally } = useAppData();

  const [modeDialogOpen, setModeDialogOpen] = useState(false);
  const [selectedModeStopIds, setSelectedModeStopIds] = useState([]);
  const [returnToCurrentLocation, setReturnToCurrentLocation] = useState(false);
  const [isOptimizingModeRoute, setIsOptimizingModeRoute] = useState(false);

  const currentModeLocation = useMemo(() => getCurrentDriverLocation({
    currentUser,
    appUsers,
    driverLocation,
  }), [currentUser, appUsers, driverLocation]);

  const nearbyModeStops = useMemo(() => getNearbyModeStops({
    deliveries: deliveriesWithStopOrder,
    patients,
    stores,
    currentLocation: currentModeLocation,
    radiusKm: 50,
  }), [deliveriesWithStopOrder, patients, stores, currentModeLocation]);

  const toggleModeStop = useCallback((stopId) => {
    setSelectedModeStopIds((prev) =>
      prev.includes(stopId) ? prev.filter((id) => id !== stopId) : [...prev, stopId]
    );
  }, []);

  const toggleReturnToCurrentLocation = useCallback(() => {
    setReturnToCurrentLocation((prev) => !prev);
  }, []);

  const isRunningRef = useRef(false);

  const handleModeOptimize = useCallback(async () => {
    if (selectedModeStopIds.length === 0 || !currentUser?.id) return;
    if (isRunningRef.current) return;
    isRunningRef.current = true;
    setIsOptimizingModeRoute(true);

    try {
      const now = new Date();
      const deliveryDateStr = selectedDate
        ? (typeof selectedDate === 'string' ? selectedDate : format(selectedDate, 'yyyy-MM-dd'))
        : format(now, 'yyyy-MM-dd');
      const currentLocalTime = format(now, 'HH:mm');

      // ── 0. Resolve Start and End markers ─────────────────────────────────
      // These were already created and persisted by DeliveryFormView before
      // the dialog opened. We must resolve them from the current delivery list.
      const FINISHED = new Set(['completed', 'failed', 'cancelled', 'returned']);

      const startMarker = deliveriesWithStopOrder.find(
        (d) => d?.is_cycling_marker && (d.delivery_notes || '').toLowerCase().includes('start')
      ) || null;

      const endMarker = deliveriesWithStopOrder.find(
        (d) => d?.is_cycling_marker && (d.delivery_notes || '').toLowerCase().includes('end')
      ) || null;

      if (!startMarker || !endMarker) {
        toast.error('Cycling markers not found. Please add them first.');
        return;
      }

      // ── 1. Resolve marker GPS coords ──────────────────────────────────────
      const startCoords = {
        lat: Number(startMarker.cycling_latitude),
        lon: Number(startMarker.cycling_longitude),
      };
      const endCoords = {
        lat: Number(endMarker.cycling_latitude),
        lon: Number(endMarker.cycling_longitude),
      };

      if (!startCoords.lat || !startCoords.lon || !endCoords.lat || !endCoords.lon) {
        toast.error('Cycling marker coordinates are missing.');
        return;
      }

      // ── 2. Resolve selected cycling stop deliveries ───────────────────────
      const selectedDeliveries = deliveriesWithStopOrder.filter(
        (d) => d && selectedModeStopIds.includes(d.id) && !d.is_cycling_marker
      );

      if (selectedDeliveries.length === 0) {
        toast.error('No valid stops selected.');
        return;
      }

      // ── 3. Crow-flies sort selected stops from the Start marker ───────────
      // This gives HERE a good warm-start sequence so the bicycle optimizer
      // doesn't need to untangle a pathologically bad initial order.
      const crowSorted = [...selectedDeliveries].sort((a, b) => {
        const coordsA = (() => {
          if (a.patient_id) {
            const p = patients.find((x) => x?.id === a.patient_id);
            return p ? { lat: Number(p.latitude), lon: Number(p.longitude) } : null;
          }
          const s = stores.find((x) => x?.id === a.store_id);
          return s ? { lat: Number(s.latitude), lon: Number(s.longitude) } : null;
        })();
        const coordsB = (() => {
          if (b.patient_id) {
            const p = patients.find((x) => x?.id === b.patient_id);
            return p ? { lat: Number(p.latitude), lon: Number(p.longitude) } : null;
          }
          const s = stores.find((x) => x?.id === b.store_id);
          return s ? { lat: Number(s.latitude), lon: Number(s.longitude) } : null;
        })();
        const distA = coordsA ? haversineKm(startCoords.lat, startCoords.lon, coordsA.lat, coordsA.lon) : 9999;
        const distB = coordsB ? haversineKm(startCoords.lat, startCoords.lon, coordsB.lat, coordsB.lon) : 9999;
        return distA - distB;
      });

      const crowSortedIds = crowSorted.map((d) => d.id);

      // ── 4. Compute stop_order slots ───────────────────────────────────────
      // Sequence: [finished] → startMarker → [cycling stops] → endMarker → [driving stops]
      // We anchor everything off the finished-stop count so the sequence is always correct
      // regardless of what stop_orders were previously in the DB.
      const finishedCount = deliveriesWithStopOrder.filter(
        (d) => d && d.driver_id === currentUser.id && d.delivery_date === deliveryDateStr && FINISHED.has(d.status)
      ).length;

      const startMarkerOrder  = finishedCount + 1;
      const cyclingStartOrder = startMarkerOrder + 1;                          // first cycling stop
      const endMarkerOrder    = cyclingStartOrder + selectedDeliveries.length; // end marker
      // Driving stops keep their existing relative order, renumbered from endMarkerOrder + 1
      const drivingStops = deliveriesWithStopOrder
        .filter(
          (d) =>
            d &&
            !d.is_cycling_marker &&
            !selectedModeStopIds.includes(d.id) &&
            !FINISHED.has(d.status) &&
            d.driver_id === currentUser.id &&
            d.delivery_date === deliveryDateStr
        )
        .sort((a, b) => (Number(a.stop_order) || 999) - (Number(b.stop_order) || 999));

      // ── 5. Atomic stop_order + isNextDelivery writes ──────────────────────
      // Order: set new isNextDelivery on start marker first, then clear all others,
      // then write stop_orders — all in parallel for speed.
      const stopOrderWrites = [];

      // Start marker: driving mode, isNextDelivery=true, anchored order
      stopOrderWrites.push(
        base44.entities.Delivery.update(startMarker.id, {
          stop_order: startMarkerOrder,
          display_stop_order: startMarkerOrder,
          isNextDelivery: true,
          transport_mode: 'driving',
        }).catch(() => null)
      );

      // End marker: cycling mode, anchored order
      stopOrderWrites.push(
        base44.entities.Delivery.update(endMarker.id, {
          stop_order: endMarkerOrder,
          display_stop_order: endMarkerOrder,
          transport_mode: 'cycling',
        }).catch(() => null)
      );

      // Cycling stops: crow-flies order, transport_mode=cycling
      crowSorted.forEach((d, i) => {
        stopOrderWrites.push(
          base44.entities.Delivery.update(d.id, {
            stop_order: cyclingStartOrder + i,
            display_stop_order: cyclingStartOrder + i,
            transport_mode: 'cycling',
          }).catch(() => null)
        );
      });

      // Driving stops: preserve relative order, renumber from end marker + 1
      drivingStops.forEach((d, i) => {
        stopOrderWrites.push(
          base44.entities.Delivery.update(d.id, {
            stop_order: endMarkerOrder + 1 + i,
            display_stop_order: endMarkerOrder + 1 + i,
          }).catch(() => null)
        );
      });

      // Clear isNextDelivery from every other stop for this driver/date
      const otherNextStops = deliveriesWithStopOrder.filter(
        (d) =>
          d &&
          d.isNextDelivery === true &&
          d.id !== startMarker.id &&
          d.driver_id === currentUser.id
      );
      otherNextStops.forEach((d) => {
        stopOrderWrites.push(
          base44.entities.Delivery.update(d.id, { isNextDelivery: false }).catch(() => null)
        );
      });

      // Save cycling mode preference + fetch HERE key + flush all stop_order writes in parallel
      const [,, hereKeyResp] = await Promise.all([
        updatePreferredTravelMode(appUsers, currentUser.id, 'cycling').then(() => setPreferredTravelMode('cycling')).catch(() => null),
        Promise.all(stopOrderWrites),
        base44.functions.invoke('getActiveHereApiKey', {}).catch(() => null),
      ]);

      const hereApiKey = hereKeyResp?.data?.apiKey || hereKeyResp?.apiKey || null;

      // ── 6. Reflect all changes into local React state immediately ─────────
      const localUpserts = [
        { ...startMarker, stop_order: startMarkerOrder, display_stop_order: startMarkerOrder, isNextDelivery: true, transport_mode: 'driving' },
        { ...endMarker,   stop_order: endMarkerOrder,   display_stop_order: endMarkerOrder,   transport_mode: 'cycling' },
        ...crowSorted.map((d, i) => ({ ...d, stop_order: cyclingStartOrder + i, display_stop_order: cyclingStartOrder + i, transport_mode: 'cycling' })),
        ...drivingStops.map((d, i) => ({ ...d, stop_order: endMarkerOrder + 1 + i, display_stop_order: endMarkerOrder + 1 + i })),
        ...otherNextStops.map((d) => ({ ...d, isNextDelivery: false })),
      ];
      applyDeliveryChangesLocally?.({ upserts: localUpserts, deleteIds: [] });

      try {
        const { offlineDB } = await import('@/components/utils/offlineDatabase');
        offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, localUpserts).catch(() => null);
      } catch { /* offlineDB optional */ }

      console.log(
        `[useModeRouteDialog] Stop orders written | startMarker=${startMarkerOrder}` +
        ` | cyclingStops=${cyclingStartOrder}–${cyclingStartOrder + selectedDeliveries.length - 1}` +
        ` | endMarker=${endMarkerOrder} | drivingStops from=${endMarkerOrder + 1}`
      );

      // ── 7. Stage 1 — Bicycle optimization (cycling loop) ─────────────────
      // Origin: Start marker coords
      // Destination: End marker coords
      // Waypoints: selected cycling stops in crow-flies pre-sorted order
      // Mode: bicycle
      // Stages 1 and 2 write to non-overlapping stop_order ranges → safe to run in parallel.
      const [stage1Result] = await Promise.all([
        base44.functions.invoke('optimizeRemainingStops', {
          driverId: currentUser.id,
          deliveryDate: deliveryDateStr,
          currentLocalTime,
          bypassDriverStatus: true,
          triggerSource: 'cyclingMode:stage1',
          hereApiKey,
          cyclingSegmentOnly: true,
          cyclingOrigin: startCoords,
          cyclingDestination: endCoords,
          cyclingStopIds: crowSortedIds,
          startingStopOrder: cyclingStartOrder,
        }).catch((e) => { console.warn('[useModeRouteDialog] Stage 1 failed:', e?.message); return null; }),

        // ── Stage 2 — Car optimization (remaining driving stops) ──────────
        // Origin: End marker coords (driver exits the cycling loop here)
        // Waypoints: all non-cycling, non-marker active stops for this driver/date
        // Preserves relative driving stop order — does not reorder from scratch.
        // startingStopOrder anchors driving stops immediately after the end marker.
        base44.functions.invoke('optimizeRemainingStops', {
          driverId: currentUser.id,
          deliveryDate: deliveryDateStr,
          currentLocalTime,
          bypassDriverStatus: true,
          forceFullRemainingRouteOptimization: false,
          triggerSource: 'cyclingMode:stage2',
          hereApiKey,
          drivingSegmentOnly: true,
          drivingOrigin: endCoords,
          excludeStopIds: [startMarker.id, endMarker.id, ...crowSortedIds],
          startingStopOrder: endMarkerOrder + 1,
        }).catch((e) => { console.warn('[useModeRouteDialog] Stage 2 failed:', e?.message); return null; }),
      ]);

      console.log('[useModeRouteDialog] Stage 1+2 complete');

      // ── 8. Stage 3 — Polyline regeneration ───────────────────────────────
      // purgeAndRegeneratePolylines groups consecutive same-transport_mode stops
      // and issues one HERE directions call per group:
      //   driving  → ... → Start marker  (driving polyline)
      //   cycling  → selected stops → End marker  (cycling polyline)
      //   driving  → ... remaining driving stops  (driving polyline)
      // The orderedDeliveryIds hint lets the backend skip re-sorting from DB.
      try {
        const orderedIds = Array.isArray(stage1Result?.data?.optimizedRoute)
          ? stage1Result.data.optimizedRoute.map((s) => s.deliveryId).filter(Boolean)
          : [];

        await base44.functions.invoke('purgeAndRegeneratePolylines', {
          driverId: currentUser.id,
          deliveryDate: deliveryDateStr,
          scope: 'active_only',
          reason: 'route_reordered',
          bypassDriverStatus: true,
          ...(orderedIds.length > 0 ? { orderedDeliveryIds: orderedIds } : {}),
        });
        console.log('[useModeRouteDialog] Stage 3 polyline regen complete');
      } catch (e) {
        console.warn('[useModeRouteDialog] Stage 3 polyline regen failed:', e?.message);
      }

      setModeDialogOpen(false);
      toast.success('Cycling route set — route optimized.');
    } catch (e) {
      console.error('[useModeRouteDialog] handleModeOptimize error:', e?.message);
      toast.error('Failed to start cycling mode.');
    } finally {
      setIsOptimizingModeRoute(false);
      isRunningRef.current = false;
    }
  }, [
    selectedModeStopIds,
    currentUser,
    appUsers,
    setPreferredTravelMode,
    currentModeLocation,
    deliveriesWithStopOrder,
    patients,
    stores,
    selectedDate,
    applyDeliveryChangesLocally,
  ]);

  return {
    modeDialogOpen,
    setModeDialogOpen,
    nearbyModeStops,
    selectedModeStopIds,
    toggleModeStop,
    returnToCurrentLocation,
    toggleReturnToCurrentLocation,
    handleModeOptimize,
    isOptimizingModeRoute,
  };
}
