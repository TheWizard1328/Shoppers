import React, { useState } from "react";
import { useDevice } from '@/components/utils/DeviceContext';
import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Navigation } from "lucide-react";
import { format } from "date-fns";
import { base44 } from "@/api/base44Client";
import { isAppOwner } from "@/components/utils/userRoles";
import { pauseOfflineMutations, resumeOfflineMutations } from "@/components/utils/offlineMutations";
import { pauseOfflineSync, resumeOfflineSync } from "@/components/utils/offlineSync";
import RouteOptimizationCompareDialog from "@/components/dashboard/RouteOptimizationCompareDialog";
import { isInterStoreDelivery, getInterStoreLocationSync, resolveInterStoreFromName } from "@/components/utils/interStoreDisplayName";
import { offlineDB } from "@/components/utils/offlineDatabase";
import { invalidate } from "@/components/utils/dataManager";
import { cancelAllDeferredOptimizations } from '@/components/utils/optimizationDebouncer';
import { performRouteOptimization } from '@/components/utils/routeOptimizationCoordinator';

const FINISHED = new Set(['completed', 'failed', 'cancelled', 'returned']);


/**
 * Run the FAB optimization — single-pass, cycling-aware.
 * Cycling markers are handled as fixed anchors inside the client-side engine.
 */
async function runClientSideOptimize({
  driverId,
  deliveryDate,
  deliveries,
  patients,
  stores,
  appUsers,
  currentLocation,
  source,
}) {
  return performRouteOptimization({
    driverId,
    deliveryDate,
    deliveries,
    patients,
    stores,
    appUsers,
    currentLocation,
    source,
    bypassDriverStatus: true,
    preserveExistingOrder: false,
  });
}

