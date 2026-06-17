import React from 'react';
import { AnimatePresence } from 'framer-motion';
import { useDevice } from '@/components/utils/DeviceContext';
import MapViewCycleFAB from '@/components/dashboard/MapViewCycleFAB';
import RouteActionButtons from '@/components/dashboard/RouteActionButtons';

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

  return (
    <AnimatePresence>
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