import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Navigation, Phone, MapPin } from "lucide-react";
import { format } from 'date-fns';
import { base44 } from "@/api/base44Client";
import { isAppOwner } from '@/components/utils/userRoles';
import { pauseOfflineMutations, resumeOfflineMutations } from "@/components/utils/offlineMutations";
import { pauseOfflineSync, resumeOfflineSync } from "@/components/utils/offlineSync";
import MapViewCycleFAB from "@/components/dashboard/MapViewCycleFAB";
import ImmersiveActionFAB from "@/components/dashboard/ImmersiveActionFAB";
import { isMobileDevice } from '@/components/utils/deviceUtils';
import { invalidateDeliveriesForDate } from "@/components/utils/dataManager";
import { fabControlEvents } from "@/components/utils/fabControlEvents";
import { useEffect, useMemo } from "react";

const formatCoordinateValue = (value) => {
  const numericValue = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(numericValue)) return null;
  if (numericValue === 0) return null;
  return String(numericValue);
};

const normalizePhoneNumber = (value) => {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
};

const buildGoogleMapsCoordinateUrl = (latitude, longitude) => {
  const lat = formatCoordinateValue(latitude);
  const lon = formatCoordinateValue(longitude);
  if (!lat || !lon) return null;
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
};

const getMinutesFromTimeString = (value) => {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
};

