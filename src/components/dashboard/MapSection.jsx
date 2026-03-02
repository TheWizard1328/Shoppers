import { format } from 'date-fns';
import { isAppOwner } from '@/components/utils/userRoles';
import DeliveryMap from "@/components/dashboard/DeliveryMap";
import DashboardOfflineSync from '@/components/dashboard/DashboardOfflineSync';
import ETATracker from '@/components/dashboard/ETATracker';
import ETANotification from '@/components/dashboard/ETANotification';
import RealTimeRouteOptimizer from '@/components/dashboard/RealTimeRouteOptimizer';

export default function MapSection({
  currentUser, isDriver, isDispatcher, isMobile,
  deliveries, patients, stores, drivers, filteredDeliveries, deliveriesWithStopOrder,
  selectedDate, selectedDateStr, selectedDriverId,
  mapCenter, mapZoom, shouldFitBounds, setShouldFitBounds, setMapCenter, setMapZoom,
  mapMode, setMapMode, driverLocation, allDriverLocations, currentToNextPolyline,
  showRoutes, showAllDriverMarkers, showBreadcrumbs, breadcrumbsData,
  highlightedCardId, retractClustersRef, googleApiKey,
  setDriverRoutes, renderSequence, setRenderSequence,
  stopCardsBaseHeight, handleMarkerClick, handleCardInteraction,
  areCardsVisible, handleMapViewCycle, isStatsCardCentered,
  dailyPolylineCount, isExpanded,
  realTimeETAEnabled, showDeliveryForm, showPatientForm, showOptimizationSettings,
}) {
  return (
    <>
      {currentUser && isAppOwner(currentUser) &&
        <div className="absolute left-4 z-[140]" style={{ bottom: `${(deliveriesWithStopOrder.length > 0 ? stopCardsBaseHeight : 0) + 15}px` }}>
          <div className="px-2 py-1 text-xs font-medium rounded-lg border" style={{ background: 'transparent', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-600)' }}>
            🛣️ {dailyPolylineCount ?? '...'}
          </div>
        </div>
      }

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
          deliveries={deliveriesWithStopOrder}
          selectedDriverId={selectedDriverId}
          selectedDate={format(selectedDate, 'yyyy-MM-dd')}
          patients={patients}
          stores={stores}
          users={drivers}
          currentUser={currentUser}
          driverLocations={allDriverLocations}
          deliveriesForLocationFilter={filteredDeliveries}
          showOtherDriverDeliveries={showAllDriverMarkers}
          currentDriverLocation={driverLocation}
          currentToNextPolyline={currentToNextPolyline}
          showBreadcrumbs={showBreadcrumbs}
          breadcrumbsData={breadcrumbsData}
          center={mapCenter}
          zoom={mapZoom}
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
          googleApiKey={googleApiKey}
          onDriverRoutesCalculated={setDriverRoutes}
          onMapInteraction={(isUser) => { if (isUser) {} }}
          onDoubleTap={handleMapViewCycle}
          retractClustersRef={retractClustersRef}
          areStopCardsVisible={deliveriesWithStopOrder.length > 0}
          highlightedDeliveryId={highlightedCardId}
          stopCardsHeight={stopCardsBaseHeight}
          onMapReady={() => {
            if (!renderSequence.mapMarkers) {
              setRenderSequence(prev => ({ ...prev, mapMarkers: true, routeLines: true, driverLiveLocation: true, sharedLocations: true }));
            }
          }} />
      </div>
    </>
  );
}