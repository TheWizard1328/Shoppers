import React, { useMemo, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";

import { offlineDB } from "@/components/utils/offlineDatabase";
import { smartRefreshManager } from "@/components/utils/smartRefreshManager";
import { Loader2, RotateCcw } from "lucide-react";

export default function ResetPolylinesButton({
  selectedDriverIds = [],
  selectedDate,
  selectedPolylineOption = 'polylines',
  mode = "inline",
  disabled = false,
  className = "",
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
    const breadcrumbIntegrationResults = [];

    try {
      // Regenerate polylines (per driver) sequentially
      for (const driverId of driverIds) {
        try {
          let result;

          if (selectedPolylineOption === 'breadcrumbs') {
            const response = await base44.functions.invoke('processOrphanedBreadcrumbs', {
              driverId,
              deliveryDate: selectedDate
            });
            result = response?.data || response || {};
            if (!result.success) {
              throw new Error(result.error || 'Breadcrumb reconciliation failed');
            }

            const mergedRows = Number(result?.sourceRows || 0);
            const integratedStops = Number(result?.updatedDeliveryIds?.length || 0);
            breadcrumbIntegrationResults.push({
              driverId,
              mergedRows,
              integratedStops,
              pendingBreadcrumbIds: Array.isArray(result?.pendingBreadcrumbIds) ? result.pendingBreadcrumbIds : []
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
              currentPosition: homePosition  // Force driver's home as absolute route origin
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

          await syncDriverDateDeliveriesFromBackend([driverId]);

          window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
            detail: { driverId, deliveryDate: selectedDate, triggeredBy: 'resetPolylines_chunk' }
          }));

          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (err) {
          console.warn(`Failed to regenerate polylines for driver ${driverId}:`, err);
        }
      }

      if (selectedPolylineOption === 'breadcrumbs') {
        const totalDrivers = driverIds.length;
        const successfulDrivers = breadcrumbIntegrationResults.filter((item) => item.integratedStops > 0).length;
        const mergedRows = breadcrumbIntegrationResults.reduce((sum, item) => sum + item.mergedRows, 0);
        const integratedStops = breadcrumbIntegrationResults.reduce((sum, item) => sum + item.integratedStops, 0);
        const successRate = totalDrivers > 0 ? Math.round(successfulDrivers / totalDrivers * 100) : 0;
        const pendingBreadcrumbIds = breadcrumbIntegrationResults.flatMap((item) => item.pendingBreadcrumbIds || []);

        toast({
          title: 'Breadcrumb consolidation complete',
          description: `${successRate}% matched • ${integratedStops} stop${integratedStops === 1 ? '' : 's'} aligned by timestamp • ${mergedRows} breadcrumb row${mergedRows === 1 ? '' : 's'} merged`
        });

        if (pendingBreadcrumbIds.length > 0) {
          const shouldDelete = window.confirm(`Delete ${pendingBreadcrumbIds.length} reconciled breadcrumb row${pendingBreadcrumbIds.length === 1 ? '' : 's'} from live pending storage?`);
          if (shouldDelete) {
            await base44.functions.invoke('deletePendingBreadcrumbs', { pendingBreadcrumbIds });
            toast({
              title: 'Pending breadcrumbs deleted',
              description: `${pendingBreadcrumbIds.length} reconciled row${pendingBreadcrumbIds.length === 1 ? '' : 's'} removed.`
            });
          }
        }
      }
    } finally {
      smartRefreshManager.restart();
      setIsResetting(false);
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