import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Navigation } from "lucide-react";
import { format } from 'date-fns';
import { base44 } from "@/api/base44Client";
import { isAppOwner } from '@/components/utils/userRoles';
import { pauseOfflineMutations, resumeOfflineMutations } from "@/components/utils/offlineMutations";
import { pauseOfflineSync, resumeOfflineSync } from "@/components/utils/offlineSync";
import MapViewCycleFAB from "@/components/dashboard/MapViewCycleFAB";
import { isMobileDevice } from '@/components/utils/deviceUtils';
import { invalidateDeliveriesForDate } from "@/components/utils/dataManager";
import { fabControlEvents } from "@/components/utils/fabControlEvents";
import { useEffect, useMemo } from "react";

const buildRadiusBoundsFromStore = (store, radiusKm = 2.5) => {
  if (!store?.latitude || !store?.longitude) return [];
  const lat = Number(store.latitude);
  const lng = Number(store.longitude);
  const latDelta = radiusKm / 111;
  const lngDelta = radiusKm / (111 * Math.cos((lat * Math.PI) / 180) || 1);
  return [
    [lat - latDelta, lng - lngDelta],
    [lat + latDelta, lng + lngDelta]
  ];
};

export default function FABControls({
  currentUser, isDriver, isDispatcher,
  patients, stores, deliveriesWithStopOrder, filteredDeliveries,
  selectedDate, selectedDriverId, isDateFinished,
  mapViewPhase, isMapViewLocked, setIsMapViewLocked,
  driverLocation, cardsReadyForFAB, stopCardsBaseHeight,
  mapLockTimeoutRef, mapLockExpiresAtRef,
  handleMapViewCycle, mapViewTrigger, setMapViewTrigger, getMapPadding,
  setShouldFitBounds, setMapCenter, setMapZoom,
  isReoptimizing, setIsReoptimizing,
  optimizationMessage, setOptimizationMessage,
  setIsEntityUpdating,
  isAIEnabled, showAIAssistant,
  refreshData,
  immersiveHidden = false,
  topOverlayHeight = 0,
}) {
  useEffect(() => {
    const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');

    const unsubscribe = fabControlEvents.subscribe((event) => {
      if (event?.type !== 'DELIVERY_REALTIME_CREATE_DELETE_PULSE') return;
      if (!event?.relevantToCurrentSelection) return;
      if (selectedDriverId !== 'all' && event?.driverId && event.driverId !== selectedDriverId) return;
      if (event?.deliveryDate && event.deliveryDate !== selectedDateStr) return;

      window.__fabFlashUpdate?.('route_change', {
        driverId: event?.driverId || selectedDriverId,
        deliveryDate: event?.deliveryDate || selectedDateStr,
        deliveryId: event?.deliveryId || null
      });
    });

    return unsubscribe;
  }, [selectedDate, selectedDriverId]);
  const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
  const hasAnyStops = deliveriesWithStopOrder.some((delivery) => !!delivery);
  const isMapCycleEnabled = hasAnyStops;
  const fabPosition = isMobileDevice() ? 'absolute' : 'fixed';
  const bottomNavHeight = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--bottom-nav-height') || '0', 10) || 0;
  const selectedStore = stores.find((store) => store?.id === filteredDeliveries?.[0]?.store_id);
  const isPrimaryDriverDeviceInMotion = useMemo(() => {
    if (!isDriver) return false;
    const isPrimaryDevice = currentUser?.driver_status === 'on_duty' && driverLocation?.source !== 'shared_location';
    const speed = Number(driverLocation?.speed ?? 0);
    return isPrimaryDevice && speed > 0;
  }, [isDriver, currentUser?.driver_status, driverLocation]);

  return (
    <>
      <MapViewCycleFAB onClick={() => {
        if (isDispatcher && mapViewPhase === 1 && selectedStore) {
          const pad = getMapPadding();
          setShouldFitBounds({ bounds: buildRadiusBoundsFromStore(selectedStore, 2.5), options: { ...pad, maxZoom: 14, animate: true } });
          setMapCenter(null);
          setMapZoom(null);
        }
        handleMapViewCycle();
      }} currentPhase={mapViewPhase} hasVisibleCards={!immersiveHidden && deliveriesWithStopOrder.length > 0} isAIVisible={showAIAssistant && isAIEnabled} isLocked={isMapViewLocked} isEnabled={isMapCycleEnabled} stopCardsHeight={!immersiveHidden && cardsReadyForFAB ? stopCardsBaseHeight : 0} isMotionDimmed={isPrimaryDriverDeviceInMotion} />

      {isAppOwner(currentUser) && selectedDriverId !== 'all' &&
        <motion.div initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: immersiveHidden ? 0 : 1 }} exit={{ scale: 0, opacity: 0 }} transition={{ type: "spring", stiffness: 260, damping: 20 }} className="z-[100]"
          style={{ position: fabPosition, bottom: `${(!immersiveHidden && deliveriesWithStopOrder.length > 0 && cardsReadyForFAB ? stopCardsBaseHeight : bottomNavHeight) + 10}px`, right: '64px', pointerEvents: immersiveHidden ? 'none' : 'auto' }}>
          <Button
            onClick={async () => {
              if (isReoptimizing) return;
              setIsReoptimizing(true);
              setOptimizationMessage('Re-optimizing route...');
              setIsEntityUpdating(true);
              pauseOfflineMutations(); pauseOfflineSync();
              await new Promise(r => setTimeout(r, 100));
              if (mapViewPhase === 2 && isMapViewLocked) { if (mapLockTimeoutRef.current) { clearTimeout(mapLockTimeoutRef.current); mapLockTimeoutRef.current = null; } mapLockExpiresAtRef.current = null; setIsMapViewLocked(false); }
              const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
              const incompleteStops = deliveriesWithStopOrder.filter(d => d && !finishedStatuses.includes(d.status));
              if (incompleteStops.length > 0) {
                const allCoords = [];
                if (driverLocation?.latitude && driverLocation?.longitude) allCoords.push([driverLocation.latitude, driverLocation.longitude]);
                if (currentUser?.home_latitude && currentUser?.home_longitude) allCoords.push([currentUser.home_latitude, currentUser.home_longitude]);
                incompleteStops.forEach(stop => {
                  if (stop.patient_id) { const p = patients.find(p => p && p.id === stop.patient_id); if (p?.latitude && p?.longitude) allCoords.push([p.latitude, p.longitude]); }
                  else if (stop.store_id) { const s = stores.find(s => s && s.id === stop.store_id); if (s?.latitude && s?.longitude) allCoords.push([s.latitude, s.longitude]); }
                });
                if (allCoords.length > 0) { const pad = getMapPadding(); setShouldFitBounds({ bounds: allCoords, options: { ...pad, maxZoom: 14, animate: true } }); setMapCenter(null); setMapZoom(null); }
              }
              try {
                const deliveryDate = format(selectedDate, 'yyyy-MM-dd');
                const now = new Date(); const localTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
                window.dispatchEvent(new CustomEvent('routeOptimizationStarted', { detail: { source: 'optimize_route_fab', driverId: currentUser.id, deliveryDate } }));
                const response = await base44.functions.invoke('optimizeRemainingStops', { driverId: currentUser.id, deliveryDate, currentLocalTime: localTime, deviceTime: now.toISOString() });
                const data = response?.data || response;
                if (data?.success) {
                  setOptimizationMessage(`Route optimized! ${data.optimizedCount} stops updated.`);
                  invalidateDeliveriesForDate(deliveryDate);
                  // CRITICAL: Use Promise.race to prevent UI freeze if refreshData hangs
                  const refreshTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Refresh timeout')), 8000));
                  await Promise.race([refreshData(), refreshTimeout]).catch(() => {});
                  window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { driverId: currentUser.id, deliveryDate, triggeredBy: 'reoptimizeRoute', alreadyOptimized: true } }));
                  setIsMapViewLocked(true); setMapViewTrigger(p => p + 1);
                  setTimeout(() => { setOptimizationMessage(null); setIsMapViewLocked(false); }, 3000);
                } else { setOptimizationMessage(data?.error || 'Optimization failed'); setTimeout(() => setOptimizationMessage(null), 5000); }
              } catch (e) { setOptimizationMessage(`Error: ${e.message}`); setTimeout(() => setOptimizationMessage(null), 5000); }
              finally { window.dispatchEvent(new CustomEvent('routeOptimizationComplete', { detail: { source: 'optimize_route_fab', driverId: currentUser.id, deliveryDate: format(selectedDate, 'yyyy-MM-dd') } })); resumeOfflineMutations(); resumeOfflineSync(); setIsEntityUpdating(false); setIsReoptimizing(false); }
            }}
            disabled={isReoptimizing || isDateFinished || !filteredDeliveries.some(d => d && d.status === 'in_transit')}
            title="Re-optimize entire route using Google Maps"
            className={`inline-flex items-center justify-center h-10 w-10 rounded-lg shadow-2xl p-0 transition-all duration-200 ${isReoptimizing ? 'bg-amber-500 hover:bg-amber-600' : 'bg-emerald-600 hover:bg-emerald-700'}`}
            style={{ pointerEvents: 'auto', touchAction: 'manipulation', opacity: isPrimaryDriverDeviceInMotion ? 0.45 : 1 }}>
            {isReoptimizing ? <div className="animate-spin w-5 h-5 border-2 border-white border-t-transparent rounded-full" /> : <Navigation className="w-5 h-5 text-white" />}
          </Button>
        </motion.div>
      }
    </>
  );
}