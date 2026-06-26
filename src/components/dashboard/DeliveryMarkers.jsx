import React from 'react';
import { Marker, Popup, Circle } from 'react-leaflet';
import L from 'leaflet';
import { Clock, Home, MapPin, Truck } from 'lucide-react';
import DeliveryPopup from './DeliveryPopup';
import MarkerInfoBalloon from './MarkerInfoBalloon';
import { createSimpleCircleIcon, createDeliveryIcon, createCyclingStartIcon, createCyclingEndIcon, createCyclingSplitIcon } from './MapIcons';
import { getStoreColor } from '../utils/colorGenerator';
import { isInterStoreDelivery, getInterStoreLocationSync } from '../utils/interStoreDisplayName';

const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'];

function DeliveryMarkers({
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

  // Pre-index cycling markers by driver so we can pair start+end for the split icon
  const cyclingByDriver = React.useMemo(() => {
    const map = new Map();
    deliveryMarkers.forEach((d) => {
      if (!d?.is_cycling_marker) return;
      if (!map.has(d.driver_id)) map.set(d.driver_id, { start: null, end: null });
      if (d.delivery_notes === 'Cycling Route Start') map.get(d.driver_id).start = d;
      else map.get(d.driver_id).end = d;
    });
    return map;
  }, [deliveryMarkers]);

  return deliveryMarkers.map((delivery) => {
    // Cycling markers: fan out at high zoom, collapse to split icon at low zoom
    if (delivery?.is_cycling_marker) {
      // latitude/longitude already resolved from cycling_lat/lng by DeliveryMap.
      // Belt-and-suspenders: also accept cycling_latitude/longitude directly.
      const cycLat = Number(delivery.latitude ?? delivery.cycling_latitude);
      const cycLng = Number(delivery.longitude ?? delivery.cycling_longitude);
      if (!Number.isFinite(cycLat) || !Number.isFinite(cycLng)) return null;
      const isStart = delivery.delivery_notes === 'Cycling Route Start';

      // At or above zoom 16: show separate start/end pins (fanned out)
      if (currentZoom >= 16) {
        const cycIcon = isStart ? createCyclingStartIcon(isMobile) : createCyclingEndIcon(isMobile);
        const pair = cyclingByDriver.get(delivery.driver_id) || {};
        const thisTime = delivery.arrival_time
          ? new Date(delivery.arrival_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
          : delivery.actual_delivery_time
            ? new Date(delivery.actual_delivery_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
            : delivery.delivery_time_start || null;
        return (
          <Marker
            key={delivery.id}
            position={[cycLat, cycLng]}
            icon={cycIcon}
            zIndexOffset={1000}
            eventHandlers={{
              click: () => onMarkerClick?.(delivery),
              mouseover: (e) => e.target.openPopup(),
              mouseout: (e) => e.target.closePopup(),
            }}
          >
            <Popup autoPan={false} closeButton={false} offset={[0, -20]} className="custom-popup">
              <div style={{ fontSize: '0.875rem', fontWeight: 600 }}>🚲 {isStart ? 'Cycling Start' : 'Cycling End'}</div>
              <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>Stop #{delivery.stop_order}</div>
              {thisTime && <div style={{ fontSize: '0.75rem', color: isStart ? '#16a34a' : '#dc2626', fontWeight: 600, marginTop: 2 }}>{isStart ? '▶' : '■'} {thisTime}</div>}
            </Popup>
          </Marker>
        );
      }

      // Below FULL_DETAIL zoom: collapse to single split icon (start marker only)
      if (!isStart) return null;
      const pair = cyclingByDriver.get(delivery.driver_id) || {};
      const startTime = pair.start?.arrival_time
        ? new Date(pair.start.arrival_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
        : pair.start?.actual_delivery_time
          ? new Date(pair.start.actual_delivery_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
          : pair.start?.delivery_time_start || null;
      const endTime = pair.end?.arrival_time
        ? new Date(pair.end.arrival_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
        : pair.end?.actual_delivery_time
          ? new Date(pair.end.actual_delivery_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
          : pair.end?.delivery_time_start || null;

      // Calculate loop duration if both times known
      let loopDuration = null;
      if (startTime && endTime) {
        const [sh, sm] = startTime.split(':').map(Number);
        const [eh, em] = endTime.split(':').map(Number);
        const totalMin = (eh * 60 + em) - (sh * 60 + sm);
        if (totalMin > 0) loopDuration = `${Math.floor(totalMin / 60) > 0 ? Math.floor(totalMin / 60) + 'h ' : ''}${totalMin % 60}min`;
      }

      return (
        <Marker
          key={`cycling-split-${delivery.id}`}
          position={[cycLat, cycLng]}
          icon={createCyclingSplitIcon(isMobile)}
          zIndexOffset={1000}
          eventHandlers={{
            click: () => onMarkerClick?.(delivery),
            mouseover: (e) => e.target.openPopup(),
            mouseout: (e) => e.target.closePopup(),
          }}
        >
          <Popup autoPan={false} closeButton={false} offset={[0, -20]} className="custom-popup">
            <div style={{ fontSize: '0.875rem', fontWeight: 600, marginBottom: 4 }}>🚲 Cycling Route</div>
            {startTime && <div style={{ fontSize: '0.75rem', color: '#16a34a', fontWeight: 600 }}>▶ Start: {startTime}</div>}
            {endTime && <div style={{ fontSize: '0.75rem', color: '#dc2626', fontWeight: 600 }}>■ End: {endTime}</div>}
            {loopDuration && <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: 2 }}>⏱ Loop: {loopDuration}</div>}
            {!startTime && !endTime && <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>Zoom in to see start &amp; end separately</div>}
          </Popup>
        </Marker>
      );
    }
    const gpsOverride = delivery?.patient_id ? gpsOverrides[delivery.patient_id] : null;
    const markerLatitude = gpsOverride?.latitude ?? delivery.latitude;
    const markerLongitude = gpsOverride?.longitude ?? delivery.longitude;
    if (!Number.isFinite(markerLatitude) || !Number.isFinite(markerLongitude)) return null;
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
    const isActive = delivery.status === 'in_transit' || delivery.status === 'en_route';
    const isPending = delivery.status === 'pending';
    const stopOrder = delivery.stop_order || delivery.number || 500;

    // Z-index tiers (higher = on top):
    // Active (in_transit/en_route): 8000 tier — lowest stop_order gets highest z (subtract stop_order)
    // Incomplete (pending/other non-finished): 5000 tier — lowest stop_order gets highest z
    // Completed (finished): 100 tier — highest stop_order gets highest z within tier (add stop_order)
    if (isActive) dynamicZIndex = 8000 - stopOrder;
    else if (isFinished) dynamicZIndex = 100 + stopOrder;
    else dynamicZIndex = 5000 - stopOrder;

    if (isFanned && isClustered) {
      const pickupsAtLocation = groupedPickupMarkers.get(locationKey) || [];
      const deliveriesAtLocation = groupedDeliveryMarkers.get(locationKey) || [];
      const allMarkersAtLocation = [...pickupsAtLocation, ...deliveriesAtLocation]
        .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
      const clusterIndex = allMarkersAtLocation.findIndex(d => d && d.id === delivery.id);
      markerPosition = calculateFannedPositionWrapperWrapper(markerLatitude, markerLongitude, clusterIndex, allMarkersAtLocation.length, delivery.stop_order);
      // Within a fanned cluster: active > pending > completed; within each tier use same ordering rules
      if (isActive) dynamicZIndex = 9000 - stopOrder;
      else if (isFinished) dynamicZIndex = 2000 + stopOrder;
      else dynamicZIndex = 6000 - stopOrder;
    }

    const markerStoreColor = delivery.store ? getStoreColor(delivery.store) : null;
    const icon = delivery.useSimpleCircle || delivery.isOtherDriver
      ? createSimpleCircleIcon(delivery.isReturn ? 'returned' : delivery.status, delivery.status === 'pending' ? null : delivery.number, currentZoom, delivery.pinColor, true, delivery.duplicateCount, delivery.isNextInLine, isDeliveryFaded || isDeliveryInProgressFade, isDeliveryHighlightedFinished, markerStoreColor)
      : createDeliveryIcon(delivery.status, delivery.pinColor, isFanned, delivery.status === 'pending' ? null : delivery.number, delivery.isFirstTime, delivery.duplicateCount, currentZoom, delivery.isNextInLine, isHighlighted, hasIncompleteStops, delivery.ampm_deliveries === 'PM', delivery.isOtherDriver, delivery.isReturn, isDeliveryFaded || isDeliveryInProgressFade, isDeliveryHighlightedFinished, delivery.fridge_item === true);

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
      isHighlighted && !isFanned && <Circle key={`delivery-halo-${delivery.id}`} center={[markerLatitude, markerLongitude]} radius={40} pathOptions={{ color: delivery.pinColor || '#71717A', fillColor: 'transparent', fillOpacity: 0, weight: 2, opacity: 0.9, className: 'pulsating-halo' }} />,
      isHighlighted && !isFanned && delivery.store_id && (() => {
        const deliveryStore = stores.find(s => s?.id === delivery.store_id);
        if (!deliveryStore?.latitude || !deliveryStore?.longitude) return null;
        return <Circle key={`delivery-store-halo-${delivery.id}`} center={[deliveryStore.latitude, deliveryStore.longitude]} radius={40} pathOptions={{ color: delivery.pinColor || '#71717A', fillColor: 'transparent', fillOpacity: 0, weight: 2, opacity: 0.9, className: 'pulsating-halo' }} />;
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
                                const ispLocC = isInterStoreDelivery(m.delivery_id) ? getInterStoreLocationSync(m.delivery_id) : null;
                                const name = ispLocC
                                  ? `${String(m.delivery_id).toUpperCase().startsWith('ISP-') ? 'ISP' : 'ISD'}: ${ispLocC.store_name || 'Inter-Store'}`
                                  : m.markerType === 'pickup' ? 'Store Pickup' : (m.patient?.full_name || 'Patient');
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
                                  const ispLocO = isInterStoreDelivery(m.delivery_id) ? getInterStoreLocationSync(m.delivery_id) : null;
                                  const name = ispLocO
                                    ? `${String(m.delivery_id).toUpperCase().startsWith('ISP-') ? 'ISP' : 'ISD'}: ${ispLocO.store_name || 'Inter-Store'}`
                                    : m.markerType === 'pickup' ? 'Store Pickup' : (m.patient?.full_name || 'Patient');
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

export default React.memo(DeliveryMarkers, (prev, next) => {
  // Skip re-render if the marker arrays are identical references and
  // the highlight/fanned state hasn't changed.
  // deliveryMarkers changes reference on every parent render — but if the
  // actual stops haven't changed, the viewport-culled array will be stable.
  return (
    prev.deliveryMarkers === next.deliveryMarkers &&
    prev.groupedDeliveryMarkers === next.groupedDeliveryMarkers &&
    prev.groupedPickupMarkers === next.groupedPickupMarkers &&
    prev.highlightedDeliveryId === next.highlightedDeliveryId &&
    prev.fannedLocationKey === next.fannedLocationKey &&
    prev.isMobile === next.isMobile &&
    prev.currentUser === next.currentUser
  );
});