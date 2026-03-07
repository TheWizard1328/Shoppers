import React from 'react';
import { Marker, Popup, Circle } from 'react-leaflet';
import L from 'leaflet';
import { format } from 'date-fns';
import { Truck, Home, User, CheckCircle2, XCircle, Clock } from 'lucide-react';
import DeliveryPopup from './DeliveryPopup';
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
      : createStoreIcon(pickup.status, pickup.pinColor, isFanned, pickup.status === 'pending' ? null : pickup.number, currentZoom, pickup.duplicateCount, isMobile, isHighlighted, pickup.isNextDelivery, hasIncompleteStops, false, isPickupFaded || isPickupInProgressFade, isPickupHighlightedFinished);

    const handlers = pickup.isOtherDriver ? {
      click: (e) => { L.DomEvent.stopPropagation(e); if (isPickupFaded) setFadedMarkerHighlights(prev => new Set([...prev, pickup.id])); },
      mouseover: (e) => { e.target.openPopup(); if (isPickupFaded || isPickupInProgressFade) setFadedMarkerHighlights(prev => new Set([...prev, pickup.id])); },
      mouseout: (e) => { e.target.closePopup(); setFadedMarkerHighlights(prev => { const n = new Set(prev); n.delete(pickup.id); return n; }); }
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
      <Marker key={`pickup-${pickup.id}-${routeRenderKey}`} position={markerPosition} icon={icon} zIndexOffset={dynamicZIndex} draggable={!pickup.useSimpleCircle && !pickup.isOtherDriver && isFanned} eventHandlers={handlers} ref={(ref) => { if (ref) markerRefs.current[`pickup-${pickup.id}`] = ref; }}>
        {!pickup.useSimpleCircle && !pickup.isOtherDriver && (isClustered && !isFanned ? (
          <Popup autoPan={false} closeButton={false} offset={[0,-20]} className="custom-popup">
            <div className="min-w-[200px] max-w-[300px] space-y-2">
              <div className="font-semibold text-sm pb-1 border-b" style={{color:'var(--text-slate-900)',borderColor:'var(--border-slate-200)'}}>{pickup.duplicateCount} stops at this location</div>
              {[...(groupedPickupMarkers.get(lk)||[]),...(groupedDeliveryMarkers.get(lk)||[])].sort((a,b)=>(a.stop_order||0)-(b.stop_order||0)).map(m => {
                const fin=FINISHED_STATUSES.includes(m.status);const ft=m.actual_delivery_time?format(new Date(m.actual_delivery_time),'HH:mm'):null;const nm=m.markerType==='pickup'?'Store Pickup':(m.patient?.full_name||'Patient');
                return (<div key={`ci-${m.id}`} className="text-xs py-1.5 border-b last:border-0 cursor-pointer hover:bg-slate-50 px-1 -mx-1 rounded space-y-0.5" style={{borderColor:'var(--border-slate-200)'}} onClick={()=>{document.querySelectorAll('.leaflet-popup').forEach(p=>p.remove());document.getElementById(`stop-card-${m.id}`)?.scrollIntoView({behavior:'smooth',block:'nearest',inline:'center'});}}>
                  <div className="flex items-center gap-1.5 font-medium" style={{color:'var(--text-slate-900)'}}><Truck className="w-3.5 h-3.5"/>{m.driver?.user_name||'Unknown'}</div>
                  <div className="flex items-center gap-1.5 text-[11px]" style={{color:'var(--text-slate-600)'}}><Home className="w-3.5 h-3.5"/>{m.store?.name||'Store'}</div>
                  {fin&&ft?<div className="flex items-center justify-between text-[11px]"><span style={{color:'var(--text-slate-900)'}}>{nm}</span><span className="text-emerald-600">{ft}</span></div>:m.delivery_time_eta?<div className="flex items-center justify-between text-[11px]"><span style={{color:'var(--text-slate-900)'}}>{nm}</span><span style={{color:'var(--text-slate-600)'}}>ETA: {m.delivery_time_eta}</span></div>:<div className="text-[11px]" style={{color:'var(--text-slate-900)'}}>{nm}</div>}
                </div>);
              })}
            </div>
          </Popup>
        ) : (<Popup autoPan={false} closeButton={false} offset={[0,-20]} className="custom-popup"><DeliveryPopup delivery={pickup} isPickup={true} stores={safeStores} patients={safePatients} users={safeUsers}/></Popup>))}
        {pickup.useSimpleCircle && !pickup.isOtherDriver && (<Popup autoPan={false} closeButton={false} offset={[0,-10]} className="custom-popup"><div className="min-w-[150px] space-y-1.5"><div className="flex items-center justify-between gap-2"><div className="flex items-center gap-1.5 text-xs font-semibold" style={{color:'var(--text-slate-900)'}}><Home className="w-3.5 h-3.5"/>{pickup.store?.name||'Store'}</div><span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${pickup.status==='completed'?'text-emerald-700 bg-emerald-100':pickup.status==='failed'||pickup.status==='cancelled'?'text-red-700 bg-red-100':pickup.status==='in_transit'?'text-blue-700 bg-blue-100':'text-slate-600 bg-slate-100'}`}>{pickup.status}</span></div><div className="flex items-center gap-1.5 text-xs" style={{color:'var(--text-slate-600)'}}><Truck className="w-3.5 h-3.5"/>{pickup.driver?.user_name||'Unknown Driver'}</div>{FINISHED_STATUSES.includes(pickup.status)&&pickup.actual_delivery_time?<div className="flex items-center gap-1 text-xs text-emerald-600"><Clock className="w-3.5 h-3.5"/>{format(new Date(pickup.actual_delivery_time),'HH:mm')}</div>:pickup.delivery_time_eta?<div className="flex items-center gap-1 text-xs" style={{color:'var(--text-slate-600)'}}>ETA: {pickup.delivery_time_eta}</div>:null}</div></Popup>)}
        {pickup.isOtherDriver && (<Popup autoPan={false} closeButton={false} offset={[0,-20]} className="custom-popup"><div className="min-w-[200px] max-w-[300px] space-y-0"><div className="px-1 pt-1 pb-1.5 space-y-0.5"><div className="flex items-center gap-1.5 font-medium text-xs" style={{color:'var(--text-slate-900)'}}><Truck className="w-3.5 h-3.5 flex-shrink-0"/>{pickup.driver?.user_name||'Unknown'}</div><div className="flex items-center gap-1.5 text-[11px]" style={{color:'var(--text-slate-600)'}}><Home className="w-3.5 h-3.5 flex-shrink-0"/>{pickup.store?.name||'Store'}</div></div><div className="border-b" style={{borderColor:'var(--border-slate-200)'}}/>      <div className="px-1 py-1.5">{(()=>{const fin=FINISHED_STATUSES.includes(pickup.status);const fail=pickup.status==='failed'||pickup.status==='cancelled';const ft=pickup.actual_delivery_time?format(new Date(pickup.actual_delivery_time),'HH:mm'):null;return(<div className="text-xs flex items-center justify-between"><div className="flex items-center gap-1.5" style={{color:'var(--text-slate-900)'}}><User className="w-3 h-3 flex-shrink-0"/><span>Store Pickup</span></div><div className="flex items-center gap-1">{fin&&ft?<><span className="text-emerald-600">{ft}</span>{fail?<XCircle className="w-3.5 h-3.5 text-red-600 flex-shrink-0"/>:<CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0"/>}</>:pickup.delivery_time_eta?<><span style={{color:'var(--text-slate-600)'}}>{pickup.delivery_time_eta}</span><Clock className="w-3.5 h-3.5 flex-shrink-0" style={{color:'var(--text-slate-500)'}}/></>:null}</div></div>);})()}</div></div></Popup>)}
      </Marker>
    ];
  });
}