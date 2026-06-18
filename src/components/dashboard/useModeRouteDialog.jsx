import { useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { getCurrentDriverLocation, getNearbyModeStops } from '@/components/dashboard/modeButtonHelpers';
import { updatePreferredTravelMode } from '@/components/dashboard/travelModeHelpers';
import { useAppData } from '@/components/utils/AppDataContext';
import { base44 } from '@/api/base44Client';
import { format } from 'date-fns';

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
    if (isRunningRef.current) return; // Prevent duplicate submissions
    isRunningRef.current = true;
    setIsOptimizingModeRoute(true);

    try {
      // ── 0. Get current GPS ────────────────────────────────────────────────
      const loc = await new Promise((resolve) => {
        if (navigator?.geolocation) {
          navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
            () => resolve(currentModeLocation),
            { timeout: 5000, maximumAge: 30000 }
          );
        } else {
          resolve(currentModeLocation);
        }
      });

      if (!loc?.latitude || !loc?.longitude) {
        toast.error('Driver location not available.');
        return;
      }

      const now = new Date();
      const deliveryDateStr = selectedDate
        ? (typeof selectedDate === 'string' ? selectedDate : format(selectedDate, 'yyyy-MM-dd'))
        : format(now, 'yyyy-MM-dd');

      const currentLocalTime = format(now, 'HH:mm');

      // ── 1. Resolve selected deliveries and their stop orders ──────────────
      const selectedDeliveries = deliveriesWithStopOrder.filter(
        (d) => d && selectedModeStopIds.includes(d.id) && !d.is_cycling_marker
      );

      if (selectedDeliveries.length === 0) {
        toast.error('No valid stops selected.');
        return;
      }

      const minSelectedOrder = selectedDeliveries.reduce(
        (min, d) => Math.min(min, d.stop_order ?? 999), 999
      );

      // ── 2. Find the stop immediately before the first selected cycling stop (for polyline Stage 1 origin) ──
      // This is the last active/completed stop with stop_order < minSelectedOrder
      const stopBeforeStart = [...deliveriesWithStopOrder]
        .filter((d) => d && !d.is_cycling_marker && (d.stop_order ?? 999) < minSelectedOrder)
        .sort((a, b) => (b.stop_order ?? 0) - (a.stop_order ?? 0))[0] || null;

      // ── 3. Save cycling mode preference ──────────────────────────────────
      await updatePreferredTravelMode(appUsers, currentUser.id, 'cycling');
      setPreferredTravelMode('cycling');

      // ── 4. Tag selected stops as cycling transport mode ───────────────────
      // NOTE: Start/End cycling markers are NOT created here — those come only
      // from the delivery form. This dialog just tags the selected stops and optimizes.
      const updatedStops = await Promise.all(
        selectedDeliveries.map((d) =>
          base44.entities.Delivery.update(d.id, { transport_mode: 'cycling' })
            .then((updated) => updated || { ...d, transport_mode: 'cycling' })
            .catch(() => ({ ...d, transport_mode: 'cycling' }))
        )
      );

      // ── 5. Persist to IDB + merge into local React state immediately ──────
      const allUpserts = [...updatedStops].filter(Boolean);
      try {
        const { offlineDB } = await import('@/components/utils/offlineDatabase');
        offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, allUpserts).catch(() => null);
      } catch { /* offlineDB optional */ }
      applyDeliveryChangesLocally?.({ upserts: allUpserts, deleteIds: [] });

      // ── 6. Fetch the HERE API key ─────────────────────────────────────────
      const hereKeyResp = await base44.functions.invoke('getActiveHereApiKey', {}).catch(() => null);
      const hereApiKey = hereKeyResp?.data?.apiKey || hereKeyResp?.apiKey || null;

      const markerCoords = { lat: loc.latitude, lon: loc.longitude };

      // ────────────────────────────────────────────────────────────────────
      // STAGE 1 — Optimize cycling segment
      // Origin: Cycling Route Start (driver GPS)
      // Destination: Cycling Route End (same driver GPS — loop)
      // Waypoints: only the selected cycling stops
      // HERE mode: bicycle
      // stop_order written starting from startMarkerOrder + 1
      // ────────────────────────────────────────────────────────────────────
      let stage1OrderedIds = [];
      try {
        const resp = await base44.functions.invoke('optimizeRemainingStops', {
          driverId: currentUser.id,
          deliveryDate: deliveryDateStr,
          currentLocalTime,
          bypassDriverStatus: true,
          triggerSource: 'cyclingMode:stage1',
          hereApiKey,
          // Cycling segment params
          cyclingSegmentOnly: true,
          cyclingOrigin: markerCoords,
          cyclingDestination: markerCoords,
          cyclingStopIds: selectedModeStopIds,
          // Write stop_order starting at the first selected cycling stop's position
          startingStopOrder: Math.max(1, Math.ceil(minSelectedOrder)),
        });
        stage1OrderedIds = (resp?.data || resp)?.optimizedRoute?.map((s) => s.deliveryId) || [];
        console.log('[useModeRouteDialog] Stage 1 cycling optimization complete:', stage1OrderedIds.length, 'stops');
      } catch (e) {
        console.warn('[useModeRouteDialog] Stage 1 cycling optimization failed:', e?.message);
      }

      // Small gap so dedupe window doesn't block Stage 2
      await new Promise((r) => setTimeout(r, 1200));

      // ────────────────────────────────────────────────────────────────────
      // STAGE 2 — Optimize remaining driving stops
      // Origin: Cycling Route End (driver GPS — same loop point)
      // Destination: Driver home (handled by optimizer automatically)
      // Waypoints: all remaining active stops excluding cycling stops + both markers
      // HERE mode: car (driver's normal mode)
      // stop_order written starting from endMarkerOrder + 1
      // ────────────────────────────────────────────────────────────────────
      const excludeIds = [
        ...selectedModeStopIds,
      ].filter(Boolean);

      try {
        await base44.functions.invoke('optimizeRemainingStops', {
          driverId: currentUser.id,
          deliveryDate: deliveryDateStr,
          currentLocalTime,
          bypassDriverStatus: true,
          forceFullRemainingRouteOptimization: true,
          triggerSource: 'cyclingMode:stage2',
          hereApiKey,
          // Driving segment params
          drivingSegmentOnly: true,
          drivingOrigin: markerCoords,
          excludeStopIds: excludeIds,
          // Write stop_order starting right after the selected cycling stops
          startingStopOrder: Math.ceil(minSelectedOrder) + selectedDeliveries.length,
        });
        console.log('[useModeRouteDialog] Stage 2 driving optimization complete');
      } catch (e) {
        console.warn('[useModeRouteDialog] Stage 2 driving optimization failed:', e?.message);
      }

      // ────────────────────────────────────────────────────────────────────
      // STAGE 3 — Regenerate all polylines
      // purgeAndRegeneratePolylines handles mixed-mode segment grouping via
      // groupModeOverrideRanges — it batches consecutive same-mode segments and
      // calls getHereDirections once per group with the right transport mode.
      // ────────────────────────────────────────────────────────────────────
      try {
        await base44.functions.invoke('purgeAndRegeneratePolylines', {
          driverId: currentUser.id,
          deliveryDate: deliveryDateStr,
          scope: 'active_only',
          reason: 'route_reordered',
          bypassDriverStatus: true,
          // Let backend resolve the origin from last finished stop naturally
          explicitRouteOrigin: stopBeforeStart ? 'last_finished_stop' : null,
          resolvedOriginCoords: null,
        });
        console.log('[useModeRouteDialog] Stage 3 polyline regen complete');
      } catch (e) {
        console.warn('[useModeRouteDialog] Stage 3 polyline regen failed:', e?.message);
      }

      setModeDialogOpen(false);
      toast.success('Cycling mode activated — route optimized.');
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