export default function RouteActionButtons({
  currentUser,
  selectedDriverId,
  selectedDate,
  deliveriesWithStopOrder,
  filteredDeliveries,
  patients,
  stores,
  cardsReadyForFAB,
  stopCardsBaseHeight,
  isDateFinished,
  isReoptimizing,
  setIsReoptimizing,
  setOptimizationMessage,
  setIsEntityUpdating,
  refreshData,
  setIsMapViewLocked,
  setMapViewTrigger,
  appUsers,
  immersiveHidden,
  updateDeliveriesLocally,
}) {
  const { isMobile } = useDevice();
  const [compareDialogOpen, setCompareDialogOpen] = useState(false);
  const [compareRows, setCompareRows] = useState([]);
  const [cyclingLocations, setCyclingLocations] = useState([]);
  const reoptimizeBtnRef = useRef(null);

  // Pre-fetch CyclingLocations once so getStopName can show real marker names
  useEffect(() => {
    base44.entities.CyclingLocation.list()
      .then((locs) => setCyclingLocations(locs || []))
      .catch(() => {});
  }, []);

  // Build a display name for a delivery
  const getStopName = (delivery) => {
    if (!delivery) return 'Unknown';
    if (delivery.is_cycling_marker) {
      const notes = (delivery.delivery_notes || '').trim().toLowerCase();
      const isEnd = notes.includes('end');
      const label = isEnd ? 'Cycling End' : 'Cycling Start';
      // Try to resolve the real location name from CyclingLocation records
      const lat = delivery.cycling_latitude;
      const lng = delivery.cycling_longitude;
      let locName = null;
      if (lat != null && lng != null && cyclingLocations.length > 0) {
        const THRESH = 0.0005;
        const match = cyclingLocations.find((loc) =>
          Math.abs(loc.latitude - lat) < THRESH && Math.abs(loc.longitude - lng) < THRESH
        );
        locName = match?.name || null;
      }
      return locName ? `${label}: ${locName}` : label;
    }
    if (isInterStoreDelivery(delivery.delivery_id)) {
      const loc = getInterStoreLocationSync(delivery.delivery_id);
      const storeName = loc?.store_name || null;
      const dIdUpper = String(delivery.delivery_id).toUpperCase();
      const tag = dIdUpper.startsWith('ISD-') ? 'ISD' : 'ISP';
      return storeName ? `${storeName}(${tag})` : delivery.delivery_id;
    }
    if (delivery.patient_id) {
      const patient = (patients || []).find((p) => p?.id === delivery.patient_id);
      if (patient?.full_name) return patient.full_name;
    }
    if (delivery.store_id) {
      const store = (stores || []).find((s) => s?.id === delivery.store_id);
      if (store?.name) return `📦 ${store.name}`;
    }
    return delivery.patient_name || delivery.delivery_id || 'Unknown';
  };

  // ── Silent reoptimize triggered programmatically (e.g. after new delivery added) ──
  useEffect(() => {
    const handler = async (e) => {
      const { driverId, deliveryDate } = e.detail || {};
      if (driverId !== selectedDriverId) return;
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (isReoptimizing) return;
      try {
        setIsReoptimizing(true);
        setIsEntityUpdating(true);
        pauseOfflineMutations();
        pauseOfflineSync();
        const date = deliveryDate || format(selectedDate, 'yyyy-MM-dd');
        const driverAppUser = appUsers?.find(
          (au) => au.id === selectedDriverId || au.user_id === selectedDriverId
        );
        const currentLocation =
          driverAppUser?.current_latitude != null
            ? { lat: Number(driverAppUser.current_latitude), lon: Number(driverAppUser.current_longitude) }
            : null;

        const result = await runClientSideOptimize({
          driverId: selectedDriverId,
          deliveryDate: date,
          deliveries: filteredDeliveries || [],
          patients,
          stores,
          appUsers,
          currentLocation,
          source: 'silent_reoptimize',
        });

        if (result?.success) {
          const fresh = result.freshDeliveries || [];
          if (fresh.length > 0) {
            await offlineDB
              .replaceRecordsByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', date, fresh)
              .catch(() => {});
            updateDeliveriesLocally?.(fresh, true);
            window.dispatchEvent(
              new CustomEvent('deliveriesUpdated', {
                detail: {
                  driverId: selectedDriverId,
                  deliveryDate: date,
                  triggeredBy: 'reoptimizeRoute',
                  alreadyOptimized: true,
                  fullReplacement: true,
                  freshDeliveries: fresh,
                },
              })
            );
          } else {
            window.dispatchEvent(
              new CustomEvent('deliveriesUpdated', {
                detail: {
                  driverId: selectedDriverId,
                  deliveryDate: date,
                  triggeredBy: 'reoptimizeRoute',
                  alreadyOptimized: true,
                  preserveLocalState: true,
                },
              })
            );
          }
          window.dispatchEvent(
            new CustomEvent('routeReordered', {
              detail: { driverId: selectedDriverId, deliveryDate: date, source: 'reoptimizeRoute' },
            })
          );
        }
      } catch (err) {
        console.warn('[RouteActionButtons] Silent reoptimize failed:', err?.message || err);
      } finally {
        resumeOfflineMutations();
        resumeOfflineSync();
        setIsEntityUpdating(false);
        setIsReoptimizing(false);
      }
    };
    window.addEventListener('triggerReoptimizeRoute', handler);
    return () => window.removeEventListener('triggerReoptimizeRoute', handler);
  }, [selectedDriverId, appUsers, selectedDate]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isAppOwner(currentUser) || selectedDriverId === 'all') return null;

  const fabPosition = isMobile ? 'absolute' : 'fixed';

  return (
    <>
      <RouteOptimizationCompareDialog
        open={compareDialogOpen}
        onClose={() => setCompareDialogOpen(false)}
        rows={compareRows}
      />
      <motion.div
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 260, damping: 20 }}
        className="z-[100] flex items-center gap-2"
        style={{
          position: fabPosition,
          bottom: `${
            (deliveriesWithStopOrder.length > 0 && cardsReadyForFAB && !immersiveHidden
              ? stopCardsBaseHeight
              : 0) + 10
          }px`,
          right: '64px',
          display: immersiveHidden ? 'none' : undefined,
        }}
      >
        <Button
          ref={reoptimizeBtnRef}
          onClick={async () => {
            if (isReoptimizing) return;
            cancelAllDeferredOptimizations();
            setIsReoptimizing(true);
            setOptimizationMessage('Re-Optimization in Progress...');
            setIsEntityUpdating(true);
            pauseOfflineMutations();
            pauseOfflineSync();
            await new Promise((resolve) => setTimeout(resolve, 100));

            try {
              const deliveryDate = format(selectedDate, 'yyyy-MM-dd');

              const driverAppUser = appUsers?.find(
                (au) => au.id === selectedDriverId || au.user_id === selectedDriverId
              );
              const currentLocation =
                driverAppUser?.current_latitude != null
                  ? { lat: Number(driverAppUser.current_latitude), lon: Number(driverAppUser.current_longitude) }
                  : null;

              // ── Build BEFORE state for compare dialog ──────────────────────
              const ACTIVE_PENDING = ['in_transit', 'en_route', 'pending'];
              const beforeDeliveries = (filteredDeliveries || []).filter(
                (d) => d && (ACTIVE_PENDING.includes(d.status) || (d.is_cycling_marker && !FINISHED.has(d.status)))
              );
              const beforeMap = new Map(
                beforeDeliveries.map((d) => [d.id, { stopOrder: d.stop_order, eta: d.delivery_time_eta }])
              );

              // Pre-warm ISD/ISP name cache
              await Promise.all(
                beforeDeliveries
                  .filter((d) => d?.delivery_id && isInterStoreDelivery(d.delivery_id))
                  .map((d) => resolveInterStoreFromName(d.delivery_id))
              );

              // Show dialog immediately with loading state
              const beforeRows = beforeDeliveries
                .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0))
                .map((d) => {
                  const _notes = (d.delivery_notes || '').trim().toLowerCase();
                  return {
                    deliveryId: d.id,
                    name: getStopName(d),
                    isCyclingStart: !!d.is_cycling_marker && !_notes.includes('end'),
                    isCyclingEnd:   !!d.is_cycling_marker &&  _notes.includes('end'),
                    oldStopOrder: d.stop_order ?? null,
                    oldEta: d.delivery_time_eta ?? null,
                    newStopOrder: null,
                    newEta: null,
                    orderChanged: false,
                  };
                });
              setCompareRows(beforeRows);
              setCompareDialogOpen(true);

              // ── Run client-side optimization (cycling-aware) ───────────────
              const result = await runClientSideOptimize({
                driverId: selectedDriverId,
                deliveryDate,
                deliveries: filteredDeliveries || [],
                patients,
                stores,
                appUsers,
                currentLocation,
                source: 'manual_fab',
              });

              if (result?.success) {
                const fresh = result.freshDeliveries || [];

                // ── Update compare dialog with AFTER state ─────────────────
                if (fresh.length > 0) {
                  const activeAfter = fresh.filter(
                    (d) => d && (ACTIVE_PENDING.includes(d.status) || (d.is_cycling_marker && !FINISHED.has(d.status)))
                  );
                  const afterRows = activeAfter
                    .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0))
                    .map((d) => {
                      const before = beforeMap.get(d.id) || {};
                      const _notes = (d.delivery_notes || '').trim().toLowerCase();
                      return {
                        deliveryId: d.id,
                        name: getStopName(d),
                        isCyclingStart: !!d.is_cycling_marker && !_notes.includes('end'),
                        isCyclingEnd:   !!d.is_cycling_marker &&  _notes.includes('end'),
                        oldStopOrder: before.stopOrder ?? null,
                        oldEta: before.eta ?? null,
                        newStopOrder: d.stop_order ?? null,
                        newEta: d.delivery_time_eta ?? null,
                        orderChanged: (before.stopOrder ?? null) !== (d.stop_order ?? null),
                      };
                    });
                  setCompareRows(afterRows);
                }

                // ── Push fresh deliveries to offline DB + local UI ─────────
                if (fresh.length > 0) {
                  await offlineDB
                    .replaceRecordsByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', deliveryDate, fresh)
                    .catch(() => {});
                  updateDeliveriesLocally?.(fresh, true);
                }

                base44.analytics.track({
                  eventName: 'route_optimization_run',
                  properties: {
                    source: 'manual_fab',
                    success: true,
                    route_changed: Boolean(result.optimizeData?.routeChanged),
                    optimized_stop_count: Number(
                      result.optimizeData?.optimizedCount ||
                        result.optimizeData?.writeBatch?.length ||
                        fresh.length ||
                        0
                    ),
                  },
                });

                window.dispatchEvent(
                  new CustomEvent('deliveriesUpdated', {
                    detail: {
                      driverId: selectedDriverId,
                      deliveryDate,
                      triggeredBy: 'reoptimizeRoute',
                      alreadyOptimized: true,
                      fullReplacement: true,
                      freshDeliveries: fresh,
                    },
                  })
                );
                window.dispatchEvent(
                  new CustomEvent('routeReordered', {
                    detail: { driverId: selectedDriverId, deliveryDate, source: 'reoptimizeRoute' },
                  })
                );
                window.dispatchEvent(
                  new CustomEvent('polylineUpdated', {
                    detail: { driverId: selectedDriverId, deliveryDate },
                  })
                );
                setIsMapViewLocked(true);
                setMapViewTrigger((prev) => prev + 1);
                setTimeout(() => {
                  setOptimizationMessage(null);
                  setIsMapViewLocked(false);
                }, 3000);
              } else {
                setOptimizationMessage(result?.error || 'Optimization failed');
                setTimeout(() => setOptimizationMessage(null), 5000);
                base44.analytics.track({
                  eventName: 'route_optimization_run',
                  properties: { source: 'manual_fab', success: false },
                });
              }
            } catch (error) {
              base44.analytics.track({
                eventName: 'route_optimization_run',
                properties: { source: 'manual_fab', success: false },
              });
              console.error('❌ [handleReoptimizeRoute] Error:', error);
              setOptimizationMessage(`Error: ${error.message}`);
              setTimeout(() => setOptimizationMessage(null), 5000);
            } finally {
              resumeOfflineMutations();
              resumeOfflineSync();
              setIsEntityUpdating(false);
              await new Promise((resolve) => setTimeout(resolve, 100));
              setIsReoptimizing(false);
            }
          }}
          disabled={
            isReoptimizing ||
            isDateFinished ||
            !(filteredDeliveries || []).some(
              (d) => d && (d.status === 'in_transit' || d.status === 'en_route')
            )
          }
          title="Re-optimize entire route"
          className={`inline-flex items-center justify-center h-10 w-10 rounded-lg shadow-2xl p-0 transition-all duration-200 ${
            isReoptimizing
              ? 'bg-amber-500 hover:bg-amber-600'
              : 'bg-emerald-600 hover:bg-emerald-700'
          }`}
          style={{ pointerEvents: 'auto', touchAction: 'manipulation' }}
        >
          {isReoptimizing ? (
            <div className="animate-spin w-5 h-5 border-2 border-white border-t-transparent rounded-full" />
          ) : (
            <Navigation className="w-5 h-5 text-white" />
          )}
        </Button>
      </motion.div>
    </>
  );
}