import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

  // Resolve cycling start marker coordinates for distance calculation
  const cyclingStartLocation = useMemo(() => {
    // Canonical identifier: delivery_notes === 'Cycling Route Start' (exact string).
    // IMPORTANT: When multiple cycling routes exist on the same day (e.g. one completed earlier,
    // one active now), prefer the non-completed/non-failed marker so we measure distances
    // from the *active* cycling start point, not the already-finished one.
    const DONE = new Set(['completed', 'failed', 'cancelled', 'returned']);
    const isStartMarker = (d) =>
      d?.is_cycling_marker && (
        d.delivery_notes === 'Cycling Route Start' ||
        (d.delivery_notes || '').toLowerCase().includes('start')
      );
    // First pass: active (not done) start marker
    let startMarker = deliveriesWithStopOrder.find(
      (d) => isStartMarker(d) && !DONE.has(d.status)
    );
    // Fallback: any start marker (e.g. if somehow all are completed)
    if (!startMarker) {
      startMarker = deliveriesWithStopOrder.find(isStartMarker);
    }
    if (startMarker?.cycling_latitude && startMarker?.cycling_longitude) {
      return { latitude: Number(startMarker.cycling_latitude), longitude: Number(startMarker.cycling_longitude) };
    }
    return null;
  }, [deliveriesWithStopOrder]);

  const nearbyModeStops = useMemo(() => getNearbyModeStops({
    deliveries: deliveriesWithStopOrder,
    patients,
    stores,
    currentLocation: currentModeLocation,
    cyclingStartLocation,
    radiusKm: 50,
  }), [deliveriesWithStopOrder, patients, stores, currentModeLocation, cyclingStartLocation]);

  const toggleModeStop = useCallback((stopId) => {
    setSelectedModeStopIds((prev) =>
      prev.includes(stopId) ? prev.filter((id) => id !== stopId) : [...prev, stopId]
    );
  }, []);

  const toggleReturnToCurrentLocation = useCallback(() => {
    setReturnToCurrentLocation((prev) => !prev);
  }, []);

  // Keep a ref to deliveriesWithStopOrder so the event handler can read it without stale closure
  const deliveriesRef = useRef(deliveriesWithStopOrder);
  useEffect(() => { deliveriesRef.current = deliveriesWithStopOrder; }, [deliveriesWithStopOrder]);

  // Re-open dialog after Accept All (or any openCyclingModeDialog event) when cycling mode is active.
  // Pre-seed selectedModeStopIds with stops that are already set to transport_mode='cycling'
  // so the driver sees their current cycling stops already checked.
  // Also enforces the past-date guard: if the event includes a deliveryDate in the past, skip.
  useEffect(() => {
    const handler = (e) => {
      const deliveryDate = e?.detail?.deliveryDate;
      if (deliveryDate) {
        const today = new Date().toISOString().split('T')[0];
        if (deliveryDate < today) return; // past date — bypass stop-select dialog
      }
      const alreadyCycling = (deliveriesRef.current || [])
        .filter((d) => d && !d.is_cycling_marker && d.transport_mode === 'cycling')
        .map((d) => d.id);
      setSelectedModeStopIds(alreadyCycling);
      setModeDialogOpen(true);
    };
    window.addEventListener('openCyclingModeDialog', handler);
    return () => window.removeEventListener('openCyclingModeDialog', handler);
  }, []);

  const isRunningRef = useRef(false);

  const handleModeOptimize = useCallback(async () => {
    if (selectedModeStopIds.length === 0 || !currentUser?.id) return;
    if (isRunningRef.current) return;
    isRunningRef.current = true;
    setIsOptimizingModeRoute(true);

    // Close the dialog immediately — driver should not be blocked waiting
    setModeDialogOpen(false);

    try {
      const now = new Date();
      const deliveryDateStr = selectedDate
        ? (typeof selectedDate === 'string' ? selectedDate : format(selectedDate, 'yyyy-MM-dd'))
        : format(now, 'yyyy-MM-dd');

      const FINISHED = new Set(['completed', 'failed', 'cancelled', 'returned']);

      // ── 0. Wait briefly for real marker IDs to land in local state ────────
      // DeliveryFormView creates markers in parallel and swaps temp→real IDs.
      // Give that a moment to settle so we read real IDs, not temp_ ones.
      await new Promise((resolve) => setTimeout(resolve, 800));

      // Re-read from offline DB to get the authoritative post-flush state
      let freshDeliveries = deliveriesWithStopOrder;
      try {
        const { offlineDB } = await import('@/components/utils/offlineDatabase');
        const allLocal = await offlineDB.getAll(offlineDB.STORES.DELIVERIES).catch(() => []);
        const driverDateLocal = (allLocal || []).filter(
          (d) => d && d.driver_id === currentUser.id && d.delivery_date === deliveryDateStr && !d._isLocal && !String(d.id || '').startsWith('temp_')
        );
        if (driverDateLocal.length > 0) freshDeliveries = driverDateLocal;
      } catch { /* use deliveriesWithStopOrder as fallback */ }

      // ── 1. Resolve Start and End markers ──────────────────────────────────
      // Prefer non-completed markers — when multiple cycling routes exist on the same day
      // (one completed, one active) we must use the active pair, not the finished one.
      const _DONE = new Set(['completed', 'failed', 'cancelled', 'returned']);
      const isStartM = (d) => d?.is_cycling_marker && (d.delivery_notes === 'Cycling Route Start' || (d.delivery_notes || '').toLowerCase().includes('start'));
      const isEndM   = (d) => d?.is_cycling_marker && (d.delivery_notes === 'Cycling Route End'   || (d.delivery_notes || '').toLowerCase().includes('end'));
      const startMarker = (freshDeliveries.find((d) => isStartM(d) && !_DONE.has(d.status)) || freshDeliveries.find(isStartM)) ?? null;
      const endMarker   = (freshDeliveries.find((d) => isEndM(d)   && !_DONE.has(d.status)) || freshDeliveries.find(isEndM))   ?? null;

      if (!startMarker || !endMarker) {
        toast.error('Cycling markers not found — please try again.');
        return;
      }

      // ── 2. Resolve marker GPS coords ──────────────────────────────────────
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

      // ── 3. Resolve selected cycling stops ─────────────────────────────────
      const selectedDeliveries = freshDeliveries.filter(
        (d) => d && selectedModeStopIds.includes(d.id) && !d.is_cycling_marker
      );

      if (selectedDeliveries.length === 0) {
        toast.error('No valid stops selected.');
        return;
      }

      // ── 4. Crow-flies sort selected stops from the Start marker ───────────
      const crowSorted = [...selectedDeliveries].sort((a, b) => {
        const getCoords = (d) => {
          if (d.patient_id) {
            const p = patients.find((x) => x?.id === d.patient_id);
            return p ? { lat: Number(p.latitude), lon: Number(p.longitude) } : null;
          }
          const s = stores.find((x) => x?.id === d.store_id);
          return s ? { lat: Number(s.latitude), lon: Number(s.longitude) } : null;
        };
        const ca = getCoords(a), cb = getCoords(b);
        const da = ca ? haversineKm(startCoords.lat, startCoords.lon, ca.lat, ca.lon) : 9999;
        const db = cb ? haversineKm(startCoords.lat, startCoords.lon, cb.lat, cb.lon) : 9999;
        return da - db;
      });
      const crowSortedIds = crowSorted.map((d) => d.id);

      // ── 5. Compute authoritative stop_order layout ────────────────────────
      // [finished] → startMarker → [cycling stops] → endMarker → [driving stops]
      const finishedCount = freshDeliveries.filter(
        (d) => d && d.driver_id === currentUser.id && d.delivery_date === deliveryDateStr && FINISHED.has(d.status)
      ).length;

      const startMarkerOrder  = finishedCount + 1;
      const cyclingStartOrder = startMarkerOrder + 1;
      const endMarkerOrder    = cyclingStartOrder + selectedDeliveries.length;

      const drivingStops = freshDeliveries
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

      // ── 6. Build the full local delivery list the optimizer will run on ───
      // Apply all the stop_order + transport_mode + isNextDelivery changes
      // directly to the in-memory array so the client engine sees fresh state.
      const otherNextStops = freshDeliveries.filter(
        (d) => d && d.isNextDelivery === true && d.id !== startMarker.id && d.driver_id === currentUser.id
      );

      const updatedStartMarker  = { ...startMarker, stop_order: startMarkerOrder, isNextDelivery: true,  transport_mode: 'driving'  };
      const updatedEndMarker    = { ...endMarker,   stop_order: endMarkerOrder,   isNextDelivery: false, transport_mode: 'cycling'  };
      const updatedCyclingStops = crowSorted.map((d, i) => ({ ...d, stop_order: cyclingStartOrder + i, transport_mode: 'cycling' }));
      const updatedDrivingStops = drivingStops.map((d, i) => ({ ...d, stop_order: endMarkerOrder + 1 + i }));
      const clearedNextStops    = otherNextStops.map((d) => ({ ...d, isNextDelivery: false }));

      const localUpserts = [
        updatedStartMarker,
        updatedEndMarker,
        ...updatedCyclingStops,
        ...updatedDrivingStops,
        ...clearedNextStops,
      ];

      // Apply to local UI and IDB immediately so the stop cards reflect the new order
      applyDeliveryChangesLocally?.({ upserts: localUpserts, deleteIds: [] });
      try {
        const { offlineDB } = await import('@/components/utils/offlineDatabase');
        offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, localUpserts).catch(() => null);
      } catch { /* non-fatal */ }

      // ── 6b. Persist transport_mode='cycling' to the backend for selected stops ───
      // The local upsert above updates in-memory + IDB but the backend still has the
      // old transport_mode. Write it now so other devices and reloads see the correct mode.
      // Fire-and-forget — don't block optimization on these writes.
      const cyclingModeWrites = updatedCyclingStops.map((d) =>
        base44.entities.Delivery.update(d.id, { transport_mode: 'cycling' }).catch(() => null)
      );
      Promise.all(cyclingModeWrites).catch(() => null); // non-blocking

      // Build the full merged delivery list for the optimizer (replaces stale records)
      const updatedById = new Map(localUpserts.map((d) => [d.id, d]));
      const mergedDeliveries = freshDeliveries.map((d) => updatedById.get(d.id) || d);

      // ── 7. Save cycling mode preference (fire-and-forget) ─────────────────
      updatePreferredTravelMode(appUsers, currentUser.id, 'cycling')
        .then(() => setPreferredTravelMode('cycling'))
        .catch(() => null);

      // ── 8. Client-side route optimization — run SEQUENTIALLY ─────────────
      // Stage 1 must finish first so its stop_order + polyline results are in the
      // DB before stage 2 reads driving stops and sequences them.
      const { performRouteOptimization } = await import('@/components/utils/routeOptimizationCoordinator');

      // Stage 1: Cycling loop
      // Origin = Cycling Start marker coords → Destination = Cycling End marker coords
      // Waypoints = selected stops (in crow-flies pre-sorted order)
      const stage1Result = await performRouteOptimization({
        driverId: currentUser.id,
        deliveryDate: deliveryDateStr,
        deliveries: mergedDeliveries,
        patients,
        stores,
        appUsers,
        source: 'cyclingMode:stage1',
        bypassDriverStatus: true,
        cyclingSegmentOnly: true,
        cyclingOrigin: startCoords,
        cyclingDestination: endCoords,
        cyclingStopIds: crowSortedIds,
        startingStopOrder: cyclingStartOrder,
        skipPolyline: false,
      }).catch((e) => { console.warn('[useModeRouteDialog] Stage 1 failed:', e?.message); return null; });

      // Merge stage 1 results into the delivery list before running stage 2
      const stage1WriteMap = new Map((stage1Result?.optimizeData?.writeBatch || []).map(({ id, data }) => [id, data]));
      const mergedAfterStage1 = mergedDeliveries.map((d) => {
        const patch = stage1WriteMap.get(d.id);
        return patch ? { ...d, ...patch } : d;
      });

      // Stage 2: Driving segment
      // Origin = Cycling End marker coords (driver exits cycling loop here)
      // Remaining driving stops are RE-SEQUENCED by HERE with home as the end anchor.
      // preserveExistingOrder=false → HERE optimizes the order; home is the final destination.
      const stage2Result = await performRouteOptimization({
        driverId: currentUser.id,
        deliveryDate: deliveryDateStr,
        deliveries: mergedAfterStage1,
        patients,
        stores,
        appUsers,
        source: 'cyclingMode:stage2',
        bypassDriverStatus: true,
        drivingSegmentOnly: true,
        drivingOrigin: endCoords,
        excludeStopIds: [startMarker.id, endMarker.id, ...crowSortedIds],
        startingStopOrder: endMarkerOrder + 1,
        preserveExistingOrder: false,
        skipPolyline: false,
      }).catch((e) => { console.warn('[useModeRouteDialog] Stage 2 failed:', e?.message); return null; });

      console.log('[useModeRouteDialog] Stage 1+2 complete', {
        stage1: stage1Result?.success, stage2: stage2Result?.success,
      });

      toast.success('Cycling route set — route optimized.');
    } catch (e) {
      console.error('[useModeRouteDialog] handleModeOptimize error:', e?.message);
      toast.error('Failed to optimize cycling route.');
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