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

      // ── 4. Tag selected stops as cycling transport mode + fetch HERE key (parallel) ──
      const [updatedStops, hereKeyResp] = await Promise.all([
        Promise.all(
          selectedDeliveries.map((d) =>
            base44.entities.Delivery.update(d.id, { transport_mode: 'cycling' })
              .then((updated) => updated || { ...d, transport_mode: 'cycling' })
              .catch(() => ({ ...d, transport_mode: 'cycling' }))
          )
        ),
        base44.functions.invoke('getActiveHereApiKey', {}).catch(() => null),
      ]);

      // ── 5. Persist to IDB + merge into local React state immediately ──────
      const allUpserts = [...updatedStops].filter(Boolean);
      try {
        const { offlineDB } = await import('@/components/utils/offlineDatabase');
        offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, allUpserts).catch(() => null);
      } catch { /* offlineDB optional */ }
      applyDeliveryChangesLocally?.({ upserts: allUpserts, deleteIds: [] });

      const hereApiKey = hereKeyResp?.data?.apiKey || hereKeyResp?.apiKey || null;
      const markerCoords = { lat: loc.latitude, lon: loc.longitude };
      const excludeIds = [...selectedModeStopIds].filter(Boolean);

      // ── 6. Stage 1 + Stage 2 optimization in parallel ────────────────────
      // Stage 1: optimize the cycling segment (bicycle mode)
      // Stage 2: optimize remaining driving stops (car mode)
      // They write to non-overlapping stop_order ranges so they are safe to run concurrently.
      const [stage1Result] = await Promise.all([
        base44.functions.invoke('optimizeRemainingStops', {
          driverId: currentUser.id,
          deliveryDate: deliveryDateStr,
          currentLocalTime,
          bypassDriverStatus: true,
          triggerSource: 'cyclingMode:stage1',
          hereApiKey,
          cyclingSegmentOnly: true,
          cyclingOrigin: markerCoords,
          cyclingDestination: markerCoords,
          cyclingStopIds: selectedModeStopIds,
          startingStopOrder: Math.max(1, Math.ceil(minSelectedOrder)),
        }).catch((e) => { console.warn('[useModeRouteDialog] Stage 1 failed:', e?.message); return null; }),

        base44.functions.invoke('optimizeRemainingStops', {
          driverId: currentUser.id,
          deliveryDate: deliveryDateStr,
          currentLocalTime,
          bypassDriverStatus: true,
          forceFullRemainingRouteOptimization: true,
          triggerSource: 'cyclingMode:stage2',
          hereApiKey,
          drivingSegmentOnly: true,
          drivingOrigin: markerCoords,
          excludeStopIds: excludeIds,
          startingStopOrder: Math.ceil(minSelectedOrder) + selectedDeliveries.length,
        }).catch((e) => { console.warn('[useModeRouteDialog] Stage 2 failed:', e?.message); return null; }),
      ]);

      console.log('[useModeRouteDialog] Stage 1+2 optimization complete');

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