import { format } from 'date-fns';

export default function getExpandedStatsControlsProps({
  selectedDriverId,
  handleDriverChange,
  isDriverDropdownDisabled,
  driversList,
  isDriver,
  isAllDriversMode,
  showAllDriverMarkers,
  setShowAllDriverMarkers,
  currentUser,
  setIsExpanded,
  setSelectedCardId,
  cardExpandedAtRef,
  setAreCardsVisible,
  dataSource,
  selectedDate,
  base44,
  offlineDB,
  deliveries,
  updateDeliveriesLocally,
  setIsEntityUpdating,
  smartRefreshManager,
  appUsers,
  driverLocationPoller,
  drivers,
  stores,
  setMapViewPhase,
  setIsMapViewLocked,
  lastProgrammaticMapMoveRef,
  setMapViewTrigger,
  mapLockTimeoutRef,
  mapLockExpiresAtRef,
  setShowOptimizationSettings,
  showRoutes,
  setShowRoutes,
  shouldShowLocationToggle,
  refreshUser,
  setShowQuickAdjustments,
  setShowSmartPrioritization,
  preferredTravelMode,
  setPreferredTravelMode,
  isRouteComplete,
  isStatsCardCentered,
  dailyPolylineCount,
  isExpanded,
  isMobile,
  showBreadcrumbs,
  setShowBreadcrumbs,
  setBreadcrumbsData,
  saveSetting,
  mergeDeliveriesForDate,
}) {
  const handleToggleShowAllDriverMarkers = async () => {
    const checked = !showAllDriverMarkers;
    setShowAllDriverMarkers(checked);

    if (currentUser?.id) {
      saveSetting(currentUser.id, 'show_all_driver_markers', checked);
    }

    setIsExpanded(false);
    setSelectedCardId(null);
    cardExpandedAtRef.current = null;
    setAreCardsVisible(false);
    setIsEntityUpdating(true);

    try {
      const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
      let allDateDeliveries;

      if (dataSource === 'online') {
        allDateDeliveries = await base44.entities.Delivery.filter({ delivery_date: selectedDateStr });
        offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, allDateDeliveries).catch(() => {});
      } else {
        allDateDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr);
        if (!allDateDeliveries || allDateDeliveries.length === 0) {
          allDateDeliveries = await base44.entities.Delivery.filter({ delivery_date: selectedDateStr });
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, allDateDeliveries);
        }
      }

      if (updateDeliveriesLocally) {
        updateDeliveriesLocally(
          mergeDeliveriesForDate({ deliveries, selectedDateStr, freshDeliveries: allDateDeliveries }),
          true
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 150));

      const locationUpdates = await smartRefreshManager.refreshDriverLocations(appUsers, true, 'Dashboard', selectedDate);
      const latestAppUsers = locationUpdates?.appUsers || appUsers;

      driverLocationPoller.processLocationData(
        currentUser,
        allDateDeliveries,
        drivers,
        stores,
        latestAppUsers,
        selectedDate,
        true,
        'Dashboard',
        checked || selectedDriverId === 'all'
      );

      window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
        detail: { appUsers: latestAppUsers, forceAll: checked, mergeMode: 'replace' }
      }));

      if (mapLockTimeoutRef.current) {
        clearTimeout(mapLockTimeoutRef.current);
        mapLockTimeoutRef.current = null;
      }

      mapLockExpiresAtRef.current = null;
      setMapViewPhase(1);
      setIsMapViewLocked(false);
      lastProgrammaticMapMoveRef.current = Date.now();
      window._lastProgrammaticMapMove = Date.now();
      setMapViewTrigger((prev) => prev + 1);
    } finally {
      setIsEntityUpdating(false);
    }
  };

  return {
    selectedDriverId,
    handleDriverChange,
    isDriverDropdownDisabled,
    driversList,
    isDriver,
    isAllDriversMode,
    showAllDriverMarkers,
    setShowAllDriverMarkers: handleToggleShowAllDriverMarkers,
    currentUser,
    setShowOptimizationSettings,
    showRoutes,
    setShowRoutes,
    shouldShowLocationToggle,
    refreshUser,
    setShowQuickAdjustments,
    setShowSmartPrioritization,
    preferredTravelMode,
    setPreferredTravelMode,
    isRouteComplete,
    isStatsCardCentered,
    dailyPolylineCount,
    isExpanded,
    isMobile,
    selectedDate,
    appUsers,
    showBreadcrumbs,
    setShowBreadcrumbs,
    setBreadcrumbsData,
  };
}