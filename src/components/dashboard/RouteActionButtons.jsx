import React, { useState } from "react";
import { useOptimizationEngineMode } from '@/components/utils/serverOptimizationMode';
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

const FINISHED = new Set(['completed', 'failed', 'cancelled']);


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
    // OWNER RULE (Oct 29 2026, corrected): the MANUAL optimize FAB redraws the
    // polylines ONLY when the optimization actually changed the route (at least
    // one stop_order moved). No change -> no redraw, the existing legs stand.
    // The Quick Route Adjustments panel's re-optimize button is the one that
    // ALWAYS regenerates every active leg (forceRegenerate:true, unchanged).
    forceRegenerate: false,
    // Future-date routes: pending stops also get planned polylines so the FAB
    // shows the full path for tomorrow's route (not just in_transit stops).
    includePendingPolylines: true,
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
  hideForExpandedCard = false,
}) {
  const optimizationEngineMode = useOptimizationEngineMode(currentUser);
  const [compareDialogOpen, setCompareDialogOpen] = useState(false);
  const [compareRows, setCompareRows] = useState([]);
  const [cyclingLocations, setCyclingLocations] = useState([]);
  const reoptimizeBtnRef = useRef(null);
  // ── Server-engine fallback balloon (owner request Oct 20 2026) ──────────────
  // When the armed server-side optimizer fails and the coordinator falls back
  // to the client engine, a small balloon pops ABOVE this manual optimization
  // FAB so the owner sees WHY the route was still optimized (and that the
  // result came from the client engine). Auto-hides after 8s; tap to dismiss.
  const [fallbackBalloon, setFallbackBalloon] = useState(null);
  const fallbackBalloonTimerRef = useRef(null);
  useEffect(() => {
    const onFallback = (e) => {
      const d = e?.detail || {};
      const rawReason = String(d.reason || 'unknown');
      // INTENTIONAL SKIP (owner report Oct 24 2026): future-date routes are
      // CLIENT-OWNED BY DESIGN — the server engine deliberately doesn't
      // implement the future fast path (chronological window sort + planned
      // home polylines; Oct 20 parity gate). This handoff is not a failure,
      // so no "unavailable" balloon for it. Real failures (invoke_error,
      // server_invoke_timeout, server_engine_backoff, bad response…) still show.
      if (rawReason === 'future_route_client_fastpath') return;
      let shortReason = rawReason;
      if (rawReason === 'server_engine_backoff') shortReason = 'paused after repeated failures';
      else if (rawReason === 'here_api_key_missing') shortReason = 'missing HERE key';
      else if (rawReason.startsWith('invoke_error:')) shortReason = 'unreachable';
      else if (rawReason === 'server_bad_response') shortReason = 'bad response';
      else if (rawReason === 'not_authorized_for_server_optimization') shortReason = 'not authorized';
      else if (rawReason.startsWith('server_error:')) shortReason = rawReason.replace('server_error: ', '').slice(0, 60);
      setFallbackBalloon({ reason: shortReason, source: d.source || 'route', at: d.at || Date.now() });
      if (fallbackBalloonTimerRef.current) clearTimeout(fallbackBalloonTimerRef.current);
      fallbackBalloonTimerRef.current = setTimeout(() => setFallbackBalloon(null), 8000);
    };
    window.addEventListener('optimizationEngineFallback', onFallback);
    return () => {
      window.removeEventListener('optimizationEngineFallback', onFallback);
      if (fallbackBalloonTimerRef.current) clearTimeout(fallbackBalloonTimerRef.current);
    };
  }, []);

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
      // Care Pro delivery: show "CP <cp_name>" (matches StopCard + map balloon formatting)
      if (patient && (patient.care_pros || delivery.care_pros) && (patient.cp_name || delivery.cp_name)) {
        return `CP ${patient.cp_name || delivery.cp_name}`;
      }
      if (patient?.full_name) return patient.full_name;
    }
    if (delivery.store_id) {
      const store = (stores || []).find((s) => s?.id === delivery.store_id);
      if (store?.name) return `📦 ${store.name}`;
    }
    return delivery.patient_name || delivery.delivery_id || 'Unknown';
  };

  // Returns { abbrev, color } for a delivery's store, or null if not a patient delivery
  const getStoreInfo = (delivery) => {
    if (!delivery?.store_id || delivery?.is_cycling_marker) return null;
    const store = (stores || []).find((s) => s?.id === delivery.store_id);
    if (!store?.abbreviation) return null;
    return { abbrev: store.abbreviation, color: store.color || '#64748b' };
  };

  // ── Silent reoptimize triggered programmatically (e.g. after new delivery added) ──
  useEffect(() => {
    const handler = async (e) => {
      const { driverId, deliveryDate } = e.detail || {};
      if (driverId !== selectedDriverId) return;
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (isReoptimizing) return;
      const date = deliveryDate || format(selectedDate, 'yyyy-MM-dd');
      try {
        setIsReoptimizing(true);
        setIsEntityUpdating(true);
        pauseOfflineMutations();
        pauseOfflineSync();
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
            await Promise.all(fresh.map(d => offlineDB.save(offlineDB.STORES.DELIVERIES, d).catch(() => {})));
            updateDeliveriesLocally?.(fresh, false);
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
          // Hey Doc voice command listens for this to speak the result back.
          window.dispatchEvent(new CustomEvent('triggerReoptimizeRouteDone', {
            detail: { driverId: selectedDriverId, deliveryDate: date, success: true },
          }));
        }
      } catch (err) {
          window.dispatchEvent(new CustomEvent('triggerReoptimizeRouteDone', {
            detail: { driverId: selectedDriverId, deliveryDate: date, success: false, error: 'Optimization failed' },
          }));
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

  const fabPosition = 'absolute';

  return (
    <>
      <RouteOptimizationCompareDialog
        open={compareDialogOpen}
        onClose={() => setCompareDialogOpen(false)}
        rows={compareRows}
      />
      {fallbackBalloon && (
        <motion.div
          initial={{ opacity: 0, y: 8, scale: 0.95 }}
          animate={{ opacity: hideForExpandedCard ? 0 : 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 4, scale: 0.95 }}
          transition={{ type: 'spring', stiffness: 300, damping: 24 }}
          onClick={() => setFallbackBalloon(null)}
          className="z-[105] max-w-[240px] cursor-pointer rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 shadow-lg"
          style={{
            position: 'absolute',
            bottom: `${
              (deliveriesWithStopOrder.length > 0 && cardsReadyForFAB && !immersiveHidden
                ? stopCardsBaseHeight
                : 0) + 64
            }px`,
            right: '60px',
            display: immersiveHidden ? 'none' : undefined,
            pointerEvents: hideForExpandedCard ? 'none' : 'auto',
          }}
        >
          <div className="text-[11px] font-semibold text-blue-800">Server optimizer unavailable</div>
          <div className="text-[11px] text-blue-700">Fell back to client engine ({fallbackBalloon.reason})</div>
        </motion.div>
      )}
      <motion.div
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: hideForExpandedCard ? 0 : 1 }}
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
          pointerEvents: hideForExpandedCard ? 'none' : 'auto',
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
                    storeAbbrev: getStoreInfo(d)?.abbrev ?? null,
                    storeColor: getStoreInfo(d)?.color ?? null,
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
                        storeAbbrev: getStoreInfo(d)?.abbrev ?? null,
                        storeColor: getStoreInfo(d)?.color ?? null,
                      };
                    });
                  setCompareRows(afterRows);
                }

                // ── Push fresh deliveries to offline DB + local UI ─────────
                if (fresh.length > 0) {
                  await Promise.all(fresh.map(d => offlineDB.save(offlineDB.STORES.DELIVERIES, d).catch(() => {})));
                  updateDeliveriesLocally?.(fresh, false);
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
          className={`relative inline-flex items-center justify-center h-10 w-10 rounded-lg shadow-2xl p-0 transition-all duration-200 ${
            isReoptimizing
              ? 'bg-amber-500 hover:bg-amber-600'
              : optimizationEngineMode === 'server'
                ? 'bg-blue-600 hover:bg-blue-700'
                : 'bg-emerald-600 hover:bg-emerald-700'
          }`}
          style={{ pointerEvents: 'auto', touchAction: 'manipulation' }}
        >
          {isReoptimizing ? (
            <div className="animate-spin w-5 h-5 border-2 border-white border-t-transparent rounded-full" />
          ) : (
            <Navigation className="w-5 h-5 text-white" />
          )}
          {/* S/C engine badge — same corner as the map cycle FAB's 1/2/3 */}
          <span className="absolute top-1 left-1 font-bold text-[10px] text-white pointer-events-none">
            {optimizationEngineMode === 'server' ? 'S' : 'C'}
          </span>
        </Button>
      </motion.div>
    </>
  );
}