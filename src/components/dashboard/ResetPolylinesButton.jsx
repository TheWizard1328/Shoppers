import React, { useMemo, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";

import { offlineDB } from "@/components/utils/offlineDatabase";
import { updateDeliveryLocal } from "@/components/utils/offlineMutations";
import { smartRefreshManager } from "@/components/utils/smartRefreshManager";
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
        // Update UI after stop orders have been updated
        window.dispatchEvent(new CustomEvent("deliveriesUpdated", {
          detail: { driverId, deliveryDate: selectedDate, triggeredBy: "resetPolylines_stopOrders" }
        }));
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      // 2. Clear cached polylines from both local cache and offline DB
      await clearPolylineCache();
      window.dispatchEvent(new CustomEvent("polylineCacheCleared", {
        detail: { driverIds, deliveryDate: selectedDate, triggeredBy: "resetPolylines" }
      }));

      // 3. Update the polylines (per driver) sequentially
      for (const driverId of driverIds) {
        try {
          const response = await base44.functions.invoke('purgeAndRegeneratePolylines', {
            driverId,
            deliveryDate: selectedDate,
            scope: 'all',
            reason: selectedPolylineOption === 'polylines' ? 'manual' : 'manual_breadcrumbs',
            routeSource: selectedPolylineOption
          });
          const result = response?.data || response || {};
          if (!result.success) {
            throw new Error(result.error || 'Polyline regeneration failed');
          }

          if (selectedPolylineOption === 'breadcrumbs') {
            const mergedRows = Number(result?.pendingBreadcrumbLiveMerge?.sourceRows || 0);
            const integratedStops = Number(result?.pendingBreadcrumbLiveMerge?.updatedDeliveryIds?.length || 0);
            breadcrumbIntegrationResults.push({ driverId, mergedRows, integratedStops });
          }

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
        const totalDrivers = breadcrumbIntegrationResults.length;
        const successfulDrivers = breadcrumbIntegrationResults.filter((item) => item.integratedStops > 0).length;
        const mergedRows = breadcrumbIntegrationResults.reduce((sum, item) => sum + item.mergedRows, 0);
        const integratedStops = breadcrumbIntegrationResults.reduce((sum, item) => sum + item.integratedStops, 0);
        const successRate = totalDrivers > 0 ? Math.round(successfulDrivers / totalDrivers * 100) : 0;

        toast({
          title: 'Breadcrumb consolidation complete',
          description: `${successRate}% matched • ${integratedStops} stop${integratedStops === 1 ? '' : 's'} aligned by timestamp • ${mergedRows} breadcrumb row${mergedRows === 1 ? '' : 's'} merged`
        });
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
    >
      {isResetting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
      {/** {isResetting ? "Updating..." : "Reset"} **/}
    </Button>
  );
}