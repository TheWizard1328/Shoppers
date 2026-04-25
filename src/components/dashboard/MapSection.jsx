import { format } from 'date-fns';
import { fabControlEvents } from '@/components/utils/fabControlEvents';
import { isAppOwner, userHasRole } from '@/components/utils/userRoles';
import DeliveryMap from "@/components/dashboard/DeliveryMap";
import DashboardOfflineSync from '@/components/dashboard/DashboardOfflineSync';
import ETATracker from '@/components/dashboard/ETATracker';
import ETANotification from '@/components/dashboard/ETANotification';
import RealTimeRouteOptimizer from '@/components/dashboard/RealTimeRouteOptimizer';
import CompletedRouteControls from '@/components/dashboard/CompletedRouteControls';

export default function MapSection({
  currentUser, isDriver, isDispatcher, isMobile,
  deliveries, patients, stores, drivers, appUsers, filteredDeliveries, deliveriesWithStopOrder,
  selectedDate, selectedDateStr, selectedDriverId,
  mapCenter, mapZoom, shouldFitBounds, setShouldFitBounds, setMapCenter, setMapZoom,
  mapMode, setMapMode, driverLocation, allDriverLocations, currentToNextPolyline,
  showRoutes, showAllDriverMarkers, showBreadcrumbs, breadcrumbsData,
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
  topOverlayHeight = 0,
}) {
  const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
  const routeCompleteForSelectedDriver = selectedDriverId && selectedDriverId !== 'all'
    ? deliveriesWithStopOrder.filter((d) => d && d.patient_id && d.driver_id === selectedDriverId).length > 0 &&
      deliveriesWithStopOrder.filter((d) => d && d.patient_id && d.driver_id === selectedDriverId).every((d) => finishedStatuses.includes(d.status))
    : false;

  return (
    <>
      {!isStatsCardCentered && <DashboardOfflineSync currentUser={currentUser} dailyPolylineCount={dailyPolylineCount} isExpanded={isExpanded} stopCardsHeight={stopCardsBaseHeight} />}

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
        setShowBreadcrumbs={window.__dashboardCompletedRouteControls?.setShowBreadcrumbs || (() => {})}
        setBreadcrumbsData={() => {}}
        appUsers={appUsers}
        deliveriesWithStopOrder={deliveriesWithStopOrder}
      />

      <div className="absolute inset-0">
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
          }}
          onDoubleTap={() => {
            onImmersiveMapTap?.();
            fabControlEvents.reactivateFAB(false, { forceWhileUserInteracting: true, reason: 'map_double_tap' });
            const nextCard = deliveriesWithStopOrder.find((d) => d && d.isNextDelivery === true);
            if (nextCard?.id) {
              window.dispatchEvent(new CustomEvent('centerStopCard', { detail: { deliveryId: nextCard.id } }));
            }
          }}
          retractClustersRef={retractClustersRef}
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