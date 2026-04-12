import React from 'react';
import DriverRouteControls from '@/components/dashboard/DriverRouteControls';

export default function DriverRouteControlsSection({
  shouldShowLocationToggle,
  currentUser,
  refreshUser,
  isDriver,
  setShowQuickAdjustments,
  setShowSmartPrioritization,
  appUsers,
  preferredTravelMode,
  setPreferredTravelMode,
  isRouteComplete,
}) {
  return (
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
      hasActiveRoute={!isRouteComplete}
    />
  );
}