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

import { getOrFetchHereApiKey } from "@/components/utils/hereApiKeyStore";
import { invokeOptimizeAwareCycling } from "@/components/utils/cyclingAwareOptimizer";
import { isInterStoreDelivery, getInterStoreLocationSync, resolveInterStoreFromName, extractFromPhoneFromDeliveryId } from "@/components/utils/interStoreDisplayName";
import { offlineDB } from "@/components/utils/offlineDatabase";
import { invalidate } from "@/components/utils/dataManager";

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
  const reoptimizeBtnRef = useRef(null);

  // Allow other parts of the app to trigger the FAB programmatically (silent — no compare dialog)
  useEffect(() => {
    const handler = async (e) => {
      const { driverId, deliveryDate } = e.detail || {};
      if (driverId !== selectedDriverId) return;
      // Small delay to let the new delivery appear in filteredDeliveries
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (isReoptimizing) return;
      try {
        setIsReoptimizing(true);
        setIsEntityUpdating(true);
        pauseOfflineMutations();
        pauseOfflineSync();
        const date = deliveryDate || format(selectedDate, 'yyyy-MM-dd');
        const now = new Date();
        const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const hereApiKey = await getOrFetchHereApiKey();
        const driverAppUser = appUsers?.find(au => au.id === selectedDriverId || au.user_id === selectedDriverId);
        const currentLocation = driverAppUser?.current_latitude != null
          ? { lat: Number(driverAppUser.current_latitude), lon: Number(driverAppUser.current_longitude) }
          : null;
        const data = await invokeOptimizeAwareCycling({
          driverId: selectedDriverId,
          deliveryDate: date,
          currentLocalTime,
          deviceTime: now.toISOString(),
          hereApiKey,
          currentLocation,
          deliveriesWithStopOrder: filteredDeliveries || [],
          patients,
          stores,
          forceFullRemainingRouteOptimization: true,
          bypassDeduplication: true,
          bypassDriverStatus: true,
          triggerSource: 'silent_reoptimize',
        });
        if (data?.success) {
          try {
            invalidate('Delivery');
            const freshD = await base44.entities.Delivery.filter({ driver_id: selectedDriverId, delivery_date: date });
            if (Array.isArray(freshD) && freshD.length > 0) {
              await offlineDB.replaceRecordsByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', date, freshD).catch(() => {});
              updateDeliveriesLocally?.(freshD, true);
              window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { driverId: selectedDriverId, deliveryDate: date, triggeredBy: 'reoptimizeRoute', alreadyOptimized: true, fullReplacement: true, freshDeliveries: freshD } }));
            } else {
              window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { driverId: selectedDriverId, deliveryDate: date, triggeredBy: 'reoptimizeRoute', alreadyOptimized: true, preserveLocalState: true } }));
            }
          } catch (_) {
            window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { driverId: selectedDriverId, deliveryDate: date, triggeredBy: 'reoptimizeRoute', alreadyOptimized: true, preserveLocalState: true } }));
          }
          window.dispatchEvent(new CustomEvent('routeReordered', { detail: { driverId: selectedDriverId, deliveryDate: date, source: 'reoptimizeRoute' } }));
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

  if (!isAppOwner(currentUser) || selectedDriverId === "all") {
    return null;
  }

  // Build a display name for a delivery using patients/stores arrays
  const getStopName = (delivery) => {
    if (!delivery) return "Unknown";
    if (delivery.is_cycling_marker) return "🚴 Cycling Marker";
    if (isInterStoreDelivery(delivery.delivery_id)) {
      const loc = getInterStoreLocationSync(delivery.delivery_id);
      const storeName = loc?.store_name || null;
      const dIdUpper = String(delivery.delivery_id).toUpperCase();
      const tag = dIdUpper.startsWith('ISD-') ? 'ISD' : 'ISP';
      return storeName ? `${storeName}(${tag})` : delivery.delivery_id;
    }
    if (delivery.patient_id) {
      const patient = (patients || []).find(p => p?.id === delivery.patient_id);
      if (patient?.full_name) return patient.full_name;
    }
    if (delivery.store_id) {
      const store = (stores || []).find(s => s?.id === delivery.store_id);
      if (store?.name) return `📦 ${store.name}`;
    }
    return delivery.patient_name || delivery.delivery_id || "Unknown";
  };

  const fabPosition = isMobile ? "absolute" : "fixed";

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
      transition={{ type: "spring", stiffness: 260, damping: 20 }}
      className="z-[100] flex items-center gap-2"
      style={{
        position: fabPosition,
        bottom: `${(deliveriesWithStopOrder.length > 0 && cardsReadyForFAB && !immersiveHidden ? stopCardsBaseHeight : 0) + 10}px`,
        right: "64px"
      }}
    >
      <Button
        ref={reoptimizeBtnRef}
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
            const hereApiKey = await getOrFetchHereApiKey();

            // Pass driver's live GPS so HERE sequences from actual current position
            const driverAppUser = appUsers?.find(au => au.id === selectedDriverId || au.user_id === selectedDriverId);
            const currentLocation = driverAppUser?.current_latitude != null
              ? { lat: Number(driverAppUser.current_latitude), lon: Number(driverAppUser.current_longitude) }
              : null;

            // Capture BEFORE state from current deliveries
            const ACTIVE_PENDING = ['in_transit', 'en_route', 'pending'];
            const beforeDeliveries = (filteredDeliveries || []).filter(d => d && ACTIVE_PENDING.includes(d.status));
            const beforeMap = new Map(
              beforeDeliveries.map(d => [d.id, { stopOrder: d.stop_order, eta: d.delivery_time_eta }])
            );

            // Pre-warm ISD/ISP name cache before showing dialog
            await Promise.all(
              beforeDeliveries
                .filter(d => d?.delivery_id && isInterStoreDelivery(d.delivery_id))
                .map(d => resolveInterStoreFromName(d.delivery_id))
            );

            // Show dialog immediately with "before" state (newStopOrder=null = loading indicator)
            const deliveryMapEarly = new Map(beforeDeliveries.filter(d => d?.id).map(d => [d.id, d]));
            const beforeRows = beforeDeliveries
              .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0))
              .map(d => ({
                deliveryId: d.id,
                name: getStopName(d),
                oldStopOrder: d.stop_order ?? null,
                oldEta: d.delivery_time_eta ?? null,
                newStopOrder: null,
                newEta: null,
                orderChanged: false,
              }));
            setCompareRows(beforeRows);
            setCompareDialogOpen(true);

            const data = await invokeOptimizeAwareCycling({
              driverId: selectedDriverId,
              deliveryDate,
              currentLocalTime,
              deviceTime: now.toISOString(),
              hereApiKey,
              currentLocation,
              deliveriesWithStopOrder: filteredDeliveries || [],
              patients,
              stores,
              forceFullRemainingRouteOptimization: true,
              bypassDeduplication: true,
              bypassDriverStatus: true,
              triggerSource: 'manual_fab',
            });
            if (data?.success) {
              // Build compare rows for AppOwner dialog
              if (Array.isArray(data.optimizedRoute) && data.optimizedRoute.length > 0) {
                const deliveryMap = new Map(
                  (filteredDeliveries || []).filter(d => d?.id).map(d => [d.id, d])
                );
                // Update dialog rows with the after state
                const rows = data.optimizedRoute.map(after => {
                  const before = beforeMap.get(after.deliveryId) || {};
                  const delivery = deliveryMap.get(after.deliveryId);
                  return {
                    deliveryId: after.deliveryId,
                    name: getStopName(delivery),
                    oldStopOrder: before.stopOrder ?? null,
                    oldEta: before.eta ?? null,
                    newStopOrder: after.stop_order,
                    newEta: after.newETA,
                    orderChanged: (before.stopOrder ?? null) !== after.stop_order,
                  };
                });
                setCompareRows(rows);
              }

              if (Array.isArray(data.optimizedRoute) && data.optimizedRoute.length > 0) {
                window.dispatchEvent(new CustomEvent("etaUpdated", { detail: { driverId: selectedDriverId, updates: data.optimizedRoute.map((stop) => ({ deliveryId: stop.deliveryId || stop.delivery_id, newEta: stop.newETA || stop.eta })).filter((stop) => stop.deliveryId && stop.newEta) } }));
              }
              base44.analytics.track({
                eventName: "route_optimization_run",
                properties: {
                  source: "manual_fab",
                  success: true,
                  route_changed: Boolean(data.routeChanged),
                  optimized_stop_count: Number(data.optimizedCount || data.totalStops || data.optimizedRoute?.length || 0)
                }
              });
              setOptimizationMessage(`Route optimized! ${(data.optimizedCount || data.totalStops || data.optimizedRoute?.length || 0)} stops updated.`);
              window.dispatchEvent(new CustomEvent("deliveriesUpdated", { detail: { driverId: selectedDriverId, deliveryDate, triggeredBy: "reoptimizeRoute", alreadyOptimized: true, preserveLocalState: true } }));
              window.dispatchEvent(new CustomEvent("routeReordered", { detail: { driverId: selectedDriverId, deliveryDate, source: "reoptimizeRoute" } }));
              setIsMapViewLocked(true);
              setMapViewTrigger((prev) => prev + 1);

              // Polylines are regenerated by invokeOptimizeAwareCycling (Stage 3) — dispatch update event
              window.dispatchEvent(new CustomEvent("polylineUpdated", { detail: { driverId: selectedDriverId, deliveryDate } }));

              // Fetch fresh deliveries (stop_order + polylines now updated) and push to offline DB + UI
              try {
                invalidate('Delivery');
                const freshDeliveries = await base44.entities.Delivery.filter({ driver_id: selectedDriverId, delivery_date: deliveryDate });
                if (Array.isArray(freshDeliveries) && freshDeliveries.length > 0) {
                  await offlineDB.replaceRecordsByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', deliveryDate, freshDeliveries).catch(() => {});
                  updateDeliveriesLocally?.(freshDeliveries, true);
                  window.dispatchEvent(new CustomEvent("deliveriesUpdated", { detail: { driverId: selectedDriverId, deliveryDate, triggeredBy: "reoptimizeRouteFresh", alreadyOptimized: true, fullReplacement: true, freshDeliveries } }));
                }
              } catch (refreshErr) {
                console.warn('⚠️ [FAB reoptimize] post-optimize DB refresh failed:', refreshErr?.message);
              }

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
        disabled={isReoptimizing || isDateFinished || !filteredDeliveries.some((delivery) => delivery && (delivery.status === "in_transit" || delivery.status === "en_route"))}
        title="Re-optimize entire route using Google Maps"
        className={`inline-flex items-center justify-center h-10 w-10 rounded-lg shadow-2xl p-0 transition-all duration-200 ${
          isReoptimizing ? "bg-amber-500 hover:bg-amber-600" : "bg-emerald-600 hover:bg-emerald-700"
        }`}
        style={{ pointerEvents: "auto", touchAction: "manipulation" }}
      >
        {isReoptimizing ? <div className="animate-spin w-5 h-5 border-2 border-white border-t-transparent rounded-full" /> : <Navigation className="w-5 h-5 text-white" />}
      </Button>
    </motion.div>
    </>
  );
}