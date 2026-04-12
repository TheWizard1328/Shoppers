import React from 'react';
import { Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import BreadcrumbToggleButton from '@/components/dashboard/BreadcrumbToggleButton';
import TravelModeSelector from '@/components/dashboard/TravelModeSelector';
import { saveSetting } from '@/components/utils/userSettingsManager';
import { userHasRole } from '@/components/utils/userRoles';

export default function ExpandedDashboardControls({
  selectedDriverId,
  handleDriverChange,
  isDriverDropdownDisabled,
  driversList,
  isDriver,
  isAllDriversMode,
  showAllDriverMarkers,
  setShowAllDriverMarkers,
  currentUser,
  selectedDate,
  deliveries,
  updateDeliveriesLocally,
  appUsers,
  drivers,
  stores,
  driverLocationPoller,
  smartRefreshManager,
  setIsEntityUpdating,
  mapLockTimeoutRef,
  mapLockExpiresAtRef,
  setMapViewPhase,
  setIsMapViewLocked,
  lastProgrammaticMapMoveRef,
  setMapViewTrigger,
  showBreadcrumbs,
  setShowBreadcrumbs,
  setShowRoutes,
  setBreadcrumbsData,
  isMobile,
  isRouteComplete,
  showOptimizationSettings,
  setShowOptimizationSettings,
  preferredTravelMode,
  setPreferredTravelMode,
}) {
  return (
    <div className="pt-1 pb-1 border-t flex items-center gap-2" style={{ borderColor: 'var(--border-slate-200)' }}>
      <Select
        value={selectedDriverId}
        onValueChange={handleDriverChange}
        disabled={isDriverDropdownDisabled}
      >
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
                if (checked) {
                  setIsEntityUpdating(true);
                  try {
                    const selectedDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit' }).format(selectedDate);
                    const allDateDeliveries = deliveries.filter((d) => d && d.delivery_date === selectedDateStr);
                    updateDeliveriesLocally?.([...(deliveries || []).filter((d) => d && d.delivery_date !== selectedDateStr), ...allDateDeliveries], true);
                    const locationUpdates = await smartRefreshManager.refreshDriverLocations(appUsers, true);
                    if (locationUpdates?.hasChanges) {
                      driverLocationPoller.processLocationData(currentUser, allDateDeliveries, drivers, stores, locationUpdates.appUsers, selectedDate);
                      window.dispatchEvent(new CustomEvent('driverLocationsUpdated', { detail: { appUsers: locationUpdates.appUsers, forceAll: true } }));
                    }
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
              <span className="text-xs font-semibold">All</span>
            </Button>
          </div>

          <div className="flex flex-col items-center gap-1">
            <BreadcrumbToggleButton
              isMobile={isMobile}
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

      {currentUser && userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'dispatcher') && (
        <TravelModeSelector
          currentUser={currentUser}
          appUsers={appUsers}
          value={preferredTravelMode}
          onChange={setPreferredTravelMode}
        />
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
    </div>
  );
}