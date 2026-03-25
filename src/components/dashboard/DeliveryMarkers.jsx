import React from 'react';
import { Marker, Popup, Circle } from 'react-leaflet';
import L from 'leaflet';
import DeliveryPopup from './DeliveryPopup';
import MarkerInfoBalloon from './MarkerInfoBalloon';
import { createSimpleCircleIcon, createDeliveryIcon } from './MapIcons';

const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'];

export default function DeliveryMarkers({
  deliveryMarkers,
  groupedDeliveryMarkers,
  groupedPickupMarkers,
  routeRenderKey,
  currentZoom,
  ZOOM_LEVELS,
  isMobile,
  fannedLocationKey,
  setFannedLocationKey,
  highlightedDeliveryId,
  fadedMarkerHighlights,
  setFadedMarkerHighlights,
  driversWithCompleteRoute,
  hasIncompleteStops,
  calculateFannedPositionWrapperWrapper,
  onMarkerClick,
  handleMarkerClickForFanning,
  handleMarkerDragEnd,
  markerRefs,
  safeStores,
  safePatients,
  safeUsers,
  stores,
}) {
  const [gpsOverrides, setGpsOverrides] = React.useState({});

  React.useEffect(() => {
    const handlePatientGpsUpdated = (event) => {
      const patientId = event?.detail?.patientId;
      const latitude = Number(event?.detail?.latitude);
      const longitude = Number(event?.detail?.longitude);
      if (!patientId || Number.isNaN(latitude) || Number.isNaN(longitude)) return;
      setGpsOverrides((prev) => ({
        ...prev,
        [patientId]: { latitude, longitude }
      }));
    };

    window.addEventListener('patientGpsUpdated', handlePatientGpsUpdated);
    return () => window.removeEventListener('patientGpsUpdated', handlePatientGpsUpdated);
  }, []);

  return deliveryMarkers.map((delivery) => {
    const gpsOverride = delivery?.patient_id ? gpsOverrides[delivery.patient_id] : null;
    const markerLatitude = gpsOverride?.latitude ?? delivery.latitude;
    const markerLongitude = gpsOverride?.longitude ?? delivery.longitude;
    const locationKey = `${markerLatitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)},${markerLongitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)}`;
    const isClustered = delivery.duplicateCount > 1;
    const isFanned = fannedLocationKey === locationKey;
    const isHighlighted = highlightedDeliveryId === delivery.id;

    const isFinishedForFade = FINISHED_STATUSES.includes(delivery.status);
    const isSelectedDriverMarker = !delivery.isOtherDriver;
    const isSelectedRouteComplete = isSelectedDriverMarker && driversWithCompleteRoute.has(delivery.driver_id);
    const isRouteInProgress = !driversWithCompleteRoute.has(delivery.driver_id) && hasIncompleteStops;
    const isUserHoveringFaded = fadedMarkerHighlights.has(delivery.id);
    const isDeliveryFaded = isFinishedForFade && !isHighlighted && !isSelectedRouteComplete && !isSelectedDriverMarker;
    const isDeliveryInProgressFade = isFinishedForFade && isSelectedDriverMarker && !isSelectedRouteComplete && isRouteInProgress;
    const isDeliveryHighlightedFinished = (isDeliveryFaded || isDeliveryInProgressFade) && (isHighlighted || isUserHoveringFaded);

    let markerPosition = [markerLatitude, markerLongitude];
    let dynamicZIndex;
    const isFinished = FINISHED_STATUSES.includes(delivery.status);
    const isNext = delivery.isNextInLine;
    const isPending = delivery.status === 'pending';

    if (isPending) dynamicZIndex = 5000 + (500 - (delivery.number || 500));
    else if (isFinished) dynamicZIndex = 100 + (500 - (delivery.number || 500));
    else dynamicZIndex = 1000 + (500 - (delivery.number || 500));
    if (isNext && !isPending) dynamicZIndex = 2000;

    if (isFanned && isClustered) {
      const pickupsAtLocation = groupedPickupMarkers.get(locationKey) || [];
      const deliveriesAtLocation = groupedDeliveryMarkers.get(locationKey) || [];
      const allMarkersAtLocation = [...pickupsAtLocation, ...deliveriesAtLocation]
        .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
      const clusterIndex = allMarkersAtLocation.findIndex(d => d && d.id === delivery.id);
      markerPosition = calculateFannedPositionWrapperWrapper(markerLatitude, markerLongitude, clusterIndex, allMarkersAtLocation.length, delivery.stop_order);
      const incompleteMarkers = allMarkersAtLocation.filter(d => !FINISHED_STATUSES.includes(d.status));
      if (isFinished) dynamicZIndex = 2000 - allMarkersAtLocation.length - clusterIndex;
      else { const incIdx = incompleteMarkers.findIndex(d => d.id === delivery.id); dynamicZIndex = 3000 + (incompleteMarkers.length - incIdx); }
    }

    const icon = delivery.useSimpleCircle || delivery.isOtherDriver
      ? createSimpleCircleIcon(delivery.isReturn ? 'returned' : delivery.status, delivery.status === 'pending' ? null : delivery.number, currentZoom, isMobile, delivery.pinColor, true, delivery.duplicateCount, delivery.isNextInLine, isDeliveryFaded || isDeliveryInProgressFade, isDeliveryHighlightedFinished)
      : createDeliveryIcon(delivery.status, delivery.pinColor, isFanned, delivery.status === 'pending' ? null : delivery.number, delivery.isFirstTime, delivery.duplicateCount, currentZoom, isMobile, delivery.isNextInLine, isHighlighted, hasIncompleteStops, delivery.ampm_deliveries === 'PM', delivery.isOtherDriver, delivery.isReturn, isDeliveryFaded || isDeliveryInProgressFade, isDeliveryHighlightedFinished);

    const handlers = delivery.isOtherDriver ? {
      click: (e) => { L.DomEvent.stopPropagation(e); if (isDeliveryFaded) setFadedMarkerHighlights(prev => new Set([...prev, delivery.id])); },
      mouseover: (e) => { e.target.openPopup(); if (isDeliveryFaded || isDeliveryInProgressFade) setFadedMarkerHighlights(prev => new Set([...prev, delivery.id])); },
      mouseout: (e) => { e.target.closePopup(); setFadedMarkerHighlights(prev => { const n = new Set(prev); n.delete(delivery.id); return n; }); }
    } : delivery.useSimpleCircle ? {
      click: (e) => { L.DomEvent.stopPropagation(e); if (isDeliveryInProgressFade) setFadedMarkerHighlights(prev => new Set([...prev, delivery.id])); },
      mouseover: (e) => { e.target.openPopup(); if (isDeliveryInProgressFade) setFadedMarkerHighlights(prev => new Set([...prev, delivery.id])); },
      mouseout: (e) => { e.target.closePopup(); setFadedMarkerHighlights(prev => { const n = new Set(prev); n.delete(delivery.id); return n; }); }
    } : {
      click: (e) => { L.DomEvent.stopPropagation(e); if (isDeliveryInProgressFade) setFadedMarkerHighlights(prev => new Set([...prev, delivery.id])); if (isFanned && onMarkerClick) onMarkerClick(delivery); else handleMarkerClickForFanning(delivery, 'delivery'); },
      mouseover: (e) => { e.target.openPopup(); if (isDeliveryInProgressFade) setFadedMarkerHighlights(prev => new Set([...prev, delivery.id])); },
      mouseout: (e) => { e.target.closePopup(); setFadedMarkerHighlights(prev => { const n = new Set(prev); n.delete(delivery.id); return n; }); },
      dragend: (e) => handleMarkerDragEnd(delivery.id, e, 'delivery')
    };

    return [
      isHighlighted && !isFanned && <Circle key={`delivery-halo-${delivery.id}`} center={[markerLatitude, markerLongitude]} radius={40} pathOptions={{ color: delivery.pinColor, fillColor: 'transparent', fillOpacity: 0, weight: 2, opacity: 0.9, className: 'pulsating-halo' }} />,
      isHighlighted && !isFanned && delivery.store_id && (() => {
        const deliveryStore = stores.find(s => s?.id === delivery.store_id);
        if (!deliveryStore?.latitude || !deliveryStore?.longitude) return null;
        return <Circle key={`delivery-store-halo-${delivery.id}`} center={[deliveryStore.latitude, deliveryStore.longitude]} radius={40} pathOptions={{ color: delivery.pinColor, fillColor: 'transparent', fillOpacity: 0, weight: 2, opacity: 0.9, className: 'pulsating-halo' }} />;
      })(),
      <Marker
        key={`delivery-${delivery.id}`}
        position={markerPosition}
        icon={icon}
        zIndexOffset={dynamicZIndex}
        draggable={!delivery.useSimpleCircle && !delivery.isOtherDriver && isFanned}
        eventHandlers={handlers}
        ref={(ref) => { if (ref) markerRefs.current[`delivery-${delivery.id}`] = ref; }}
      >
        {!delivery.useSimpleCircle && !delivery.isOtherDriver && (
          isClustered && !isFanned ? (
            <Popup autoPan={false} closeButton={false} offset={[0, -20]} className="custom-popup">
              <div className="min-w-[220px] max-w-[320px] space-y-2">
                <div className="font-semibold text-sm pb-1 border-b" style={{ color: 'var(--text-slate-900)', borderColor: 'var(--border-slate-200)' }}>{delivery.duplicateCount} stops at this location</div>
                {(() => {
                  const lk = locationKey;
                  const all = [...(groupedPickupMarkers.get(lk) || []), ...(groupedDeliveryMarkers.get(lk) || [])]
                    .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
                  return all.map((m) => (
                    <div key={`ci-${m.id}`} className="py-1.5 border-b last:border-0" style={{ borderColor: 'var(--border-slate-200)' }}>
                      <MarkerInfoBalloon
                        delivery={m}
                        store={m.store}
                        patient={m.patient}
                        driver={m.driver}
                        isPickup={m.markerType === 'pickup'}
                        compact
                        onClick={() => {
                          document.querySelectorAll('.leaflet-popup').forEach((p) => p.remove());
                          document.getElementById(`stop-card-${m.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                        }}
                      />
                    </div>
                  ));
                })()}
              </div>
            </Popup>
          ) : (
            <Popup autoPan={false} closeButton={false} offset={[0, -20]} className="custom-popup">
              <DeliveryPopup delivery={delivery} isPickup={false} stores={safeStores} patients={safePatients} users={safeUsers} driver={delivery.driver} />
            </Popup>
          )
        )}
        {delivery.useSimpleCircle && !delivery.isOtherDriver && (
          <Popup autoPan={false} closeButton={false} offset={[0, -10]} className="custom-popup">
            <div className="min-w-[220px] max-w-[320px]">
              <MarkerInfoBalloon
                delivery={delivery}
                store={delivery.store}
                patient={delivery.patient}
                driver={delivery.driver}
                isPickup={!delivery.patient}
              />
            </div>
          </Popup>
        )}
        {delivery.isOtherDriver && (
          <Popup autoPan={false} closeButton={false} offset={[0, -20]} className="custom-popup">
            <div className="min-w-[220px] max-w-[320px] space-y-0">
              {isClustered && !isFanned && <div className="font-semibold text-sm pb-1 border-b mb-1" style={{ color: 'var(--text-slate-900)', borderColor: 'var(--border-slate-200)' }}>{delivery.duplicateCount} stops at this location</div>}
              <MarkerInfoBalloon
                delivery={delivery}
                store={delivery.store}
                patient={delivery.patient}
                driver={delivery.driver}
                compact={isClustered && !isFanned}
              />
            </div>
          </Popup>
        )}
      </Marker>
    ];
  });
}