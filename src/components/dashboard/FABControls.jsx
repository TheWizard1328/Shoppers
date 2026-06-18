import React from 'react';
import { AnimatePresence } from 'framer-motion';
import { useDevice } from '@/components/utils/DeviceContext';
import MapViewCycleFAB from '@/components/dashboard/MapViewCycleFAB';
import RouteActionButtons from '@/components/dashboard/RouteActionButtons';
import { Phone, Navigation } from 'lucide-react';
import { motion } from 'framer-motion';

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
  immersiveIsInterStore,
  immersiveInterStoreLocation,
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

  // For ISP/ISD inter-store deliveries, use the inter-store location record for phone/nav
  const immersivePatientPhone = immersiveIsInterStore
    ? (immersiveInterStoreLocation?.store_phone || null)
    : !immersiveOverlayIsPickup
      ? (immersiveOverlayPatient?.phone || immersiveOverlayPatient?.phone_secondary || null)
      : null;

  const immersiveNavLat = immersiveIsInterStore
    ? (immersiveInterStoreLocation?.store_latitude ?? immersiveOverlayStore?.latitude)
    : immersiveOverlayIsPickup ? immersiveOverlayStore?.latitude : immersiveOverlayPatient?.latitude;
  const immersiveNavLon = immersiveIsInterStore
    ? (immersiveInterStoreLocation?.store_longitude ?? immersiveOverlayStore?.longitude)
    : immersiveOverlayIsPickup ? immersiveOverlayStore?.longitude : immersiveOverlayPatient?.longitude;
  const immersiveNavAddress = immersiveIsInterStore
    ? (immersiveInterStoreLocation?.store_address || immersiveOverlayStore?.address)
    : immersiveOverlayIsPickup ? immersiveOverlayStore?.address : immersiveOverlayPatient?.address;

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
      {immersiveHidden && immersiveOverlayDelivery && isMobile && immersivePatientPhone && (
        <motion.div
          key="immersive-call-fab"
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 260, damping: 20 }}
          className="z-[700]"
          style={{ position: fabPosition, bottom: `${immersiveFabBottom}px`, right: '108px', pointerEvents: 'auto' }}
        >
          <button
            type="button"
            onClick={handleImmersiveCall}
            title="Call patient"
            className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 transition-colors hover:bg-emerald-200"
            style={{ touchAction: 'manipulation' }}
          >
            <Phone className="w-5 h-5" />
          </button>
        </motion.div>
      )}
      {immersiveHidden && immersiveOverlayDelivery && isMobile && (immersiveNavLat || immersiveNavAddress) && (
        <motion.div
          key="immersive-nav-fab"
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 260, damping: 20 }}
          className="z-[700]"
          style={{ position: fabPosition, bottom: `${immersiveFabBottom}px`, right: '60px', pointerEvents: 'auto' }}
        >
          <button
            type="button"
            onClick={handleImmersiveNavigate}
            title="Open in Google Maps"
            className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-blue-100 text-blue-600 transition-colors hover:bg-blue-200"
            style={{ touchAction: 'manipulation' }}
          >
            <Navigation className="w-5 h-5" />
          </button>
        </motion.div>
      )}
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