const getTimeStringFromMinutes = (minutes) => {
  if (!Number.isFinite(minutes)) return null;
  const normalized = ((minutes % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const mins = normalized % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
};

const getRetroEtaSeedTime = (stops = []) => {
  const candidates = (stops || [])
    .map((stop) => getMinutesFromTimeString(stop?.delivery_time_eta || stop?.delivery_time_start || null))
    .filter((value) => Number.isFinite(value));

  if (candidates.length === 0) return null;
  return getTimeStringFromMinutes(Math.min(...candidates));
};

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
  nextStop = null,
  nextStopPhone = null,
  onNavigateToNextStop,
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

  const immersiveFabBottom = `${topOverlayHeight + 12}px`;
  const showReoptimizationFab = isAppOwner(currentUser) && selectedDriverId !== 'all';
  const selectedDriverNextStop = useMemo(() => {
    const targetDriverId = selectedDriverId !== 'all' ? selectedDriverId : currentUser?.id;
    const selectedDateStr = selectedDate ? format(selectedDate, 'yyyy-MM-dd') : null;
    if (!targetDriverId || !selectedDateStr) return null;

    const activeStops = deliveriesWithStopOrder.filter((delivery) =>
      delivery?.driver_id === targetDriverId &&
      delivery?.delivery_date === selectedDateStr &&
      delivery?.status !== 'pending' &&
      !finishedStatuses.includes(delivery?.status)
    );

    return activeStops.find((delivery) => delivery?.isNextDelivery === true)
      || activeStops.sort((a, b) => (a?.stop_order || 9999) - (b?.stop_order || 9999))[0]
      || null;
  }, [deliveriesWithStopOrder, selectedDriverId, currentUser?.id, selectedDate, finishedStatuses]);
  const selectedDriverNextStopPatient = useMemo(() => {
    if (!selectedDriverNextStop?.patient_id) return null;
    return patients.find((item) => item?.id === selectedDriverNextStop.patient_id) || null;
  }, [selectedDriverNextStop, patients]);
  const selectedDriverNextStopStore = useMemo(() => {
    if (!selectedDriverNextStop?.store_id) return null;
    return stores.find((item) => item?.id === selectedDriverNextStop.store_id) || null;
  }, [selectedDriverNextStop, stores]);
  const nextStopLocation = useMemo(() => {
    if (selectedDriverNextStop?.patient_id) {
      return selectedDriverNextStopPatient ? { latitude: selectedDriverNextStopPatient.latitude, longitude: selectedDriverNextStopPatient.longitude } : null;
    }
    if (selectedDriverNextStop?.store_id) {
      return selectedDriverNextStopStore ? { latitude: selectedDriverNextStopStore.latitude, longitude: selectedDriverNextStopStore.longitude } : null;
    }
    return null;
  }, [selectedDriverNextStop, selectedDriverNextStopPatient, selectedDriverNextStopStore]);
  const nextStopPhoneValue = useMemo(() => {
    if (selectedDriverNextStop?.patient_id) {
      return normalizePhoneNumber(selectedDriverNextStopPatient?.phone)
        || normalizePhoneNumber(selectedDriverNextStopPatient?.phone_secondary)
        || normalizePhoneNumber(selectedDriverNextStop?.patient_phone)
        || null;
    }
    return normalizePhoneNumber(selectedDriverNextStopStore?.phone)
      || normalizePhoneNumber(selectedDriverNextStop?.store_phone)
      || null;
  }, [selectedDriverNextStop, selectedDriverNextStopPatient, selectedDriverNextStopStore]);
  const nextStopNavigationHref = useMemo(
    () => buildGoogleMapsCoordinateUrl(nextStopLocation?.latitude, nextStopLocation?.longitude),
    [nextStopLocation]
  );
  const fabSpacing = 52;
  const mapCycleFabRight = immersiveHidden ? 12 : 16;
  const reoptimizationFabRight = mapCycleFabRight + fabSpacing;
  const navigateFabRight = showReoptimizationFab ? reoptimizationFabRight + fabSpacing : mapCycleFabRight + fabSpacing;
  const callFabRight = navigateFabRight + fabSpacing;
  const canCallNextStop = immersiveHidden && !!nextStopPhoneValue;
  const canNavigateNextStop = immersiveHidden && !!nextStopNavigationHref;

  useEffect(() => {
    const unsubscribe = fabControlEvents.subscribe((event) => {
      if (event?.type !== 'IMMERSIVE_MODE_TOGGLED') return;
      if (mapViewPhase !== 2 && mapViewPhase !== 3) return;
      // Re-assert the lock so phases 2/3 stay locked after immersive mode transitions
      setIsMapViewLocked(true);
      setMapViewTrigger((prev) => prev + 1);
    });

    return unsubscribe;
  }, [mapViewPhase, setMapViewTrigger, setIsMapViewLocked]);

  useEffect(() => {
    const handleTrigger = () => {
      const btn = document.querySelector('[title="Re-optimize entire route using Google Maps"]');
      if (btn) btn.click();
    };
    window.addEventListener('triggerManualRouteOptimization', handleTrigger);
    return () => window.removeEventListener('triggerManualRouteOptimization', handleTrigger);
  }, []);

  return (
    <>
      <MapViewCycleFAB currentUser={currentUser} filteredDeliveries={filteredDeliveries} onClick={() => {
        handleMapViewCycle(false);
      }} currentPhase={mapViewPhase} hasVisibleCards={!immersiveHidden && deliveriesWithStopOrder.length > 0} isAIVisible={showAIAssistant && isAIEnabled} isLocked={isMapViewLocked} isEnabled={isMapCycleEnabled} stopCardsHeight={!immersiveHidden && cardsReadyForFAB ? stopCardsBaseHeight : 0} isMotionDimmed={isPrimaryDriverDeviceInMotion} />

      {immersiveHidden && (
        <>
          <ImmersiveActionFAB
            icon={MapPin}
            title="Navigate to next stop"
            onClick={() => {
              if (nextStopNavigationHref) {
                window.open(nextStopNavigationHref, '_blank', 'noopener,noreferrer');
              }
            }}
            disabled={!canNavigateNextStop}
            bottom={immersiveFabBottom}
            right={`${navigateFabRight}px`}
            opacity={isPrimaryDriverDeviceInMotion ? 0.45 : 1}
            className="bg-blue-600 hover:bg-blue-700"
          />
          <ImmersiveActionFAB
            icon={Phone}
            title="Call next stop"
            onClick={() => {
              if (nextStopPhoneValue) {
                window.location.href = `tel:${nextStopPhoneValue}`;
              }
            }}
            disabled={!canCallNextStop}
            bottom={immersiveFabBottom}
            right={`${callFabRight}px`}
            opacity={isPrimaryDriverDeviceInMotion ? 0.45 : 1}
            className="bg-green-600 hover:bg-green-700"
          />
        </>
      )}

      {isAppOwner(currentUser) && selectedDriverId !== 'all' &&
        <motion.div initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0, opacity: 0 }} transition={{ type: "spring", stiffness: 260, damping: 20 }} className="z-[100]"
          style={{ position: fabPosition, bottom: `${(!immersiveHidden && deliveriesWithStopOrder.length > 0 && cardsReadyForFAB ? stopCardsBaseHeight : bottomNavHeight) + 10}px`, right: `${reoptimizationFabRight}px`, zIndex: 700, pointerEvents: 'auto' }}>
          <Button
            onClick={async () => {
              if (isReoptimizing) return;
              setIsReoptimizing(true);
              setOptimizationMessage('Re-optimizing route...');
              setIsEntityUpdating(true);
              pauseOfflineMutations(); pauseOfflineSync();
              await new Promise(r => setTimeout(r, 100));
              if (mapViewPhase === 2 && isMapViewLocked) { if (mapLockTimeoutRef.current) { clearTimeout(mapLockTimeoutRef.current); mapLockTimeoutRef.current = null; } mapLockExpiresAtRef.current = null; setIsMapViewLocked(false); }
              // Capture current map center+zoom so we can restore after optimization
              const preOptCenter = window.__currentMapCenter ? [...window.__currentMapCenter] : null;
              const preOptZoom = window.__currentMapZoom ?? null;
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
                if (allCoords.length > 0) { const pad = getMapPadding(); setShouldFitBounds({ bounds: allCoords, options: { ...pad, maxZoom: 16.5, animate: true } }); setMapCenter(null); setMapZoom(null); }
              }
              try {
                const deliveryDate = format(selectedDate, 'yyyy-MM-dd');
                const now = new Date();
                const currentTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
                const localTime = isDateFinished ? (getRetroEtaSeedTime(incompleteStops) || currentTime) : currentTime;
                const targetDriverId = selectedDriverId !== 'all' ? selectedDriverId : currentUser.id;
                window.dispatchEvent(new CustomEvent('routeOptimizationStarted', { detail: { source: 'optimize_route_fab', driverId: targetDriverId, deliveryDate } }));
                const response = await base44.functions.invoke('optimizeRemainingStops', { driverId: targetDriverId, deliveryDate, currentLocalTime: localTime, deviceTime: now.toISOString(), bypassDriverStatus: true, bypassDeduplication: true, bypassHistoricalCheck: true });
                const data = response?.data || response;
                if (data?.success) {
                  // CRITICAL: optimizeRemainingStops already writes correct polylines directly
                  // to each delivery via HERE API. Calling purgeAndRegeneratePolylines after would
                  // overwrite them with independently-computed segments using wrong origins.
                  // Only call purgeAndRegeneratePolylines as fallback if no polylines came back.
                  const fabOptHasPolylines = Array.isArray(data?.optimizedRoute) && data.optimizedRoute.some((stop) => stop.encoded_polyline);
                  if (!fabOptHasPolylines) {
                    await base44.functions.invoke('purgeAndRegeneratePolylines', {
                      driverId: targetDriverId,
                      deliveryDate,
                      scope: 'active_only',
                      reason: 'manual',
                      sourcePage: 'Dashboard',
                      bypassDriverStatus: true,
                      bypassPolylineDelete: false,
                      reuseProvidedPolylines: false
                    }).catch(() => null);
                  }
                  setOptimizationMessage(`Route optimized! ${data.optimizedCount} stops updated and polylines refreshed.`);
                  invalidateDeliveriesForDate(deliveryDate);
                  const refreshTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Refresh timeout')), 8000));
                  await Promise.race([refreshData(), refreshTimeout]).catch(() => {});
                  window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { driverId: targetDriverId, deliveryDate, triggeredBy: 'reoptimizeRoute', alreadyOptimized: true } }));
                  // Restore the map to pre-optimization position instead of triggering a phase zoom
                  if (preOptCenter && preOptZoom != null) {
                    setShouldFitBounds(null);
                    setMapCenter(preOptCenter);
                    setMapZoom(preOptZoom);
                  } else {
                    setIsMapViewLocked(true); setMapViewTrigger(p => p + 1);
                  }
                  setTimeout(() => { setOptimizationMessage(null); setIsMapViewLocked(false); }, 3000);
                } else { setOptimizationMessage(data?.error || 'Optimization failed'); setTimeout(() => setOptimizationMessage(null), 5000); }
              } catch (e) { setOptimizationMessage(`Error: ${e.message}`); setTimeout(() => setOptimizationMessage(null), 5000); }
              finally { window.dispatchEvent(new CustomEvent('routeOptimizationComplete', { detail: { source: 'optimize_route_fab', driverId: currentUser.id, deliveryDate: format(selectedDate, 'yyyy-MM-dd') } })); resumeOfflineMutations(); resumeOfflineSync(); setIsEntityUpdating(false); setIsReoptimizing(false); }
            }}
            disabled={isReoptimizing || !deliveriesWithStopOrder.some(d => d && !finishedStatuses.includes(d.status))}
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