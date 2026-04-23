import React, { useMemo, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";

import { offlineDB } from "@/components/utils/offlineDatabase";
import { smartRefreshManager } from "@/components/utils/smartRefreshManager";
import { normalizeTravelMode } from "@/components/dashboard/travelModeHelpers";
import { recalculateAndUpdateStopOrders } from "@/components/utils/stopOrderManager";
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
      await offlineDB.clearStore(offlineDB.STORES.DRIVER_ROUTE_POLYLINES);
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

  const syncDriverRoutePolylinesFromBackend = async (successfulDriverIds) => {
    const polylineGroups = [];
    for (const driverId of successfulDriverIds) {
      try {
        const results = await base44.entities.DriverRoutePolyline.filter(
          { driver_id: driverId, delivery_date: selectedDate },
          '-updated_date',
          5000
        );
        polylineGroups.push(results || []);
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (err) {
        console.warn(`Failed to sync polylines for driver ${driverId}:`, err);
      }
    }

    const refreshedPolylines = polylineGroups.flat().filter(Boolean);
    if (successfulDriverIds.length > 0) {
      const existingRows = await offlineDB.getByIndex(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, 'delivery_date', selectedDate);
      const rowsToDelete = (existingRows || []).filter((row) => successfulDriverIds.includes(row?.driver_id));
      await Promise.all(rowsToDelete.map((row) => offlineDB.deleteRecord(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, row.id).catch(() => null)));
    }
    if (refreshedPolylines.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, refreshedPolylines);
      await offlineDB.deduplicateDriverRoutePolylines(selectedDate);
      window.dispatchEvent(new CustomEvent('driverRoutePolylinesUpdated', {
        detail: { polylines: refreshedPolylines, triggeredBy: 'resetPolylines_sync' }
      }));
      refreshedPolylines.forEach((row) => {
        const key = `here_${normalizeTravelMode(row.transport_mode || 'driving')}_${Number(row.segment_origin_lat).toFixed(5)}_${Number(row.segment_origin_lon).toFixed(5)}_${Number(row.segment_dest_lat).toFixed(5)}_${Number(row.segment_dest_lon).toFixed(5)}`;
        window.dispatchEvent(new CustomEvent('polylineUpdated', {
          detail: { key, driverId: row.driver_id, deliveryDate: row.delivery_date, triggeredBy: 'resetPolylines_sync' }
        }));
      });
    }

    return refreshedPolylines;
  };

  const handleReset = async () => {
    if (isResetting || disabled || driverIds.length === 0 || !selectedDate) return;

    setIsResetting(true);
    smartRefreshManager.pause();
    const breadcrumbIntegrationResults = [];

    try {
      // 1. Resort the stops (per driver) via completed times and update stop orders
      // Process sequentially to avoid rate limits and ensure DBs are updated before polylines
      for (const driverId of driverIds) {
        await recalculateAndUpdateStopOrders(driverId, selectedDate, true);
        window.dispatchEvent(new CustomEvent("deliveriesUpdated", {
          detail: { driverId, deliveryDate: selectedDate, triggeredBy: "resetPolylines_stopOrders" }
        }));
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      // 2. Clear cached polylines only when regenerating polylines
      if (selectedPolylineOption === 'polylines') {
        await clearPolylineCache();
        window.dispatchEvent(new CustomEvent("polylineCacheCleared", {
          detail: { driverIds, deliveryDate: selectedDate, triggeredBy: "resetPolylines" }
        }));
      }

      // 3. Update the polylines/breadcrumbs (per driver) sequentially
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
            const response = await base44.functions.invoke('purgeAndRegeneratePolylines', {
              driverId,
              deliveryDate: selectedDate,
              scope: 'all',
              reason: 'manual',
              routeSource: selectedPolylineOption,
              ignoreDriverStatus: true
            });
            result = response?.data || response || {};
            if (!result.success) {
              throw new Error(result.error || 'Polyline regeneration failed');
            }
          }

          await syncDriverDateDeliveriesFromBackend([driverId]);
          if (selectedPolylineOption === 'polylines') {
            await syncDriverRoutePolylinesFromBackend([driverId]);
          }

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