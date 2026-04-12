import { format } from 'date-fns';
import { isAppOwner, userHasRole } from '@/components/utils/userRoles';
import DeliveryMap from "@/components/dashboard/DeliveryMap";
import DashboardOfflineSync from '@/components/dashboard/DashboardOfflineSync';
import ETATracker from '@/components/dashboard/ETATracker';
import ETANotification from '@/components/dashboard/ETANotification';
import RealTimeRouteOptimizer from '@/components/dashboard/RealTimeRouteOptimizer';

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
  topOverlayHeight = 0,
}) {
  const mapResetKey = `${selectedDriverId}-${selectedDateStr}`;
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

      <div className="absolute inset-0">
        <DeliveryMap
          key={mapResetKey}
          deliveries={deliveriesWithStopOrder}
          allDeliveriesForDate={deliveries}
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
          onMapInteraction={() => {}}
          onDoubleTap={() => {
            const nextCard = deliveriesWithStopOrder.find((d) => d && d.isNextDelivery === true);
            if (nextCard?.id) {
              window.dispatchEvent(new CustomEvent('centerStopCard', { detail: { deliveryId: nextCard.id } }));
            }
          }}
          retractClustersRef={retractClustersRef}
          areStopCardsVisible={deliveriesWithStopOrder.length > 0}
          highlightedDeliveryId={highlightedCardId}
          stopCardsHeight={stopCardsBaseHeight}
          mapViewPhase={1}
          isMapViewLocked={false}
          topOverlayHeight={topOverlayHeight}
          onMapReady={() => {
            if (!renderSequence.mapMarkers) {
              setRenderSequence(prev => ({ ...prev, mapMarkers: true, routeLines: true, driverLiveLocation: true, sharedLocations: true }));
            }
          }} />
      </div>
    </>
  );
}