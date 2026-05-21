import React from 'react';
import { Button } from '@/components/ui/button';
import LocationTrackingToggle from '@/components/layout/LocationTrackingToggle';
import TravelModeControl from '@/components/dashboard/TravelModeControl';
export default function DriverRouteControls({
  shouldShowLocationToggle,
  currentUser,
  refreshUser,
  isDriver,
  setShowQuickAdjustments,
  appUsers,
  preferredTravelMode,
  setPreferredTravelMode,
  hasActiveRoute,
  filteredDeliveries,
  modeDialogOpen,
  setModeDialogOpen,
  nearbyModeStops,
  selectedModeStopIds,
  toggleModeStop,
  returnToCurrentLocation,
  toggleReturnToCurrentLocation,
  handleModeOptimize,
  isOptimizingModeRoute,
}) {
  if (!shouldShowLocationToggle) return null;

  return (
    <>
      <div className="border-t border-slate-200"></div>
      <div className="py-1 flex items-center gap-2">
        <LocationTrackingToggle
          user={currentUser}
          onUserUpdate={async () => {
            await refreshUser();
          }}
        />

        {isDriver && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowQuickAdjustments(true)}
              disabled={!hasActiveRoute || !filteredDeliveries?.some(d => d && (d.status === 'in_transit' || d.status === 'en_route'))}
              className="h-8 gap-1.5 px-2 flex-shrink-0"
              title="Quick route adjustments"
              style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}
            >
              <span className="text-xs">Adjust</span>
            </Button>

            <TravelModeControl
              currentUser={currentUser}
              appUsers={appUsers}
              value={preferredTravelMode}
              onChange={setPreferredTravelMode}
              disabled={!hasActiveRoute}
              dialogOpen={modeDialogOpen}
              onDialogOpenChange={setModeDialogOpen}
              nearbyStops={nearbyModeStops}
              selectedStopIds={selectedModeStopIds}
              onToggleStop={toggleModeStop}
              returnToCurrentLocation={returnToCurrentLocation}
              onToggleReturn={toggleReturnToCurrentLocation}
              onOptimize={handleModeOptimize}
              isSubmitting={isOptimizingModeRoute}
            />
          </>
        )}
      </div>
    </>
  );
}