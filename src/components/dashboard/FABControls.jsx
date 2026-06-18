import React from 'react';
import { AnimatePresence } from 'framer-motion';
import { useDevice } from '@/components/utils/DeviceContext';
import MapViewCycleFAB from '@/components/dashboard/MapViewCycleFAB';
import RouteActionButtons from '@/components/dashboard/RouteActionButtons';
import ImmersiveActionFAB from '@/components/dashboard/ImmersiveActionFAB';
import { Phone, ExternalLink } from 'lucide-react';

export default function FABControls({
  currentUser,
  isDriver,
  isDispatcher,
  patients,
  stores,
  deliveriesWithStopOrder,
  filteredDeliveries,
  selectedDate,
  selectedDriverId,
  isDateFinished,
  mapViewPhase,
  isMapViewLocked,
  setIsMapViewLocked,
  driverLocation,
  cardsReadyForFAB,
  stopCardsBaseHeight,
  mapLockTimeoutRef,
  mapLockExpiresAtRef,
  handleMapViewCycle,
  mapViewTrigger,
  setMapViewTrigger,
  getMapPadding,
  setShouldFitBounds,
  setMapCenter,
  setMapZoom,
  isReoptimizing,
  setIsReoptimizing,
  optimizationMessage,
  setOptimizationMessage,
  setIsEntityUpdating,
  isAIEnabled,
  showAIAssistant,
  refreshData,
  updateDeliveriesLocally,
  immersiveHidden,
  topOverlayHeight,
  appUsers,
  hasFridgeItems,
  // Immersive mode overlay data — for the call + navigation FABs
  immersiveOverlayPatient,
  immersiveOverlayDelivery,
  immersiveOverlayIsPickup,
  immersiveOverlayStore,
}) {
  const { isMobile } = useDevice();
  const hasVisibleCards = deliveriesWithStopOrder.length > 0 && cardsReadyForFAB;

  const fabPosition = isMobile ? 'absolute' : 'fixed';
  const bottomNavHeight = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--bottom-nav-height') || '0') || 0;
  const tempBadgeBottom = (hasVisibleCards && !immersiveHidden ? stopCardsBaseHeight + bottomNavHeight : bottomNavHeight) + 10;

  // Compute selectedDate string for LiveTempBadge
  const selectedDateStr = selectedDate instanceof Date
    ? `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, '0')}-${String(selectedDate.getDate()).padStart(2, '0')}`
    : selectedDate;

  // Immersive FAB data — call button and navigation button for the next stop
  const immersiveFabBottom = bottomNavHeight + 10;
  const immersivePatientPhone = !immersiveOverlayIsPickup
    ? (immersiveOverlayPatient?.phone || immersiveOverlayPatient?.phone_secondary || null)
    : null;
  const immersiveNavAddress = immersiveOverlayIsPickup
    ? immersiveOverlayStore?.address
    : immersiveOverlayPatient?.address;
  const immersiveNavLat = immersiveOverlayIsPickup ? immersiveOverlayStore?.latitude : immersiveOverlayPatient?.latitude;
  const immersiveNavLon = immersiveOverlayIsPickup ? immersiveOverlayStore?.longitude : immersiveOverlayPatient?.longitude;

  const handleImmersiveCall = () => {
    if (!immersivePatientPhone) return;
    window.location.href = `tel:${immersivePatientPhone.replace(/\D/g, '')}`;
  };

  const handleImmersiveNavigate = () => {
    if (immersiveNavLat && immersiveNavLon) {
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${immersiveNavLat},${immersiveNavLon}`, '_blank');
    } else if (immersiveNavAddress) {
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(immersiveNavAddress)}`, '_blank');
    }
  };

  return (
    <AnimatePresence>
      <ImmersiveActionFAB
        key="immersive-call-fab"
        icon={Phone}
        title="Call patient"
        onClick={handleImmersiveCall}
        bottom={immersiveFabBottom}
        right={108}
        className="bg-blue-600 hover:bg-blue-700"
        style={{ display: (immersiveHidden && immersiveOverlayDelivery && isMobile && immersivePatientPhone) ? undefined : 'none' }}
      />
      <ImmersiveActionFAB
        key="immersive-nav-fab"
        icon={ExternalLink}
        title="Open in Google Maps"
        onClick={handleImmersiveNavigate}
        bottom={immersiveFabBottom}
        right={60}
        className="bg-violet-600 hover:bg-violet-700"
        style={{ display: (immersiveHidden && immersiveOverlayDelivery && isMobile && (immersiveNavLat || immersiveNavAddress)) ? undefined : 'none' }}
      />
      <MapViewCycleFAB
        key="map-view-cycle-fab"
        currentUser={currentUser}
        filteredDeliveries={filteredDeliveries}
        onClick={handleMapViewCycle}
        currentPhase={mapViewPhase}
        hasVisibleCards={hasVisibleCards && !immersiveHidden}
        isLocked={isMapViewLocked}
        isEnabled={mapViewPhase === 1 || filteredDeliveries.length > 0}
        stopCardsHeight={stopCardsBaseHeight}
        immersiveHidden={immersiveHidden}
      />
      <RouteActionButtons
        key="route-action-buttons"
        currentUser={currentUser}
        selectedDriverId={selectedDriverId}
        selectedDate={selectedDate}
        deliveriesWithStopOrder={deliveriesWithStopOrder}
        filteredDeliveries={filteredDeliveries}
        patients={patients}
        stores={stores}
        cardsReadyForFAB={cardsReadyForFAB}
        stopCardsBaseHeight={stopCardsBaseHeight}
        isDateFinished={isDateFinished}
        isReoptimizing={isReoptimizing}
        setIsReoptimizing={setIsReoptimizing}
        setOptimizationMessage={setOptimizationMessage}
        setIsEntityUpdating={setIsEntityUpdating}
        refreshData={refreshData}
        updateDeliveriesLocally={updateDeliveriesLocally}
        setIsMapViewLocked={setIsMapViewLocked}
        setMapViewTrigger={setMapViewTrigger}
        appUsers={appUsers}
        immersiveHidden={immersiveHidden}
      />
    </AnimatePresence>
  );
}