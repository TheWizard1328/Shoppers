import React, { useMemo, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";

import { offlineDB } from "@/components/utils/offlineDatabase";
import { smartRefreshManager } from "@/components/utils/smartRefreshManager";
import { loadBreadcrumbsForDriver } from "@/components/utils/breadcrumbsManager";
import { Loader2, RotateCcw } from "lucide-react";

export default function ResetPolylinesButton({
  selectedDriverIds = [],
  selectedDate,
  selectedPolylineOption = 'polylines',
  mode = "inline",
  disabled = false,
  className = "",
  forceDrivingMode = false,  // When true, all polylines are generated as driving regardless of stop transport_mode
  appUsers = [],             // Needed for loadBreadcrumbsForDriver after resegment
  onBreadcrumbsReloaded,     // Callback(driverId, breadcrumbsData) after resegment completes
}) {
  const [isResetting, setIsResetting] = useState(false);

  const driverIds = useMemo(() => {
    return Array.from(new Set((selectedDriverIds || []).filter(Boolean).filter((id) => id !== "all")));
  }, [selectedDriverIds]);

  const clearPolylineCache = async () => {
    try {
      Object.keys(localStorage).forEach((key) => {
        if (key.startsWith("here_")) {
          localStorage.removeItem(key);
        }
      });
    } catch (_) {}
  };

  const syncDriverDateDeliveriesFromBackend = async (successfulDriverIds) => {
    const deliveryGroups = [];
    for (const driverId of successfulDriverIds) {
      try {
        const results = await base44.entities.Delivery.filter(
          { driver_id: driverId, delivery_date: selectedDate },
          undefined,
          5000
        );
        deliveryGroups.push(results);
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (err) {
        console.warn(`Failed to sync deliveries for driver ${driverId}:`, err);
      }
    }

    const refreshedDeliveries = deliveryGroups.flat().filter(Boolean);
    if (refreshedDeliveries.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, refreshedDeliveries);
    }

    return refreshedDeliveries;
  };

  const handleReset = async () => {
    if (isResetting || disabled || driverIds.length === 0 || !selectedDate) return;

    setIsResetting(true);
    smartRefreshManager.pause();
    window.dispatchEvent(new CustomEvent('polylineGenerationStarted', { detail: { isRegenerate: true } }));
    const breadcrumbIntegrationResults = [];

    try {
      // Regenerate polylines (per driver) sequentially
      for (const driverId of driverIds) {
        try {
          let result;

          if (selectedPolylineOption === 'breadcrumbs') {
            // ── Step 1: Sync online → offline DB ──────────────────────────────
            // Always pull fresh records from the server so we have the latest
            // master timeline (stop_order = -1) and any already-sliced segments.
            const onlineBreadcrumbs = await base44.entities.DeliveryBreadcrumbs.filter({
              driver_id: driverId,
              delivery_date: selectedDate,
            });
            if (Array.isArray(onlineBreadcrumbs) && onlineBreadcrumbs.length > 0) {
              await offlineDB.bulkSave(offlineDB.STORES.DELIVERY_BREADCRUMBS, onlineBreadcrumbs);
            }

            // ── Step 2: Resegment all stops (always overwrites existing records) ──
            const response = await base44.functions.invoke('consolidateBreadcrumbs', {
              driver_id: driverId,
              delivery_date: selectedDate,
              // No stop_order → slice ALL terminal stops
            });
            result = response?.data || response || {};
            if (!result.success && !result.skipped) {
              throw new Error(result.error || 'Breadcrumb resegmentation failed');
            }

            // ── Step 3: Sync updated per-stop records back to offline DB ──────
            const freshSegments = await base44.entities.DeliveryBreadcrumbs.filter({
              driver_id: driverId,
              delivery_date: selectedDate,
            });
            if (Array.isArray(freshSegments) && freshSegments.length > 0) {
              await offlineDB.bulkSave(offlineDB.STORES.DELIVERY_BREADCRUMBS, freshSegments);
            }

            // ── Step 4: Reload breadcrumbs into map state ─────────────────────
            try {
              const reloaded = await loadBreadcrumbsForDriver(driverId, selectedDate, appUsers);
              onBreadcrumbsReloaded?.(driverId, reloaded);
            } catch (_) {}

            const stopsSliced = Number(result?.stops_sliced || 0);
            const stopsSkipped = Number(result?.stops_skipped || 0);
            breadcrumbIntegrationResults.push({
              driverId,
              stopsSliced,
              stopsSkipped,
              skipped: !!result.skipped,
              skipReason: result.reason || null,
            });
          } else {
            const routeDeliveries = await base44.entities.Delivery.filter(
              { driver_id: driverId, delivery_date: selectedDate },
              'stop_order',
              5000
            );

            const FINISHED_STATUSES = new Set(['completed', 'failed', 'cancelled', 'returned']);
            const getCompletionTime = (d) => {
              const t = d?.actual_delivery_time || d?.arrival_time || d?.updated_date;
              if (t) { const ms = new Date(t).getTime(); if (Number.isFinite(ms)) return ms; }
              return Number.MAX_SAFE_INTEGER;
            };

            const orderedDeliveries = (routeDeliveries || [])
              .filter(Boolean)
              .sort((a, b) => {
                const aFinished = FINISHED_STATUSES.has(a?.status);
                const bFinished = FINISHED_STATUSES.has(b?.status);
                // Finished stops first, sorted by completion time
                if (aFinished && bFinished) return getCompletionTime(a) - getCompletionTime(b);
                if (aFinished && !bFinished) return -1;
                if (!aFinished && bFinished) return 1;
                // Non-finished stops sorted by stop_order
                return (Number(a?.stop_order) || 0) - (Number(b?.stop_order) || 0);
              });

            // Resequence stop_order numbers based on the new sort order
            const resequenceUpdates = orderedDeliveries
              .map((delivery, index) => ({ id: delivery.id, newStopOrder: index + 1 }))
              .filter(({ id, newStopOrder }) => {
                const current = Number(orderedDeliveries.find(d => d.id === id)?.stop_order) || 0;
                return current !== newStopOrder;
              });

            if (resequenceUpdates.length > 0) {
              await Promise.all(
                resequenceUpdates.map(({ id, newStopOrder }) =>
                  base44.entities.Delivery.update(id, { stop_order: newStopOrder })
                )
              );
              // Apply new stop_order values locally before building ordered IDs
              resequenceUpdates.forEach(({ id, newStopOrder }) => {
                const delivery = orderedDeliveries.find(d => d.id === id);
                if (delivery) delivery.stop_order = newStopOrder;
              });
              console.log(`[ResetPolylinesButton] Resequenced ${resequenceUpdates.length} stop_order values for driver ${driverId}`);
            }

            const orderedStopIds = orderedDeliveries
              .map((delivery) => delivery.id)
              .filter(Boolean);

            const orderedStopsWithTransportMode = orderedDeliveries.map((delivery) => ({
              deliveryId: delivery.id,
              stopOrder: Number(delivery?.stop_order) || 0,
              finished_leg_transport_mode: delivery?.finished_leg_transport_mode || null
            }));

            console.log('[ResetPolylinesButton] BEFORE purgeAndRegeneratePolylines', {
              driverId,
              selectedDate,
              stopOrders: orderedDeliveries.map((delivery) => ({
                id: delivery.id,
                stop_order: Number(delivery?.stop_order) || 0,
                status: delivery?.status || null
              })),
              routeStopOrder: orderedStopIds
            });

            const firstStop = orderedDeliveries[0] || null;
            const lastStop = orderedDeliveries[orderedDeliveries.length - 1] || null;

            if (!firstStop || !lastStop) {
              throw new Error('No route stops found for this driver and date');
            }

            // Pre-clear existing polylines so bulkUpdateDeliveries change-detection doesn't skip identical values
            // await Promise.all(
            //   orderedDeliveries.map((delivery) =>
            //     base44.entities.Delivery.update(delivery.id, {
            //       encoded_polyline: null,
            //       finished_leg_encoded_polyline: null,
            //       estimated_distance_km: null,
            //       estimated_duration_minutes: null
            //     })
            //   )
            // );

            // Fetch driver's home coords to force home as the absolute route origin
            let homePosition = null;
            try {
              const driverAppUsers = await base44.entities.AppUser.filter({ user_id: driverId }, '-updated_date', 1);
              const driverAppUser = driverAppUsers?.[0];
              const homeLat = Number(driverAppUser?.home_latitude);
              const homeLon = Number(driverAppUser?.home_longitude);
              if (Number.isFinite(homeLat) && Number.isFinite(homeLon) && homeLat !== 0 && homeLon !== 0) {
                homePosition = { lat: homeLat, lon: homeLon };
              }
            } catch (err) {
              console.warn(`[ResetPolylinesButton] Could not fetch driver home coords for ${driverId}:`, err);
            }

            const response = await base44.functions.invoke('purgeAndRegeneratePolylines', {
              driverId,
              deliveryDate: selectedDate,
              orderedDeliveryIds: orderedStopIds,
              currentPosition: homePosition,
              forceHomeOrigin: true,        // Always use driver home as absolute route origin for FAB regeneration
              bypassPolylineUpdated: true,  // Force-regen: pre-nulls polyline fields in-memory so
                                            // bulkUpdateDeliveries change-detection never skips stops
                                            // that already have PolylineUpdated=true or a matching polyline value
              bypassDriverStatus: true,     // FAB is a manual admin action — must run regardless of driver's
                                            // current shift status (off_duty, unavailable, etc.)
              ...(forceDrivingMode ? { forceTransportMode: 'driving' } : {})
            });
            result = response?.data || response || {};
            if (!result.success) {
              throw new Error(result.error || 'Polyline regeneration failed');
            }
          }

          const deliveriesAfterPurge = await base44.entities.Delivery.filter(
            { driver_id: driverId, delivery_date: selectedDate },
            'stop_order',
            5000
          );

          const polylineUpdatedFalseIds = (deliveriesAfterPurge || [])
            .filter((delivery) => delivery?.id && delivery?.PolylineUpdated === false)
            .map((delivery) => delivery.id);

          if (polylineUpdatedFalseIds.length > 0) {
            await Promise.all(
              polylineUpdatedFalseIds.map((id) =>
                base44.entities.Delivery.update(id, { PolylineUpdated: true })
              )
            );
            deliveriesAfterPurge.forEach((delivery) => {
              if (polylineUpdatedFalseIds.includes(delivery?.id)) {
                delivery.PolylineUpdated = true;
              }
            });
          }
          const orderedDeliveriesAfterPurge = (deliveriesAfterPurge || [])
            .filter(Boolean)
            .sort((a, b) => (Number(a?.stop_order) || 0) - (Number(b?.stop_order) || 0));

          console.log('[ResetPolylinesButton] AFTER purgeAndRegeneratePolylines', {
            driverId,
            selectedDate,
            stopOrders: orderedDeliveriesAfterPurge.map((delivery) => ({
              id: delivery.id,
              stop_order: Number(delivery?.stop_order) || 0,
              status: delivery?.status || null
            }))
          });

          const freshDeliveries = await syncDriverDateDeliveriesFromBackend([driverId]);

          // CRITICAL: Dispatch with the fresh deliveries inline so the UI updates immediately.
          // The realtimeSync guard skips WS-triggered dispatches when all events look "local"
          // (backend writes under the same user), so we must push the UI update explicitly here.
          window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
            detail: {
              driverId,
              deliveryDate: selectedDate,
              triggeredBy: 'resetPolylines_chunk',
              freshDeliveries: freshDeliveries.length > 0 ? freshDeliveries : undefined,
              deliveries: freshDeliveries.length > 0 ? freshDeliveries : undefined,
              fullReplacement: false,
              immediate: true,
              preserveLocalState: false,
            }
          }));

          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (err) {
          console.warn(`Failed to regenerate polylines for driver ${driverId}:`, err);
        }
      }

      if (selectedPolylineOption === 'breadcrumbs') {
        const totalStopsSliced = breadcrumbIntegrationResults.reduce((sum, item) => sum + item.stopsSliced, 0);
        const totalStopsSkipped = breadcrumbIntegrationResults.reduce((sum, item) => sum + item.stopsSkipped, 0);
        const allSkipped = breadcrumbIntegrationResults.every((item) => item.skipped);

        toast({
          title: allSkipped ? 'No master timeline found' : 'Breadcrumb resegmentation complete',
          description: allSkipped
            ? 'No master GPS timeline record exists for this driver/date.'
            : `${totalStopsSliced} stop${totalStopsSliced === 1 ? '' : 's'} resegmented • ${totalStopsSkipped} skipped`
        });
      }
    } finally {
      smartRefreshManager.restart();
      setIsResetting(false);
      window.dispatchEvent(new CustomEvent('routeOptimizationComplete', { detail: { source: 'reset_polylines' } }));
    }
  };

  if (mode === "fab") {
    return (
      <Button
        onClick={handleReset}
        disabled={disabled || isResetting || driverIds.length === 0}
        title="Reset and update all polylines"
        className={`inline-flex items-center justify-center h-10 w-10 rounded-lg shadow-2xl p-0 transition-all duration-200 bg-slate-700 hover:bg-slate-800 ${className}`}
        style={{ pointerEvents: "auto", touchAction: "manipulation" }}
      >
        {isResetting ? <Loader2 className="w-5 h-5 text-white animate-spin" /> : <RotateCcw className="w-5 h-5 text-white" />}
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={handleReset}
      disabled={disabled || isResetting || driverIds.length === 0}
      className={`h-8 gap-2 ${className}`}
      style={{ background: "var(--bg-white)", borderColor: "var(--border-slate-300)", color: "var(--text-slate-900)" }}
      title="Refresh polylines"
    >
      {isResetting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
    </Button>
  );
}