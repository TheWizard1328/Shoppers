import React from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/components/ui/select';
import { Settings, Binoculars } from 'lucide-react';
import BreadcrumbToggleButton from '@/components/dashboard/BreadcrumbToggleButton';
import DriverRouteControls from '@/components/dashboard/DriverRouteControls';
import DashboardOfflineSync from '@/components/dashboard/DashboardOfflineSync';

export default function ExpandedDashboardControls({
  isExpanded,
  selectedDriverId,
  handleDriverChange,
  isDriverDropdownDisabled,
  driversList,
  isDriver,
  isAllDriversMode,
  showAllDriverMarkers,
  setShowAllDriverMarkers,
  currentUser,
  saveSetting,
  setIsExpanded,
  setSelectedCardId,
  cardExpandedAtRef,
  setAreCardsVisible,
  setIsEntityUpdating,
  selectedDate,
  dataSource,
  deliveries,
  updateDeliveriesLocally,
  appUsers,
  drivers,
  stores,
  driverLocationPoller,
  showBreadcrumbs,
  setShowBreadcrumbs,
  showRoutes,
  setShowRoutes,
  setBreadcrumbsData,
  isRouteComplete,
  setShowOptimizationSettings,
  shouldShowLocationToggle,
  refreshUser,
  setShowQuickAdjustments,
  setShowSmartPrioritization,
  preferredTravelMode,
  setPreferredTravelMode,
  hasActiveRoute,
  isStatsCardCentered,
  currentUserForSync,
  dailyPolylineCount,
  mapLockTimeoutRef,
  mapLockExpiresAtRef,
  setMapViewPhase,
  setIsMapViewLocked,
  lastProgrammaticMapMoveRef,
  setMapViewTrigger,
  mapViewPhase,
}) {
  if (!isExpanded) return null;

  return (
    <div className="pt-1 pb-1 border-t flex items-center gap-2" style={{ borderColor: 'var(--border-slate-200)' }}>
      <Select value={selectedDriverId} onValueChange={handleDriverChange} disabled={isDriverDropdownDisabled}>
        <SelectTrigger className="whitespace-nowrap border-input bg-transparent shadow-sm data-[placeholder]:text-muted-foreground flex h-10 w-full items-center justify-between rounded-md border px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1 flex-1" style={{ pointerEvents: 'auto', touchAction: 'manipulation', background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
          <SelectValue placeholder="All Drivers" />
        </SelectTrigger>
        <SelectContent className="z-[10001]" style={{ pointerEvents: 'auto', background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
          <SelectItem value="all" style={{ color: 'var(--text-slate-900)' }}>All Drivers</SelectItem>
          {driversList.map((driver) => (
            <SelectItem key={driver.id} value={driver.id} style={{ color: driver._hasDispatcherStoreDeliveries ? '#047857' : 'var(--text-slate-900)', fontWeight: driver._hasDispatcherStoreDeliveries ? '700' : '400' }}>
              {driver.user_name || driver.full_name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {isDriver && !isAllDriversMode && (
        <div className="flex items-center flex-shrink-0">
          <div className="flex flex-col items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              onClick={async () => {
                const checked = !showAllDriverMarkers;
                setShowAllDriverMarkers(checked);
                if (currentUser?.id) {
                  saveSetting(currentUser.id, 'show_all_driver_markers', checked);
                }
                setIsExpanded(false);
                setSelectedCardId(null);
                cardExpandedAtRef.current = null;
                setAreCardsVisible(false);
                if (checked) {
                  setIsEntityUpdating(true);
                  try {
                    const selectedDateStr = new Date(selectedDate).toISOString().split('T')[0];
                    let allDateDeliveries;
                    if (dataSource === 'online') {
                      const { base44 } = await import('@/api/base44Client');
                      const { offlineDB } = await import('@/components/utils/offlineDatabase');
                      allDateDeliveries = await base44.entities.Delivery.filter({ delivery_date: selectedDateStr });
                      offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, allDateDeliveries).catch(() => {});
                    } else {
                      const { offlineDB } = await import('@/components/utils/offlineDatabase');
                      const { base44 } = await import('@/api/base44Client');
                      allDateDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr);
                      if (!allDateDeliveries || allDateDeliveries.length === 0) {
                        allDateDeliveries = await base44.entities.Delivery.filter({ delivery_date: selectedDateStr });
                        await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, allDateDeliveries);
                      }
                    }
                    if (updateDeliveriesLocally) {
                      const otherDateDeliveries = deliveries.filter((d) => d && d.delivery_date !== selectedDateStr);
                      updateDeliveriesLocally([...otherDateDeliveries, ...allDateDeliveries], true);
                    }
                    await new Promise((resolve) => setTimeout(resolve, 300));
                    const { smartRefreshManager } = await import('@/components/utils/smartRefreshManager');
                    const locationUpdates = await smartRefreshManager.refreshDriverLocations(appUsers, true);
                    if (locationUpdates?.hasChanges) {
                      driverLocationPoller.processLocationData(currentUser, allDateDeliveries, drivers, stores, locationUpdates.appUsers, selectedDate);
                    }
                    const showAllLocationUpdates = await smartRefreshManager.refreshDriverLocations(appUsers, true, 'Dashboard', selectedDate);
                    const showAllLatestAppUsers = showAllLocationUpdates?.appUsers || appUsers;
                    window.dispatchEvent(new CustomEvent('driverLocationsUpdated', { detail: { appUsers: showAllLatestAppUsers, forceAll: true } }));
                  } finally {
                    setIsEntityUpdating(false);
                  }
                }
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
              }}
              className={`h-9 w-9 p-0 ${showAllDriverMarkers ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : ''}`}
              style={!showAllDriverMarkers ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-700)' } : {}}
            >
              <Binoculars className="w-4 h-4" />
            </Button>
          </div>

          <div className="flex flex-col items-center gap-1">
            <BreadcrumbToggleButton
              isMobile={false}
              isDriver={isDriver}
              isRouteComplete={isRouteComplete}
              showBreadcrumbs={showBreadcrumbs}
              setShowBreadcrumbs={setShowBreadcrumbs}
              setShowRoutes={setShowRoutes}
              setBreadcrumbsData={setBreadcrumbsData}
              selectedDate={selectedDate}
              showAllDriverMarkers={showAllDriverMarkers}
              selectedDriverId={selectedDriverId}
              currentUser={currentUser}
              appUsers={appUsers}
            />
          </div>
        </div>
      )}

      <Button
        variant="outline"
        size="sm"
        onClick={() => setShowOptimizationSettings(true)}
        className="h-8 w-8 p-0 flex-shrink-0"
        title="Route Optimization Settings"
        style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}
      >
        <Settings className="w-3.5 h-3.5" />
      </Button>

      <Button
        variant="default"
        size="s"
        onClick={() => {
          setShowRoutes(!showBreadcrumbs);
          setIsExpanded(false);
        }}
        className={`${showRoutes ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700'} text-white px-2 text-sm font-medium rounded-md inline-flex min-h-11 min-w-11 items-center justify-center whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow gap-2 h-6 flex-shrink-0`}
      >
        Route Lines
      </Button>

      <DriverRouteControls
        shouldShowLocationToggle={shouldShowLocationToggle}
        currentUser={currentUser}
        refreshUser={refreshUser}
        isDriver={isDriver}
        setShowQuickAdjustments={setShowQuickAdjustments}
        setShowSmartPrioritization={setShowSmartPrioritization}
        appUsers={appUsers}
        preferredTravelMode={preferredTravelMode}
        setPreferredTravelMode={setPreferredTravelMode}
        hasActiveRoute={hasActiveRoute}
      />

      {isStatsCardCentered && (
        <>
          <div className="border-t border-slate-200 mt-2 pt-2"></div>
          <DashboardOfflineSync currentUser={currentUserForSync} dailyPolylineCount={dailyPolylineCount} isExpanded={isExpanded} />
        </>
      )}
    </div>
  );
}