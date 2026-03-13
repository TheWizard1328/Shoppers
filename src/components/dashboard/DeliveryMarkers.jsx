import React from 'react';
import { Marker, Popup, Circle } from 'react-leaflet';
import L from 'leaflet';
import { format } from 'date-fns';
import { Truck, Home, User, CheckCircle2, XCircle, Clock } from 'lucide-react';
import DeliveryPopup from './DeliveryPopup';
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
              <div className="min-w-[200px] max-w-[300px] space-y-2">
                <div className="font-semibold text-sm pb-1 border-b" style={{ color: 'var(--text-slate-900)', borderColor: 'var(--border-slate-200)' }}>{delivery.duplicateCount} stops at this location</div>
                {(() => {
                  const lk = locationKey;
                  const all = [...(groupedPickupMarkers.get(lk)||[]), ...(groupedDeliveryMarkers.get(lk)||[])].sort((a,b)=>(a.stop_order||0)-(b.stop_order||0));
                  const firstIncomplete = all.find(m => !FINISHED_STATUSES.includes(m.status));
                  return all.map((m) => {
                    const fin = FINISHED_STATUSES.includes(m.status);
                    const ft = m.actual_delivery_time ? format(new Date(m.actual_delivery_time), 'HH:mm') : null;
                    const name = m.markerType === 'pickup' ? 'Store Pickup' : (m.patient?.full_name || 'Patient');
                    return (
                      <div key={`ci-${m.id}`} className="text-xs py-1.5 border-b last:border-0 cursor-pointer hover:bg-slate-50 px-1 -mx-1 rounded space-y-0.5" style={{ borderColor: 'var(--border-slate-200)' }} onClick={() => { document.querySelectorAll('.leaflet-popup').forEach(p=>p.remove()); document.getElementById(`stop-card-${m.id}`)?.scrollIntoView({behavior:'smooth',block:'nearest',inline:'center'}); }}>
                        <div className="flex items-center gap-1.5 font-medium" style={{color:'var(--text-slate-900)'}}><Truck className="w-3.5 h-3.5"/>{m.driver?.user_name||'Unknown'}</div>
                        <div className="flex items-center gap-1.5 text-[11px]" style={{color:'var(--text-slate-600)'}}><Home className="w-3.5 h-3.5"/>{m.store?.name||'Store'}</div>
                        {fin && ft ? <div className="flex items-center justify-between text-[11px]"><span style={{color:'var(--text-slate-900)'}}>{name}</span><span className="text-emerald-600">{ft}</span></div>
                          : m.delivery_time_eta ? <div className="flex items-center justify-between text-[11px]"><span style={{color:'var(--text-slate-900)'}}>{name}</span><span style={{color:'var(--text-slate-600)'}}>ETA: {m.delivery_time_eta}</span></div>
                          : <div className="text-[11px]" style={{color:'var(--text-slate-900)'}}>{name}</div>}
                      </div>
                    );
                  });
                })()}
              </div>
            </Popup>
          ) : (
            <Popup autoPan={false} closeButton={false} offset={[0, -20]} className="custom-popup">
              <DeliveryPopup delivery={delivery} isPickup={false} stores={safeStores} patients={safePatients} users={safeUsers} />
            </Popup>
          )
        )}
        {delivery.useSimpleCircle && !delivery.isOtherDriver && (
          <Popup autoPan={false} closeButton={false} offset={[0, -10]} className="custom-popup">
            <div className="min-w-[150px] space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold" style={{color:'var(--text-slate-900)'}}><Home className="w-3.5 h-3.5"/>{delivery.store?.name||'Store'}</div>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${delivery.status==='completed'?'text-emerald-700 bg-emerald-100':delivery.status==='failed'||delivery.status==='cancelled'?'text-red-700 bg-red-100':delivery.status==='in_transit'?'text-blue-700 bg-blue-100':'text-slate-600 bg-slate-100'}`}>{delivery.status}</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs" style={{color:'var(--text-slate-600)'}}><Truck className="w-3.5 h-3.5"/>{delivery.driver?.user_name||'Unknown Driver'}</div>
              {FINISHED_STATUSES.includes(delivery.status) && delivery.actual_delivery_time ? <div className="flex items-center gap-1 text-xs text-emerald-600"><Clock className="w-3.5 h-3.5"/>{format(new Date(delivery.actual_delivery_time),'HH:mm')}</div> : delivery.delivery_time_eta ? <div className="flex items-center gap-1 text-xs" style={{color:'var(--text-slate-600)'}}>ETA: {delivery.delivery_time_eta}</div> : null}
            </div>
          </Popup>
        )}
        {delivery.isOtherDriver && (
          <Popup autoPan={false} closeButton={false} offset={[0, -20]} className="custom-popup">
            <div className="min-w-[200px] max-w-[300px] space-y-0">
              {isClustered && !isFanned && <div className="font-semibold text-sm pb-1 border-b mb-1" style={{color:'var(--text-slate-900)',borderColor:'var(--border-slate-200)'}}>{delivery.duplicateCount} stops at this location</div>}
              <div className="px-1 pt-1 pb-1.5 space-y-0.5">
                <div className="flex items-center gap-1.5 font-medium text-xs" style={{color:'var(--text-slate-900)'}}><Truck className="w-3.5 h-3.5 flex-shrink-0"/>{delivery.driver?.user_name||'Unknown'}</div>
                <div className="flex items-center gap-1.5 text-[11px]" style={{color:'var(--text-slate-600)'}}><Home className="w-3.5 h-3.5 flex-shrink-0"/>{delivery.store?.name||'Store'}</div>
              </div>
              <div className="border-b" style={{borderColor:'var(--border-slate-200)'}}/>
              <div className="px-1 py-1.5">
                {(() => {
                  const fin = FINISHED_STATUSES.includes(delivery.status);
                  const fail = delivery.status==='failed'||delivery.status==='cancelled';
                  const ft = delivery.actual_delivery_time ? format(new Date(delivery.actual_delivery_time),'HH:mm') : null;
                  return <div className="text-xs flex items-center justify-between"><div className="flex items-center gap-1.5" style={{color:'var(--text-slate-900)'}}><User className="w-3 h-3 flex-shrink-0"/><span>{delivery.patient?.full_name||'Patient'}</span></div><div className="flex items-center gap-1">{fin&&ft?<><span className="text-emerald-600">{ft}</span>{fail?<XCircle className="w-3.5 h-3.5 text-red-600 flex-shrink-0"/>:<CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0"/>}</>:delivery.delivery_time_eta?<><span style={{color:'var(--text-slate-600)'}}>{delivery.delivery_time_eta}</span><Clock className="w-3.5 h-3.5 flex-shrink-0" style={{color:'var(--text-slate-500)'}}/></>:null}</div></div>;
                })()}
              </div>
            </div>
          </Popup>
        )}
      </Marker>
    ];
  });
}