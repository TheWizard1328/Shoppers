import React from 'react';
import { Marker, Popup, Circle } from 'react-leaflet';
import L from 'leaflet';
import { Clock, Home, MapPin, Truck } from 'lucide-react';
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
    const driverRouteStops = deliveryMarkers.filter((item) => item && item.driver_id === delivery.driver_id);
    const routeHasIncompleteStops = driverRouteStops.some((item) => item && !FINISHED_STATUSES.includes(item.status));
    const isSelectedRouteComplete = isSelectedDriverMarker && !routeHasIncompleteStops;
    const isRouteInProgress = isSelectedDriverMarker && routeHasIncompleteStops;
    const isUserHoveringFaded = fadedMarkerHighlights.has(delivery.id);
    // CRITICAL: isOtherDriver markers never fade (always visible even when route is complete)
    const isDeliveryFaded = isFinishedForFade && !isHighlighted && !isSelectedDriverMarker && !delivery.isOtherDriver;
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
      click: (e) => { L.DomEvent.stopPropagation(e); if (isDeliveryFaded) setFadedMarkerHighlights(prev => new Set([...prev, delivery.id])); handleMarkerClickForFanning(delivery, 'delivery'); },
      mouseover: (e) => { e.target.openPopup(); if (isDeliveryFaded || isDeliveryInProgressFade) setFadedMarkerHighlights(prev => new Set([...prev, delivery.id])); },
      mouseout: (e) => { e.target.closePopup(); setFadedMarkerHighlights(prev => { const n = new Set(prev); n.delete(delivery.id); return n; }); }
    } : delivery.useSimpleCircle ? {
      click: (e) => { L.DomEvent.stopPropagation(e); if (isDeliveryInProgressFade) setFadedMarkerHighlights(prev => new Set([...prev, delivery.id])); handleMarkerClickForFanning(delivery, 'delivery'); },
      mouseover: (e) => { if (isDeliveryInProgressFade) setFadedMarkerHighlights(prev => new Set([...prev, delivery.id])); },
      mouseout: (e) => { setFadedMarkerHighlights(prev => { const n = new Set(prev); n.delete(delivery.id); return n; }); }
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
              <div className="min-w-[240px] max-w-[320px]">
                <div className="font-semibold text-sm pb-1 mb-2 border-b" style={{ color: 'var(--text-slate-900)', borderColor: 'var(--border-slate-200)' }}>
                  {delivery.duplicateCount} stops at this location
                </div>
                {(() => {
                  const DONE = ['completed', 'failed', 'cancelled', 'returned'];
                  const lk = locationKey;
                  const all = [...(groupedPickupMarkers.get(lk) || []), ...(groupedDeliveryMarkers.get(lk) || [])]
                    .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

                  // Build ordered driver groups
                  const driverOrder = [];
                  const driverMap = {};
                  all.forEach((m) => {
                    const driverId = m.driver?.id || m.driver_id || 'unknown';
                    if (!driverMap[driverId]) {
                      driverOrder.push(driverId);
                      driverMap[driverId] = { driver: m.driver, storeOrder: [], storeMap: {} };
                    }
                    const storeId = m.store?.id || m.store_id || 'unknown';
                    if (!driverMap[driverId].storeMap[storeId]) {
                      driverMap[driverId].storeOrder.push(storeId);
                      driverMap[driverId].storeMap[storeId] = { store: m.store, stops: [] };
                    }
                    driverMap[driverId].storeMap[storeId].stops.push(m);
                  });

                  return driverOrder.map((driverId, dIdx) => {
                    const dGroup = driverMap[driverId];
                    return (
                      <div key={`dg-${driverId}`}>
                        {dIdx > 0 && (
                          <div className="border-t my-2" style={{ borderColor: 'var(--border-slate-200)' }} />
                        )}
                        {/* Driver row — shown once */}
                        <div className="flex items-center gap-1.5 text-xs font-semibold mb-1.5" style={{ color: 'var(--text-slate-900)' }}>
                          <Truck className="w-3.5 h-3.5 flex-shrink-0" />
                          <span>{dGroup.driver?.user_name || dGroup.driver?.full_name || 'Unknown Driver'}</span>
                        </div>

                        {dGroup.storeOrder.map((storeId) => {
                          const sg = dGroup.storeMap[storeId];
                          return (
                            <div key={`sg-${storeId}`} className="mb-1.5">
                              {/* Store row — shown once per store per driver */}
                              <div className="flex items-center gap-1.5 text-[11px] mb-1 pl-1" style={{ color: 'var(--text-slate-600)' }}>
                                <Home className="w-3 h-3 flex-shrink-0" />
                                <span className="truncate font-medium">{sg.store?.name || 'Store'}</span>
                              </div>

                              {/* Stop rows: Pin | Stop# | Name | Time */}
                              {sg.stops.map((m) => {
                                const isDone = DONE.includes(m.status);
                                const stopNum = m.number || m.stop_order || '?';
                                const name = m.markerType === 'pickup' ? 'Store Pickup' : (m.patient?.full_name || 'Patient');
                                const timeLabel = isDone
                                  ? (m.actual_delivery_time ? new Date(m.actual_delivery_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : null)
                                  : (m.delivery_time_eta || null);
                                const timeColor = m.status === 'completed' ? 'text-emerald-600'
                                  : (m.status === 'failed' || m.status === 'cancelled') ? 'text-red-600'
                                  : m.status === 'returned' ? 'text-orange-600' : '';

                                return (
                                  <div
                                    key={`stop-${driverId}-${storeId}-${m.id}-${m.stop_order || 'na'}`}
                                    className="flex items-center justify-between gap-2 text-[11px] py-0.5 pl-1 cursor-pointer rounded hover:bg-slate-50"
                                    onClick={() => {
                                      document.querySelectorAll('.leaflet-popup').forEach((p) => p.remove());
                                      document.getElementById(`stop-card-${m.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                                    }}
                                  >
                                    <div className="flex min-w-0 items-center gap-1" style={{ color: 'var(--text-slate-900)' }}>
                                      <MapPin className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--text-slate-500)' }} />
                                      <span className="shrink-0 font-medium" style={{ color: 'var(--text-slate-500)', fontFamily: 'Courier New, monospace' }}>#{String(stopNum).padStart(2, '0')}</span>
                                      <span className="truncate">{name}</span>
                                    </div>
                                    {timeLabel && (
                                      <div className={`shrink-0 flex items-center gap-1 ${timeColor}`}>
                                        <Clock className="w-3 h-3 flex-shrink-0" />
                                        <span>{timeLabel}</span>
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })}
                      </div>
                    );
                  });
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
            <div className="min-w-[240px] max-w-[320px]">
              {isClustered && !isFanned ? (() => {
                const DONE = ['completed', 'failed', 'cancelled', 'returned'];
                const all = [...(groupedPickupMarkers.get(locationKey) || []), ...(groupedDeliveryMarkers.get(locationKey) || [])]
                  .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
                const driverOrder = [];
                const driverMap = {};
                all.forEach((m) => {
                  const driverId = m.driver?.id || m.driver_id || 'unknown';
                  if (!driverMap[driverId]) { driverOrder.push(driverId); driverMap[driverId] = { driver: m.driver, storeOrder: [], storeMap: {} }; }
                  const storeId = m.store?.id || m.store_id || 'unknown';
                  if (!driverMap[driverId].storeMap[storeId]) { driverMap[driverId].storeOrder.push(storeId); driverMap[driverId].storeMap[storeId] = { store: m.store, stops: [] }; }
                  driverMap[driverId].storeMap[storeId].stops.push(m);
                });
                return (
                  <>
                    <div className="font-semibold text-sm pb-1 mb-2 border-b" style={{ color: 'var(--text-slate-900)', borderColor: 'var(--border-slate-200)' }}>
                      {delivery.duplicateCount} stops at this location
                    </div>
                    {driverOrder.map((driverId, dIdx) => {
                      const dGroup = driverMap[driverId];
                      return (
                        <div key={`dg-${driverId}`}>
                          {dIdx > 0 && <div className="border-t my-2" style={{ borderColor: 'var(--border-slate-200)' }} />}
                          <div className="flex items-center gap-1.5 text-xs font-semibold mb-1.5" style={{ color: 'var(--text-slate-900)' }}>
                            <Truck className="w-3.5 h-3.5 flex-shrink-0" />
                            <span>{dGroup.driver?.user_name || dGroup.driver?.full_name || 'Unknown Driver'}</span>
                          </div>
                          {dGroup.storeOrder.map((storeId) => {
                            const sg = dGroup.storeMap[storeId];
                            return (
                              <div key={`sg-${storeId}`} className="mb-1.5">
                                <div className="flex items-center gap-1.5 text-[11px] mb-1 pl-1" style={{ color: 'var(--text-slate-600)' }}>
                                  <Home className="w-3 h-3 flex-shrink-0" />
                                  <span className="truncate font-medium">{sg.store?.name || 'Store'}</span>
                                </div>
                                {sg.stops.map((m) => {
                                  const isDone = DONE.includes(m.status);
                                  const stopNum = m.number || m.stop_order;
                                  const name = m.markerType === 'pickup' ? 'Store Pickup' : (m.patient?.full_name || 'Patient');
                                  const timeLabel = isDone
                                    ? (m.actual_delivery_time ? new Date(m.actual_delivery_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : null)
                                    : (m.delivery_time_eta || null);
                                  const timeColor = m.status === 'completed' ? 'text-emerald-600' : (m.status === 'failed' || m.status === 'cancelled') ? 'text-red-600' : m.status === 'returned' ? 'text-orange-600' : '';
                                  return (
                                    <div key={`stop-${driverId}-${storeId}-${m.id}-${m.stop_order || 'na'}`} className="flex items-center justify-between gap-2 text-[11px] py-0.5 pl-1">
                                      <div className="flex min-w-0 items-center gap-1" style={{ color: 'var(--text-slate-900)' }}>
                                        <MapPin className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--text-slate-500)' }} />
                                        <span className="shrink-0 font-medium" style={{ color: 'var(--text-slate-500)', fontFamily: 'Courier New, monospace' }}>#{stopNum != null ? String(stopNum).padStart(2, '0') : '??'}</span>
                                        <span className="truncate">{name}</span>
                                      </div>
                                      {timeLabel && (
                                        <div className={`shrink-0 flex items-center gap-1 ${timeColor}`}>
                                          <Clock className="w-3 h-3 flex-shrink-0" />
                                          <span>{timeLabel}</span>
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </>
                );
              })() : (
                <MarkerInfoBalloon delivery={delivery} store={delivery.store} patient={null} driver={delivery.driver} />
              )}
            </div>
          </Popup>
        )}
      </Marker>
    ];
  });
}