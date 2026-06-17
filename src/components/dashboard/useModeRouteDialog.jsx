import { useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { getCurrentDriverLocation, getNearbyModeStops } from '@/components/dashboard/modeButtonHelpers';
import { updatePreferredTravelMode } from '@/components/dashboard/travelModeHelpers';
import { getDriverNameForStorage } from '@/components/utils/driverUtils';
import { generateBikDeliveryId } from '@/components/utils/idGenerator';
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

      const ampmDesignation = now.getHours() < 14 ? 'AM' : 'PM';
      const currentLocalTime = format(now, 'HH:mm');

      // End marker time windows: start = now + 90min, end = now + 120min
      const endMarkerTimeStart = format(new Date(now.getTime() + 90 * 60 * 1000), 'HH:mm');
      const endMarkerTimeEnd   = format(new Date(now.getTime() + 120 * 60 * 1000), 'HH:mm');

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
      const maxSelectedOrder = selectedDeliveries.reduce(
        (max, d) => Math.max(max, d.stop_order ?? 0), 0
      );

      // Start marker: sorts before all selected cycling stops
      const startMarkerOrder = Math.max(0, minSelectedOrder - 0.5);
      // End marker: sorts after all selected cycling stops
      const endMarkerOrder = maxSelectedOrder + 0.5;

      // ── 2. Find the stop immediately before the Start marker (for polyline Stage 1 origin) ──
      // This is the last active/completed stop with stop_order < startMarkerOrder
      const stopBeforeStart = [...deliveriesWithStopOrder]
        .filter((d) => d && !d.is_cycling_marker && (d.stop_order ?? 999) < startMarkerOrder)
        .sort((a, b) => (b.stop_order ?? 0) - (a.stop_order ?? 0))[0] || null;

      // ── 3. Resolve driver name ────────────────────────────────────────────
      const driverAppUser = appUsers.find((au) => au?.user_id === currentUser.id);
      const driverRecord = driverAppUser || currentUser;
      const driverName = getDriverNameForStorage(driverRecord) || currentUser.full_name || '';

      // ── 4. Base payload — both markers share the same GPS (loop) ──────────
      // Collect existing BIK- ids so generateBikDeliveryId avoids collisions
      const existingBikIds = (deliveriesWithStopOrder || [])
        .filter((d) => d?.delivery_id?.startsWith('BIK-'))
        .map((d) => d.delivery_id);
      const startBikId = generateBikDeliveryId(existingBikIds);
      const endBikId   = generateBikDeliveryId([...existingBikIds, startBikId]);

      // created_by_app_user_id = the AppUser record id (not user_id) for the current driver
      const createdByAppUserId = driverAppUser?.id || null;

      const baseMarkerPayload = {
        driver_id: currentUser.id,
        driver_name: driverName,
        delivery_date: deliveryDateStr,
        is_cycling_marker: true,
        status: 'in_transit',
        no_charge: true,
        ampm_deliveries: ampmDesignation,
        cycling_latitude: loc.latitude,
        cycling_longitude: loc.longitude,
        created_by_app_user_id: createdByAppUserId,
      };

      // ── 5. Save cycling mode preference ──────────────────────────────────
      await updatePreferredTravelMode(appUsers, currentUser.id, 'cycling');
      setPreferredTravelMode('cycling');

      // ── 6. Create Start + End markers atomically ──────────────────────────
      // Start: transport_mode = 'driving'  (road leading INTO the cycling loop)
      // End:   transport_mode = 'cycling'  (cycling road OUT of the loop)
      // Both at the same GPS — identical pin location = loop
      const [startMarker, endMarker] = await Promise.all([
        base44.entities.Delivery.create({
          ...baseMarkerPayload,
          delivery_id: startBikId,
          delivery_notes: 'Cycling Route Start',
          transport_mode: 'driving',
          stop_order: startMarkerOrder,
        }),
        base44.entities.Delivery.create({
          ...baseMarkerPayload,
          delivery_id: endBikId,
          delivery_notes: 'Cycling Route End',
          transport_mode: 'cycling',
          stop_order: endMarkerOrder,
          delivery_time_start: endMarkerTimeStart,
          delivery_time_end: endMarkerTimeEnd,
        }),
      ]);

      // ── 7. Tag selected stops as cycling transport mode ───────────────────
      const updatedStops = await Promise.all(
        selectedDeliveries.map((d) =>
          base44.entities.Delivery.update(d.id, { transport_mode: 'cycling' })
            .then((updated) => updated || { ...d, transport_mode: 'cycling' })
            .catch(() => ({ ...d, transport_mode: 'cycling' }))
        )
      );

      // ── 8. Persist to IDB + merge into local React state immediately ──────
      const allUpserts = [startMarker, endMarker, ...updatedStops].filter(Boolean);
      try {
        const { offlineDB } = await import('@/components/utils/offlineDatabase');
        offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, allUpserts).catch(() => null);
      } catch { /* offlineDB optional */ }
      applyDeliveryChangesLocally?.({ upserts: allUpserts, deleteIds: [] });

      // ── 9. Fetch the HERE API key ─────────────────────────────────────────
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
          // Write stop_order starting right after the Start marker
          startingStopOrder: Math.ceil(startMarkerOrder) + 1,
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
        startMarker?.id,
        endMarker?.id,
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
          // Write stop_order starting right after the End marker
          startingStopOrder: Math.ceil(endMarkerOrder) + 1,
        });
        console.log('[useModeRouteDialog] Stage 2 driving optimization complete');
      } catch (e) {
        console.warn('[useModeRouteDialog] Stage 2 driving optimization failed:', e?.message);
      }

      // ────────────────────────────────────────────────────────────────────
      // STAGE 3 — Regenerate all polylines
      //
      // Polyline segments (in stop_order):
      //   3a) DRIVING: stop prior to Cycling Route Start → Cycling Route Start
      //   3b) CYCLING: Cycling Route Start → selected stops → Cycling Route End
      //   3c) DRIVING: Cycling Route End → remaining driving stops
      //
      // purgeAndRegeneratePolylines already handles mixed-mode segment grouping
      // correctly via groupModeOverrideRanges — it batches consecutive same-mode
      // segments and calls getHereDirections once per group with the right transport.
      //
      // We pass resolvedOriginCoords = stop prior to Start marker so the very first
      // segment (Stage 3a) routes FROM the correct preceding stop.
      // ────────────────────────────────────────────────────────────────────

      // Resolve the coords of the stop prior to Start marker
      // For now we pass it directly; purgeAndRegeneratePolylines uses resolvedOriginCoords
      // as the explicit origin for the first active segment.
      let priorStopCoords = null;
      if (stopBeforeStart) {
        // We don't resolve patient/store coords client-side — pass the stop ID
        // and let the backend resolve. Use explicitRouteOrigin = 'last_finished_stop'
        // if stopBeforeStart is completed, otherwise pass its id via routeStopOrder
        // and let the normal chain handle it.
        // Simplest correct approach: pass resolvedOriginCoords = null and let the
        // backend resolve from latestFinishedStop (which IS the stop before start
        // once the cycling markers are in place).
        priorStopCoords = null; // backend will resolve via latestFinishedStop
      }

      try {
        await base44.functions.invoke('purgeAndRegeneratePolylines', {
          driverId: currentUser.id,
          deliveryDate: deliveryDateStr,
          scope: 'active_only',
          reason: 'route_reordered',
          bypassDriverStatus: true,
          // Let backend resolve the origin from last finished stop naturally
          explicitRouteOrigin: stopBeforeStart ? 'last_finished_stop' : null,
          resolvedOriginCoords: priorStopCoords,
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