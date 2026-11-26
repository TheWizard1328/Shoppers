import React, { useState, useEffect } from 'react';
import { openNavigationTo } from '../utils/mapHelpers';
import { useOptimizationEngineMode } from '@/components/utils/serverOptimizationMode';
import { AnimatePresence } from 'framer-motion';
import { useDevice } from '@/components/utils/DeviceContext';
import MapViewCycleFAB from '@/components/dashboard/MapViewCycleFAB';
import MapNorthCompass from '@/components/dashboard/MapNorthCompass';
import RouteActionButtons from '@/components/dashboard/RouteActionButtons';
import TorchFAB from '@/components/dashboard/TorchFAB';
import { Navigation } from 'lucide-react';
import CallButtonWithText from '@/components/common/CallButtonWithText';
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
  isPrimaryDevice,
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
  immersiveIsCyclingMarker,
}) {
  const optimizationEngineMode = useOptimizationEngineMode(currentUser);
  const { isMobile } = useDevice();
  const hasVisibleCards = deliveriesWithStopOrder.length > 0 && cardsReadyForFAB;

  // Mirror GuideAssistant's pattern: hide the map FABs while a stop card is
  // expanded. The expanded card (StopCard.jsx anchored/full-height view) can
  // render taller than the collapsed-height measurement these FABs use for
  // their `bottom` offset (stopCardsBaseHeight), and the card's z-index
  // (z-[10070]) is far above the FABs' (z-[100]) — so without this, an
  // expanded card on portrait mobile visually covers the FABs entirely.
  const [isStopCardExpanded, setIsStopCardExpanded] = useState(false);
  useEffect(() => {
    const handleExpand = (e) => setIsStopCardExpanded(!!(e?.detail?.cardId));
    window.addEventListener('stopCardExpandedChange', handleExpand);
    return () => window.removeEventListener('stopCardExpandedChange', handleExpand);
  }, []);

  const fabPosition = 'absolute';
  const bottomNavHeight = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--bottom-nav-height') || '0') || 0;
  const tempBadgeBottom = (hasVisibleCards && !immersiveHidden ? stopCardsBaseHeight + bottomNavHeight : bottomNavHeight) + 10;
  // Flashlight FAB rides directly above the map-cycle FAB: same bottom formula
  // MapViewCycleFAB uses (stop cards + nav, or just nav), plus that FAB's real
  // 44px height (Button base min-h-11) and an 8px gap. APK + primary device
  // only — see TorchFAB.
  const mapCycleFabBottom = ((hasVisibleCards && !immersiveHidden) ? stopCardsBaseHeight + bottomNavHeight : bottomNavHeight) + 10;
  const torchFabBottom = mapCycleFabBottom + 52;

  // Compute selectedDate string for LiveTempBadge
  const selectedDateStr = selectedDate instanceof Date
    ? `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, '0')}-${String(selectedDate.getDate()).padStart(2, '0')}`
    : selectedDate;

  // Immersive FAB data — call button and navigation button for the next stop
  const immersiveFabBottom = bottomNavHeight + 10;

  // For ISP/ISD inter-store deliveries, use the inter-store location record for phone/nav
  const immersivePatientPhone = immersiveIsInterStore
    ? (immersiveInterStoreLocation?.store_phone || null)
    : immersiveOverlayIsPickup
      ? (immersiveOverlayStore?.phone || null)
      : (immersiveOverlayPatient?.phone || immersiveOverlayPatient?.phone_secondary || null);

  // Cycling markers (Cycling Start/End) have no patient/store — use the
  // marker's own cycling_latitude/cycling_longitude for the Navigate FAB.
  const immersiveNavLat = immersiveIsCyclingMarker
    ? immersiveOverlayDelivery?.cycling_latitude
    : immersiveIsInterStore
      ? (immersiveInterStoreLocation?.store_latitude ?? immersiveOverlayStore?.latitude)
      : immersiveOverlayIsPickup ? immersiveOverlayStore?.latitude : immersiveOverlayPatient?.latitude;
  const immersiveNavLon = immersiveIsCyclingMarker
    ? immersiveOverlayDelivery?.cycling_longitude
    : immersiveIsInterStore
      ? (immersiveInterStoreLocation?.store_longitude ?? immersiveOverlayStore?.longitude)
      : immersiveOverlayIsPickup ? immersiveOverlayStore?.longitude : immersiveOverlayPatient?.longitude;
  const immersiveNavAddress = immersiveIsCyclingMarker
    ? null
    : immersiveIsInterStore
      ? (immersiveInterStoreLocation?.store_address || immersiveOverlayStore?.address)
      : immersiveOverlayIsPickup ? immersiveOverlayStore?.address : immersiveOverlayPatient?.address;

  // OWNER SPEC (Nov 20 2026): the immersive-mode call FAB gets the same texting
  // behaviour as the stop card's call button — a "T" in the upper-left when the
  // patient's PRIMARY number texts, and a 1.5s press-and-hold that opens texting
  // instead of dialing. Store numbers (pickup / inter-store) never text, and the
  // phone_secondary fallback is not a primary number, so neither shows the T.
  const immersiveCallPatient = (() => {
    if (immersiveIsInterStore || immersiveOverlayIsPickup) return null;
    const p = immersiveOverlayPatient;
    if (!p || p.sms_primary !== true) return null;
    const digits = (v) => String(v || '').replace(/\D/g, '');
    return digits(p.phone) && digits(p.phone) === digits(immersivePatientPhone) ? p : null;
  })();

  const handleImmersiveNavigate = () => {
    // Routed through the shared helper (owner report Nov 23 2026): the raw
    // Google web URL opened the App Store / "update Google Maps" interstitial
    // on iPhones running the installed PWA.
    openNavigationTo({ address: immersiveNavAddress || null, lat: immersiveNavLat, lon: immersiveNavLon });
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
          <CallButtonWithText
            phone={immersivePatientPhone}
            patient={immersiveCallPatient}
            patientName={immersiveOverlayPatient?.full_name || ''}
            ariaLabel="Call patient"
            title="Call patient"
            size="compact"
          />
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
            aria-label="Open in Google Maps"
            className="relative inline-flex h-10 w-10 items-center justify-center rounded-full transition-colors bg-[#00A3FF] text-white hover:bg-[#0090E0]"
            style={{ touchAction: 'manipulation' }}
          >
            <Navigation className="w-5 h-5" />
            <span className="absolute top-1.5 left-1.5 font-bold text-[10px] pointer-events-none text-white/90">
              {optimizationEngineMode === 'server' ? 'S' : 'C'}
            </span>
          </button>
        </motion.div>
      )}
      {/* OWNER SPEC (Nov 12 2026): the flashlight FAB is hidden entirely while
          immersive mode is active - that view keeps only call/navigate + the
          map-cycle FAB, and a hidden button must not leave the torch burning. */}
      <TorchFAB
        key="torch-fab"
        /* OWNER RULES (Nov 15 2026): 1) day part is after sunset (sun calc
           inside TorchFAB, 20 min dusk lead), 2) driver AND primary device,
           3) dark mode does NOT matter. A driver's secondary phone does not get
           it, and no dispatcher/admin session does either - the APK bridge
           alone is not enough. */
        enabled={isPrimaryDevice === true && isDriver === true}
        bottomPx={torchFabBottom}
        rightPx={immersiveHidden ? 12 : 16}
        driverLocation={driverLocation}
        hideForExpandedCard={isStopCardExpanded}
        hidden={immersiveHidden}
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
        hideForExpandedCard={isStopCardExpanded}
      />
      {/* OWNER REQUEST (Nov 25 2026): the north needle sits directly above the
          map-cycle FAB and only while immersive mode is active AND the FAB is in
          Phase 2 (the turn-zoom phase, where the map can be rotated). TorchFAB
          shares this slot but is hidden in immersive mode, so they never clash. */}
      <MapNorthCompass
        key="map-north-compass"
        visible={immersiveHidden === true && mapViewPhase === 2}
        /* OWNER REQUEST (Nov 26 2026): outside Phase 2 the needle only shows when
           the map is actually rotated (pinch), and tapping it snaps north-up. */
        alwaysShowWhenRotated={immersiveHidden === true}
        bottomPx={mapCycleFabBottom + 52}
        rightPx={12}
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
        hideForExpandedCard={isStopCardExpanded}
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