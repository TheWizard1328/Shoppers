export default function getDriverRouteControlsProps({
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
  return {
    shouldShowLocationToggle,
    currentUser,
    refreshUser,
    isDriver,
    setShowQuickAdjustments,
    setShowSmartPrioritization,
    appUsers,
    preferredTravelMode,
    setPreferredTravelMode,
    hasActiveRoute: !isRouteComplete,
  };
}