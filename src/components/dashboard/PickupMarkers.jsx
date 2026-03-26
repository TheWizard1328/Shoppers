import React from 'react';
import { Marker, Popup, Circle } from 'react-leaflet';
import L from 'leaflet';
import { format } from 'date-fns';
import { Truck, Home, User, CheckCircle2, XCircle, Clock, MapPin } from 'lucide-react';
import DeliveryPopup from './DeliveryPopup';
import MarkerInfoBalloon from './MarkerInfoBalloon';
import { createSimpleCircleIcon, createStoreIcon } from './MapIcons';

const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'];

export default function PickupMarkers({
  pickupMarkers, groupedPickupMarkers, groupedDeliveryMarkers,
  routeRenderKey, currentZoom, ZOOM_LEVELS, isMobile,
  fannedLocationKey, highlightedDeliveryId,
  fadedMarkerHighlights, setFadedMarkerHighlights,
  driversWithCompleteRoute, hasIncompleteStops,
  calculateFannedPositionWrapperWrapper,
  onMarkerClick, handleMarkerClickForFanning, handleMarkerDragEnd,
  markerRefs, safeStores, safePatients, safeUsers,
}) {
  return pickupMarkers.map((pickup) => {
    const lk = `${pickup.latitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)},${pickup.longitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)}`;
    const isClustered = pickup.duplicateCount > 1;
    const isFanned = fannedLocationKey === lk;
    const isHighlighted = highlightedDeliveryId === pickup.id;

    const isFinishedForFade = FINISHED_STATUSES.includes(pickup.status);
    const isSelectedDriverMarker = !pickup.isOtherDriver;
    const isSelectedRouteComplete = isSelectedDriverMarker && driversWithCompleteRoute.has(pickup.driver_id);
    const isRouteInProgress = !driversWithCompleteRoute.has(pickup.driver_id) && hasIncompleteStops;
    const isUserHoveringFaded = fadedMarkerHighlights.has(pickup.id);
    const isPickupFaded = isFinishedForFade && !isHighlighted && !isSelectedRouteComplete && !isSelectedDriverMarker;
    const isPickupInProgressFade = isFinishedForFade && isSelectedDriverMarker && !isSelectedRouteComplete && isRouteInProgress;
    const isPickupHighlightedFinished = (isPickupFaded || isPickupInProgressFade) && (isHighlighted || isUserHoveringFaded);

    let markerPosition = [pickup.latitude, pickup.longitude];
    let dynamicZIndex;
    const isFinished = FINISHED_STATUSES.includes(pickup.status);
    const isPending = pickup.status === 'pending';
    if (isPending) dynamicZIndex = 5000 + (500 - (pickup.number || 500));
    else if (isFinished) dynamicZIndex = 100 + (500 - (pickup.number || 500));
    else dynamicZIndex = 1000 + (500 - (pickup.number || 500));

    if (isFanned && isClustered) {
      const all = [...(groupedPickupMarkers.get(lk)||[]), ...(groupedDeliveryMarkers.get(lk)||[])].sort((a,b)=>(a.stop_order||0)-(b.stop_order||0));
      const clusterIndex = all.findIndex(p => p.id === pickup.id);
      markerPosition = calculateFannedPositionWrapperWrapper(pickup.latitude, pickup.longitude, clusterIndex, all.length, pickup.stop_order);
      const incomplete = all.filter(p => !FINISHED_STATUSES.includes(p.status));
      if (isFinished) dynamicZIndex = 2000 - all.length - clusterIndex;
      else { const ii = incomplete.findIndex(p => p.id === pickup.id); dynamicZIndex = 3000 + (incomplete.length - ii); }
    }

    const icon = pickup.useSimpleCircle
      ? createSimpleCircleIcon(pickup.status, pickup.status === 'pending' ? null : pickup.number, currentZoom, isMobile, pickup.pinColor, pickup.isOtherDriver, pickup.duplicateCount, pickup.isNextDelivery, isPickupFaded || isPickupInProgressFade, isPickupHighlightedFinished)
      : createStoreIcon(pickup.status, pickup.pinColor, isFanned, pickup.status === 'pending' ? null : pickup.number, currentZoom, pickup.duplicateCount, isMobile, isHighlighted, pickup.isNextDelivery, hasIncompleteStops, false, isPickupFaded || isPickupInProgressFade, isPickupHighlightedFinished, pickup.after_hours_pickup === true);

    const handlers = pickup.isOtherDriver ? {
      click: (e) => { L.DomEvent.stopPropagation(e); if (isPickupFaded) setFadedMarkerHighlights(prev => new Set([...prev, pickup.id])); handleMarkerClickForFanning(pickup, 'pickup'); },
      mouseover: (e) => { if (isPickupFaded || isPickupInProgressFade) setFadedMarkerHighlights(prev => new Set([...prev, pickup.id])); },
      mouseout: (e) => { setFadedMarkerHighlights(prev => { const n = new Set(prev); n.delete(pickup.id); return n; }); }
    } : pickup.useSimpleCircle ? {
      click: (e) => { L.DomEvent.stopPropagation(e); if (isPickupInProgressFade) setFadedMarkerHighlights(prev => new Set([...prev, pickup.id])); },
      mouseover: (e) => { e.target.openPopup(); if (isPickupInProgressFade) setFadedMarkerHighlights(prev => new Set([...prev, pickup.id])); },
      mouseout: (e) => { e.target.closePopup(); setFadedMarkerHighlights(prev => { const n = new Set(prev); n.delete(pickup.id); return n; }); }
    } : {
      click: (e) => { L.DomEvent.stopPropagation(e); if (isPickupInProgressFade) setFadedMarkerHighlights(prev => new Set([...prev, pickup.id])); if (isFanned && onMarkerClick) onMarkerClick(pickup); else handleMarkerClickForFanning(pickup, 'pickup'); },
      mouseover: (e) => { e.target.openPopup(); if (isPickupInProgressFade) setFadedMarkerHighlights(prev => new Set([...prev, pickup.id])); },
      mouseout: (e) => { e.target.closePopup(); setFadedMarkerHighlights(prev => { const n = new Set(prev); n.delete(pickup.id); return n; }); },
      dragend: (e) => handleMarkerDragEnd(pickup.id, e, 'pickup')
    };

    const isDark = document.documentElement.classList.contains('dark-theme') || (document.documentElement.classList.contains('auto-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);

    return [
      !isFanned && <Circle key={`pickup-circle-${pickup.id}`} center={[pickup.latitude, pickup.longitude]} radius={2500} pathOptions={{ color: pickup.pinColor, fillColor: 'transparent', fillOpacity: 0, weight: 2, opacity: isDark ? 0.4 : 0.2 }} />,
      isHighlighted && !isFanned && <Circle key={`pickup-halo-${pickup.id}`} center={[pickup.latitude, pickup.longitude]} radius={40} pathOptions={{ color: pickup.pinColor, fillColor: 'transparent', fillOpacity: 0, weight: 2, opacity: 0.9, className: 'pulsating-halo' }} />,
      <Marker key={`pickup-${pickup.id}`} position={markerPosition} icon={icon} zIndexOffset={dynamicZIndex} draggable={!pickup.useSimpleCircle && !pickup.isOtherDriver && isFanned} eventHandlers={handlers} ref={(ref) => { if (ref) markerRefs.current[`pickup-${pickup.id}`] = ref; }}>
        {!pickup.useSimpleCircle && !pickup.isOtherDriver && (isClustered && !isFanned ? (
          <Popup autoPan={false} closeButton={false} offset={[0,-20]} className="custom-popup">
            <div className="min-w-[240px] max-w-[320px]">
              <div className="font-semibold text-sm pb-1 mb-2 border-b" style={{color:'var(--text-slate-900)',borderColor:'var(--border-slate-200)'}}>{pickup.duplicateCount} stops at this location</div>
              {(() => {
                const DONE = ['completed', 'failed', 'cancelled', 'returned'];
                const all = [...(groupedPickupMarkers.get(lk)||[]),...(groupedDeliveryMarkers.get(lk)||[])].sort((a,b)=>(a.stop_order||0)-(b.stop_order||0));

                // Build ordered driver groups → store groups
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
                      {dIdx > 0 && <div className="border-t my-2" style={{borderColor:'var(--border-slate-200)'}} />}
                      {/* Driver — shown once */}
                      <div className="flex items-center gap-1.5 text-xs font-semibold mb-1.5" style={{color:'var(--text-slate-900)'}}>
                        <Truck className="w-3.5 h-3.5 flex-shrink-0" />
                        <span>{dGroup.driver?.user_name || dGroup.driver?.full_name || 'Unknown Driver'}</span>
                      </div>
                      {dGroup.storeOrder.map((storeId) => {
                        const sg = dGroup.storeMap[storeId];
                        return (
                          <div key={`sg-${storeId}`} className="mb-1.5">
                            {/* Store — shown once per store */}
                            <div className="flex items-center gap-1.5 text-[11px] mb-1 pl-1" style={{color:'var(--text-slate-600)'}}>
                              <Home className="w-3 h-3 flex-shrink-0" />
                              <span className="truncate font-medium">{sg.store?.name || 'Store'}</span>
                            </div>
                            {/* Stops: Pin | Stop# | Name | Time */}
                            {sg.stops.map((m) => {
                              const isDone = DONE.includes(m.status);
                              const stopNum = m.number || m.stop_order || '?';
                              const name = m.markerType === 'pickup' ? 'Store Pickup' : (m.patient?.full_name || 'Patient');
                              const timeLabel = isDone
                                ? (m.actual_delivery_time ? new Date(m.actual_delivery_time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',hour12:false}) : null)
                                : (m.delivery_time_eta || null);
                              const timeColor = m.status === 'completed' ? 'text-emerald-600'
                                : (m.status === 'failed' || m.status === 'cancelled') ? 'text-red-600'
                                : m.status === 'returned' ? 'text-orange-600' : '';
                              return (
                                <div
                                  key={`stop-${m.id}`}
                                  className="flex items-center justify-between gap-2 text-[11px] py-0.5 pl-1 cursor-pointer rounded hover:bg-slate-50"
                                  onClick={() => { document.querySelectorAll('.leaflet-popup').forEach(p=>p.remove()); document.getElementById(`stop-card-${m.id}`)?.scrollIntoView({behavior:'smooth',block:'nearest',inline:'center'}); }}
                                >
                                  <div className="flex min-w-0 items-center gap-1" style={{color:'var(--text-slate-900)'}}>
                                    <MapPin className="w-3 h-3 flex-shrink-0" style={{color:'var(--text-slate-500)'}} />
                                    <span className="shrink-0 font-medium" style={{color:'var(--text-slate-500)', fontFamily:'Courier New, monospace'}}>#{String(stopNum).padStart(2, '0')}</span>
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
        ) : (<Popup autoPan={false} closeButton={false} offset={[0,-20]} className="custom-popup"><DeliveryPopup delivery={pickup} isPickup={true} stores={safeStores} patients={safePatients} users={safeUsers}/></Popup>))}
        {pickup.useSimpleCircle && !pickup.isOtherDriver && (
          <Popup autoPan={false} closeButton={false} offset={[0,-10]} className="custom-popup">
            <div className="min-w-[220px] max-w-[320px]">
              <MarkerInfoBalloon delivery={pickup} store={pickup.store} patient={null} driver={pickup.driver} isPickup={true} />
            </div>
          </Popup>
        )}
        {pickup.isOtherDriver && (
          <Popup autoPan={false} closeButton={false} offset={[0,-20]} className="custom-popup">
            <div className="min-w-[240px] max-w-[320px]">
              {isClustered && !isFanned ? (() => {
                const DONE = ['completed', 'failed', 'cancelled', 'returned'];
                const all = [...(groupedPickupMarkers.get(lk) || []), ...(groupedDeliveryMarkers.get(lk) || [])]
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
                    <div className="font-semibold text-sm pb-1 mb-2 border-b" style={{color:'var(--text-slate-900)',borderColor:'var(--border-slate-200)'}}>
                      {pickup.duplicateCount} stops at this location
                    </div>
                    {driverOrder.map((driverId, dIdx) => {
                      const dGroup = driverMap[driverId];
                      return (
                        <div key={`dg-${driverId}`}>
                          {dIdx > 0 && <div className="border-t my-2" style={{borderColor:'var(--border-slate-200)'}} />}
                          <div className="flex items-center gap-1.5 text-xs font-semibold mb-1.5" style={{color:'var(--text-slate-900)'}}>
                            <Truck className="w-3.5 h-3.5 flex-shrink-0" />
                            <span>{dGroup.driver?.user_name || dGroup.driver?.full_name || 'Unknown Driver'}</span>
                          </div>
                          {dGroup.storeOrder.map((storeId) => {
                            const sg = dGroup.storeMap[storeId];
                            return (
                              <div key={`sg-${storeId}`} className="mb-1.5">
                                <div className="flex items-center gap-1.5 text-[11px] mb-1 pl-1" style={{color:'var(--text-slate-600)'}}>
                                  <Home className="w-3 h-3 flex-shrink-0" />
                                  <span className="truncate font-medium">{sg.store?.name || 'Store'}</span>
                                </div>
                                {sg.stops.map((m) => {
                                  const isDone = DONE.includes(m.status);
                                  const stopNum = m.number || m.stop_order;
                                  const name = m.markerType === 'pickup' ? 'Store Pickup' : (m.patient?.full_name || 'Patient');
                                  const timeLabel = isDone
                                    ? (m.actual_delivery_time ? new Date(m.actual_delivery_time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',hour12:false}) : null)
                                    : (m.delivery_time_eta || null);
                                  const timeColor = m.status === 'completed' ? 'text-emerald-600' : (m.status === 'failed' || m.status === 'cancelled') ? 'text-red-600' : m.status === 'returned' ? 'text-orange-600' : '';
                                  return (
                                    <div key={`stop-${m.id}`} className="flex items-center justify-between gap-2 text-[11px] py-0.5 pl-1">
                                      <div className="flex min-w-0 items-center gap-1" style={{color:'var(--text-slate-900)'}}>
                                        <MapPin className="w-3 h-3 flex-shrink-0" style={{color:'var(--text-slate-500)'}} />
                                        <span className="shrink-0 font-medium" style={{color:'var(--text-slate-500)',fontFamily:'Courier New, monospace'}}>#{stopNum != null ? String(stopNum).padStart(2, '0') : '??'}</span>
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
                <MarkerInfoBalloon delivery={pickup} store={pickup.store} patient={null} driver={pickup.driver} isPickup={true} />
              )}
            </div>
          </Popup>
        )}
      </Marker>
    ];
  });
}