import { useCallback, useEffect, useRef, useState } from "react";
import { format } from "date-fns";
import { base44 } from "@/api/base44Client";
import { offlineDB } from "@/components/utils/offlineDatabase";
import { smartRefreshManager } from "@/components/utils/smartRefreshManager";
import { driverLocationPoller } from "@/components/utils/driverLocationPoller";
import { saveSetting } from "@/components/utils/userSettingsManager";
import { fabControlEvents } from "@/components/utils/fabControlEvents";

/**
 * Driver-legend overlay state machine (non-admin drivers only).
 *
 *   State A (active-only):   showAllDriverMarkers=false, overlayDriverId=null
 *   State B (overlay X):     showAllDriverMarkers=true,  overlayDriverId=X (other driver)
 *   State C (Full Show All): showAllDriverMarkers=true,  overlayDriverId=null
 *
 * Transition matrix:
 *   A + click active     → C
 *   A + click X(≠active) → overlay X (B)
 *   B + click overlay    → A
 *   B + click active     → A
 *   B + click Y(≠active,≠overlay) → overlay Y (B)
 *   C + click any        → overlay that driver (B); C + active → A
 *
 * Admins & dispatchers keep the legacy behavior (click toggles selectedDriverId via handleDriverChange).
 */
export function useDriverOverlayLegend({
  currentUser, isAdmin, isDispatcher,
  selectedDriverId, selectedDate, dataSource,
  deliveries, appUsers, drivers, stores,
  updateDeliveriesLocally, setIsEntityUpdating,
  handleDriverChange,
  showAllDriverMarkers, setShowAllDriverMarkers,
}) {
  const [overlayDriverId, setOverlayDriverId] = useState(null);

  // Reset overlay whenever the active driver changes (dropdown switch / first set).
  const hasInitialDriverSettledRef = useRef(false);
  useEffect(() => {
    if (!hasInitialDriverSettledRef.current) {
      hasInitialDriverSettledRef.current = true;
      return;
    }
    setOverlayDriverId(null);
    if (currentUser?.id) saveSetting(currentUser.id, "overlay_driver_id", null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDriverId]);

  // Whenever an overlay is added or switched (becomes truthy), briefly lock the
  // mapCycle FAB to phase 1 for 500ms so the map refits to the active driver +
  // the newly overlaid driver's route. Fires only on overlay add/change, not on removal.
  useEffect(() => {
    if (!overlayDriverId) return;
    fabControlEvents.notifyDriverOverlayChanged();
  }, [overlayDriverId]);

  const handleDriverLegendClick = useCallback(async (routeDriverId) => {
    if (!currentUser) return;

    // Admins & dispatchers keep the legacy behavior (toggle selectedDriverId).
    if (isAdmin || isDispatcher) {
      handleDriverChange(selectedDriverId === routeDriverId ? "all" : routeDriverId);
      return;
    }

    const activeId = (selectedDriverId && selectedDriverId !== "all") ? selectedDriverId : currentUser?.id;
    if (!activeId) return;
    const isActive = routeDriverId === activeId;
    const isCurrentOverlay = !!(overlayDriverId && overlayDriverId === routeDriverId);
    const inFullShowAll = showAllDriverMarkers && !overlayDriverId;
    const inOverlayMode = showAllDriverMarkers && !!overlayDriverId;

    const turnOnShowAll = async () => {
      setShowAllDriverMarkers(true);
      setOverlayDriverId(null);
      if (currentUser?.id) saveSetting(currentUser.id, "show_all_driver_markers", true);
      setIsEntityUpdating(true);
      try {
        const selDateStr = format(selectedDate, "yyyy-MM-dd");
        let allDateDeliveries;
        if (dataSource === "online") {
          allDateDeliveries = await base44.entities.Delivery.filter({ delivery_date: selDateStr });
          offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, allDateDeliveries).catch(() => {});
        } else {
          allDateDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selDateStr);
          if (!allDateDeliveries || allDateDeliveries.length === 0) {
            allDateDeliveries = await base44.entities.Delivery.filter({ delivery_date: selDateStr });
            await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, allDateDeliveries);
          }
        }
        if (updateDeliveriesLocally) {
          const other = (deliveries || []).filter((d) => d && d.delivery_date !== selDateStr);
          updateDeliveriesLocally([...other, ...allDateDeliveries], true);
        }
        await new Promise((r) => setTimeout(r, 300));
        const locUpdates = await smartRefreshManager.refreshDriverLocations(appUsers, true);
        if (locUpdates?.hasChanges) driverLocationPoller.processLocationData(currentUser, allDateDeliveries, drivers, stores, locUpdates.appUsers, selectedDate);
        const showAllLocUpdates = await smartRefreshManager.refreshDriverLocations(appUsers, true, "Dashboard", selectedDate);
        window.dispatchEvent(new CustomEvent("driverLocationsUpdated", { detail: { appUsers: showAllLocUpdates?.appUsers || appUsers, forceAll: true } }));
      } catch (e) {
        console.error("Failed to enable Show All from legend:", e);
      } finally {
        setIsEntityUpdating(false);
      }
    };

    const turnOffShowAll = () => {
      setShowAllDriverMarkers(false);
      setOverlayDriverId(null);
      if (currentUser?.id) {
        saveSetting(currentUser.id, "show_all_driver_markers", false);
        saveSetting(currentUser.id, "overlay_driver_id", null);
      }
    };

    if (isActive) {
      if (!showAllDriverMarkers) {
        // State A → State C (Full Show All)
        await turnOnShowAll();
      } else {
        // State B → State A   OR   State C → State A (flow #6: click active in C = active only)
        turnOffShowAll();
      }
      return;
    }

    // Non-active click
    if (!showAllDriverMarkers) {
      // State A → State B (overlay = X)
      await turnOnShowAll();
      setOverlayDriverId(routeDriverId);
      if (currentUser?.id) saveSetting(currentUser.id, "overlay_driver_id", routeDriverId);
      return;
    }
    if (inFullShowAll) {
      // State C → State B (overlay = X) — flow #6
      setOverlayDriverId(routeDriverId);
      if (currentUser?.id) saveSetting(currentUser.id, "overlay_driver_id", routeDriverId);
      return;
    }
    if (inOverlayMode) {
      if (isCurrentOverlay) {
        // State B click overlay X → State A — flow #3
        turnOffShowAll();
      } else {
        // State B click different Y → switch overlay to Y
        setOverlayDriverId(routeDriverId);
        if (currentUser?.id) saveSetting(currentUser.id, "overlay_driver_id", routeDriverId);
      }
      return;
    }
  }, [currentUser, isAdmin, isDispatcher, selectedDriverId, showAllDriverMarkers, overlayDriverId,
      selectedDate, deliveries, dataSource, appUsers, drivers, stores,
      updateDeliveriesLocally, setIsEntityUpdating, handleDriverChange,
      setShowAllDriverMarkers]);

  return { overlayDriverId, setOverlayDriverId, handleDriverLegendClick };
}

export default useDriverOverlayLegend;