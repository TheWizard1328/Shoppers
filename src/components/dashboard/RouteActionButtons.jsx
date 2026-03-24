import React from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Navigation } from "lucide-react";
import { format } from "date-fns";
import { base44 } from "@/api/base44Client";
import { isAppOwner } from "@/components/utils/userRoles";
import { pauseOfflineMutations, resumeOfflineMutations } from "@/components/utils/offlineMutations";
import { pauseOfflineSync, resumeOfflineSync } from "@/components/utils/offlineSync";
import { isMobileDevice } from "@/components/utils/deviceUtils";

export default function RouteActionButtons({
  currentUser,
  selectedDriverId,
  selectedDate,
  deliveriesWithStopOrder,
  filteredDeliveries,
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
}) {
  if (!isAppOwner(currentUser) || selectedDriverId === "all") {
    return null;
  }

  const fabPosition = isMobileDevice() ? "absolute" : "fixed";

  return (
    <motion.div
      initial={{ scale: 0, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      exit={{ scale: 0, opacity: 0 }}
      transition={{ type: "spring", stiffness: 260, damping: 20 }}
      className="z-[100] flex items-center gap-2"
      style={{
        position: fabPosition,
        bottom: `${(deliveriesWithStopOrder.length > 0 && cardsReadyForFAB ? stopCardsBaseHeight : 0) + 10}px`,
        right: "64px"
      }}
    >
      <Button
        onClick={async () => {
          if (isReoptimizing) return;
          setIsReoptimizing(true);
          setOptimizationMessage("Re-optimizing route...");
          setIsEntityUpdating(true);
          pauseOfflineMutations();
          pauseOfflineSync();
          await new Promise((resolve) => setTimeout(resolve, 100));
          try {
            const deliveryDate = format(selectedDate, "yyyy-MM-dd");
            const now = new Date();
            const currentLocalTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
            const response = await base44.functions.invoke("optimizeRouteRealTime", {
              driverId: selectedDriverId,
              deliveryDate,
              currentLocalTime,
              deviceTime: now.toISOString()
            });
            const data = response?.data || response;
            if (data?.success) {
              base44.analytics.track({
                eventName: "route_optimization_run",
                properties: {
                  source: "manual_fab",
                  success: true,
                  route_changed: Boolean(data.routeChanged),
                  optimized_stop_count: Number(data.optimizedCount || data.totalStops || data.optimizedRoute?.length || 0)
                }
              });
              await refreshData();
              setOptimizationMessage(`Route optimized! ${(data.optimizedCount || data.totalStops || data.optimizedRoute?.length || 0)} stops updated.`);
              window.dispatchEvent(new CustomEvent("deliveriesUpdated", { detail: { driverId: selectedDriverId, deliveryDate, triggeredBy: "reoptimizeRoute", alreadyOptimized: true } }));
              window.dispatchEvent(new CustomEvent("routeReordered", { detail: { driverId: selectedDriverId, deliveryDate, source: "reoptimizeRoute" } }));
              setIsMapViewLocked(true);
              setMapViewTrigger((prev) => prev + 1);
              setTimeout(() => { setOptimizationMessage(null); setIsMapViewLocked(false); }, 3000);
            } else {
              setOptimizationMessage(data?.error || "Optimization failed");
              setTimeout(() => setOptimizationMessage(null), 5000);
            }
          } catch (error) {
            base44.analytics.track({
              eventName: "route_optimization_run",
              properties: {
                source: "manual_fab",
                success: false
              }
            });
            console.error("❌ [handleReoptimizeRoute] Error:", error);
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
        disabled={isReoptimizing || isDateFinished || !filteredDeliveries.some((delivery) => delivery && delivery.status === "in_transit")}
        title="Re-optimize entire route using Google Maps"
        className={`inline-flex items-center justify-center h-10 w-10 rounded-lg shadow-2xl p-0 transition-all duration-200 ${
          isReoptimizing ? "bg-amber-500 hover:bg-amber-600" : "bg-emerald-600 hover:bg-emerald-700"
        }`}
        style={{ pointerEvents: "auto", touchAction: "manipulation" }}
      >
        {isReoptimizing ? <div className="animate-spin w-5 h-5 border-2 border-white border-t-transparent rounded-full" /> : <Navigation className="w-5 h-5 text-white" />}
      </Button>
    </motion.div>
  );
}