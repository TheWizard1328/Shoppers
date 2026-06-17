import { format } from 'date-fns';
import { useDevice } from '@/components/utils/DeviceContext';
import { fabControlEvents } from '@/components/utils/fabControlEvents';
import { isAppOwner, userHasRole } from '@/components/utils/userRoles';
import DeliveryMap from "@/components/dashboard/DeliveryMap";
import DashboardOfflineSync from '@/components/dashboard/DashboardOfflineSync';
import ETATracker from '@/components/dashboard/ETATracker';
import ETANotification from '@/components/dashboard/ETANotification';
import RealTimeRouteOptimizer from '@/components/dashboard/RealTimeRouteOptimizer';
import CompletedRouteControls from '@/components/dashboard/CompletedRouteControls';
import ImmersiveMapTopOverlay from '@/components/dashboard/ImmersiveMapTopOverlay';

export default function MapSection({
  currentUser, isDriver, isDispatcher,
  deliveries, patients, stores, drivers, appUsers, filteredDeliveries, deliveriesWithStopOrder,
  selectedDate, selectedDateStr, selectedDriverId,
  mapCenter, mapZoom, shouldFitBounds, setShouldFitBounds, setMapCenter, setMapZoom,
  mapMode, setMapMode, driverLocation, allDriverLocations, currentToNextPolyline,
  showRoutes, showAllDriverMarkers, showBreadcrumbs, setShowBreadcrumbs: setShowBreadcrumbsProp, setBreadcrumbsData: setBreadcrumbsDataProp, breadcrumbsData,
  highlightedCardId, retractClustersRef,
  setDriverRoutes, renderSequence, setRenderSequence,
  stopCardsBaseHeight, handleMarkerClick, handleCardInteraction,
  areCardsVisible, handleMapViewCycle, isStatsCardCentered,
  dailyPolylineCount, isExpanded,
  polylineResetKey,
  realTimeETAEnabled, showDeliveryForm, showPatientForm, showOptimizationSettings,
  preferredTravelMode, onTravelModeChange,
  mapStyle,
  immersiveHidden, isDriverMoving, immersiveOverrideActive, onImmersiveMapTap,
  mapViewPhase = 1, isMapViewLocked = false,
  isAdmin = false,
  topOverlayHeight = 0,
  immersiveOverlayDelivery = null,
  immersiveOverlayStore = null,
  immersiveOverlayPatient = null,
  immersiveOverlayIsPickup = false,
  immersiveOverlayStoreColor = null,
  immersiveOverlayDisplayName = '',
  immersiveOverlayAddress = null,
  immersiveOverlayRemainingDistanceKm = null,
}) {
  const { isMobile } = useDevice();
  const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
  const routeCompleteForSelectedDriver = selectedDriverId && selectedDriverId !== 'all'
    ? deliveriesWithStopOrder.filter((d) => d && d.patient_id && d.driver_id === selectedDriverId).length > 0 &&
      deliveriesWithStopOrder.filter((d) => d && d.patient_id && d.driver_id === selectedDriverId).every((d) => finishedStatuses.includes(d.status))
    : false;

  return (
    <>
      {realTimeETAEnabled && isMobile && isDriver && selectedDriverId === currentUser?.id && selectedDriverId !== 'all' &&
        <ETATracker selectedDriverId={selectedDriverId} selectedDate={selectedDateStr} currentUser={currentUser} isActive={!showDeliveryForm && !showPatientForm && !showOptimizationSettings} onETAUpdate={() => {}} />
      }

      {isMobile && isDriver && selectedDriverId === currentUser?.id && selectedDriverId !== 'all' &&
        <RealTimeRouteOptimizer selectedDriverId={selectedDriverId} selectedDate={selectedDateStr} currentUser={currentUser} isActive={!showDeliveryForm && !showPatientForm && !showOptimizationSettings} onRouteOptimized={() => {}} />
      }

      <ETANotification deliveries={filteredDeliveries} driverId={selectedDriverId} currentUser={currentUser} />

      <CompletedRouteControls
        currentUser={currentUser}
        isMobile={isMobile}
        selectedDriverId={selectedDriverId}
        selectedDate={selectedDate}
        isRouteComplete={routeCompleteForSelectedDriver}
        showRoutes={showRoutes}
        setShowRoutes={window.__dashboardCompletedRouteControls?.setShowRoutes || (() => {})}
        showBreadcrumbs={showBreadcrumbs}
        setShowBreadcrumbs={setShowBreadcrumbsProp || window.__dashboardCompletedRouteControls?.setShowBreadcrumbs || (() => {})}
        setBreadcrumbsData={setBreadcrumbsDataProp || (() => {})}
        appUsers={appUsers}
        deliveriesWithStopOrder={deliveriesWithStopOrder}
      />

      <div className="absolute inset-0">
        {immersiveHidden && immersiveOverlayDelivery && (
          <ImmersiveMapTopOverlay
            delivery={immersiveOverlayDelivery}
            store={immersiveOverlayStore}
            patient={immersiveOverlayPatient}
            isPickup={immersiveOverlayIsPickup}
            storeColor={immersiveOverlayStoreColor}
            finalDisplayName={immersiveOverlayDisplayName}
            address={immersiveOverlayAddress}
            remainingDistanceKm={immersiveOverlayRemainingDistanceKm}
            topOffset={topOverlayHeight}
          />
        )}
        <DeliveryMap
          deliveries={deliveriesWithStopOrder}
          allDeliveriesForDate={deliveries}
          preferredTravelMode={preferredTravelMode}
          onTravelModeChange={onTravelModeChange}
          selectedDriverId={selectedDriverId}
          selectedDate={format(selectedDate, 'yyyy-MM-dd')}
          patients={patients}
          stores={stores}
          users={appUsers}
          currentUser={currentUser}
          driverLocations={allDriverLocations}
          deliveriesForLocationFilter={deliveries}
          showOtherDriverDeliveries={showAllDriverMarkers || selectedDriverId === 'all'}
          currentDriverLocation={driverLocation}
          currentToNextPolyline={currentToNextPolyline}
          showBreadcrumbs={showBreadcrumbs}
          breadcrumbsData={breadcrumbsData}
          center={mapCenter}
          zoom={mapZoom}
          setMapCenter={setMapCenter}
          setMapZoom={setMapZoom}
          shouldFitBounds={shouldFitBounds}
          onBoundsFitted={() => setShouldFitBounds(null)}
          onMarkerClick={handleMarkerClick}
          mapMode={mapMode}
          onMapModeChange={setMapMode}
          autoFitBounds={true}
          showRoutes={showRoutes}
          showLegend={false}
          areCardsVisible={areCardsVisible}
          onLegendInteraction={handleCardInteraction}
          onDriverRoutesCalculated={setDriverRoutes}
          onMapInteraction={() => {
            onImmersiveMapTap?.();
            // Skip FAB unlock if this interaction was triggered by a double-tap (within 800ms)
            const timeSinceDoubleTap = Date.now() - (window._lastMapDoubleTapAt || 0);
            if (timeSinceDoubleTap < 800) return;
            // Skip FAB unlock if the map was just repositioned programmatically (within 500ms)
            // Prevents GPS-driven camera pans/zooms (Phase 2 live follow) from being
            // misidentified as user interaction and accidentally unlocking the FAB.
            const timeSinceProgrammaticMove = Date.now() - (window._lastProgrammaticMapMove || 0);
            if (timeSinceProgrammaticMove < 500) return;
            // Manual pan/zoom → unlock FAB (turns it gray). Phase is preserved.
            // A double-tap on the map re-locks the FAB to the current phase.
            fabControlEvents.notifyUserMapInteraction();
          }}
          onDoubleTap={() => {
            window._lastMapDoubleTapAt = Date.now();
            onImmersiveMapTap?.();
            // Dispatchers (and admins who are not drivers): double-tap reactivates FAB at current phase
            if ((isDispatcher || isAdmin) && !isDriver) {
              handleMapViewCycle?.();
              return;
            }
            // Only zoom if immersive mode is NOT active
            if (!immersiveHidden) {
              window.dispatchEvent(new CustomEvent('mapDoubleTapZoom', { detail: { delta: 0.5 } }));
              fabControlEvents.notifyUserMapInteraction();
            }
          }}
          retractClustersRef={retractClustersRef}
          immersiveHidden={immersiveHidden}
          areStopCardsVisible={!immersiveHidden && deliveriesWithStopOrder.length > 0}
          highlightedDeliveryId={highlightedCardId}
          stopCardsHeight={immersiveHidden ? 0 : stopCardsBaseHeight}
          mapViewPhase={mapViewPhase}
          isMapViewLocked={isMapViewLocked}
          topOverlayHeight={!immersiveHidden ? topOverlayHeight : 0}
          mapStyle={mapStyle}
          preferredTravelMode={preferredTravelMode}
          onTravelModeChange={onTravelModeChange}
          onMapReady={() => {
            if (!renderSequence.mapMarkers) {
              setRenderSequence(prev => ({ ...prev, mapMarkers: true, routeLines: true, driverLiveLocation: true, sharedLocations: true }));
            }
          }} />
      </div>
    </>
  );
}