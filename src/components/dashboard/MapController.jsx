import React, { useRef, useEffect } from 'react';

const markUserMapControlActive = (durationMs = 4000) => {
  if (typeof window === 'undefined') return;
  window._userMapControlUntil = Date.now() + durationMs;
};
import { useMapEvents } from 'react-leaflet';
import { base44 } from '@/api/base44Client';


export default function MapController({ 
  onMapInteraction, 
  onDoubleTap, 
  currentZoom, 
  setCurrentZoom, 
  setShowZoomOverlay, 
  zoomOverlayTimeoutRef, 
  setMapCenter,
  setMapZoom,
  setVisibleBounds,
  setFannedLocationKey,
  immersiveHidden,
}) {
  const isDraggingRef = useRef(false);
  const hasMovedRef = useRef(false);

  const mapInstance = useMapEvents({
    zoomstart: () => {
      const isProgrammaticFromFlag = mapInstance._isProgrammaticZoom?.current === true;
      const timeSinceProgrammatic = Date.now() - (window._lastProgrammaticMapMove || 0);
      const isProgrammaticFromTimer = timeSinceProgrammatic < 1200;
      // CRITICAL: A real finger/pointer gesture was recorded recently — this is definitely
      // a user action (pinch-zoom or scroll) even if the programmatic timer is still hot
      // from a GPS-driven map reposition. Trust the gesture timestamp over the timer.
      const timeSinceGesture = Date.now() - (window._lastUserGestureStart || 0);
      const isRealUserGesture = timeSinceGesture < 500;
      
      if (!isRealUserGesture && (isProgrammaticFromFlag || isProgrammaticFromTimer)) {
        console.log('🗺️ [MapController] ZOOM START - PROGRAMMATIC (ignoring)');
        return;
      }
      
      console.log('🗺️ [MapController] ZOOM START - USER INTERACTION');
      console.log('🟠 [map phase unlocked] reason=user-zoom');
      markUserMapControlActive();
      base44.analytics.track({
        eventName: 'map_zoom_started',
        properties: { zoom_level: mapInstance.getZoom() }
      });
      if (onMapInteraction) {
        onMapInteraction(true);
      }
    },
    dragstart: () => {
      isDraggingRef.current = true;
      hasMovedRef.current = false;
      markUserMapControlActive();
    },
    drag: () => {
      hasMovedRef.current = true;
    },
    dragend: () => {
      const wasDragging = isDraggingRef.current;
      const didMove = hasMovedRef.current;
      isDraggingRef.current = false;
      hasMovedRef.current = false;
      
      if (wasDragging && didMove) {
        const timeSinceProgrammatic = Date.now() - (window._lastProgrammaticMapMove || 0);
        const isProgrammaticDrag = timeSinceProgrammatic < 1500;
        
        // CRITICAL: Also trust a recent gesture timestamp to override the programmatic timer.
        const timeSinceGesture = Date.now() - (window._lastUserGestureStart || 0);
        const isRealUserGesture = timeSinceGesture < 2000; // drag can take up to ~1.5s

        if (!isProgrammaticDrag || isRealUserGesture) {
          console.log('🗺️ [MapController] DRAG END - USER INTERACTION');
          console.log('🟠 [map phase unlocked] reason=user-drag');
          markUserMapControlActive();
          base44.analytics.track({
            eventName: 'map_panned',
            properties: { zoom_level: mapInstance.getZoom() }
          });
          if (onMapInteraction) {
            onMapInteraction(true);
          }
          // Collapse any expanded cards when user pans the map
          window.dispatchEvent(new CustomEvent('mapBackgroundClick'));
        }
      }
    },
    movestart: () => {},
    zoomend: () => {
      const rawZoom = mapInstance.getZoom();
      const roundedZoom = Math.round(rawZoom * 10) / 10;
      window.__currentMapZoom = roundedZoom;
      
      if (roundedZoom !== currentZoom) {
        setCurrentZoom(roundedZoom);
        // CRITICAL: Do not echo zoom back to Dashboard state during programmatic moves —
        // this would update the zoom prop on DeliveryMap and re-trigger the setView effect.
        const timeSinceProgrammaticZoom = Date.now() - (window._lastProgrammaticMapMove || 0);
        if (timeSinceProgrammaticZoom >= 3500) {
          setMapZoom?.(roundedZoom);
        }
        
        const isProgrammaticFromFlag = mapInstance._isProgrammaticZoom?.current === true;
        const timeSinceProgrammatic = Date.now() - (window._lastProgrammaticMapMove || 0);
        const isProgrammaticFromTimer = timeSinceProgrammatic < 1500;
        
        if (!isProgrammaticFromFlag && !isProgrammaticFromTimer) {
          console.log('🗺️ [MapController] ZOOM END - USER INTERACTION (showing overlay)');
          markUserMapControlActive();
          if (zoomOverlayTimeoutRef.current) {
            clearTimeout(zoomOverlayTimeoutRef.current);
          }
          setShowZoomOverlay(true);
          zoomOverlayTimeoutRef.current = setTimeout(() => {
            setShowZoomOverlay(false);
          }, 3000);
        } else {
          console.log('🗺️ [MapController] ZOOM END - PROGRAMMATIC (not showing overlay)');
        }
      }
      
      if (mapInstance._isProgrammaticZoom) {
        mapInstance._isProgrammaticZoom.current = false;
      }
      
      const bounds = mapInstance.getBounds();
      setVisibleBounds(bounds);
    },
    moveend: () => {
      if ((window._suppressAutoCenterUntil || 0) > Date.now()) { return; }
      // CRITICAL: Do not echo center back to Dashboard state during programmatic moves.
      // fitBounds/setView fire moveend, which updates mapCenter prop, which re-triggers
      // the setView effect — causing a second unwanted map reposition (double-bounce).
      const timeSinceProgrammatic = Date.now() - (window._lastProgrammaticMapMove || 0);
      if (timeSinceProgrammatic < 3500) { 
        const bounds = mapInstance.getBounds();
        setVisibleBounds(bounds);
        return;
      }
      const center = mapInstance.getCenter();
      const newCenter = [center.lat, center.lng];
      window.__currentMapCenter = newCenter;
      
      setMapCenter(prev => {
        if (!prev || prev[0] !== newCenter[0] || prev[1] !== newCenter[1]) {
          return newCenter;
        }
        return prev;
      });
      
      const bounds = mapInstance.getBounds();
      setVisibleBounds(bounds);
    },
    click: () => {
      setFannedLocationKey(null);
      // Notify DashboardView that the map background was tapped so it can collapse expanded cards
      window.dispatchEvent(new CustomEvent('mapBackgroundClick'));
    },
    dblclick: (event) => {
      event?.originalEvent?.stopPropagation?.();
      base44.analytics.track({
        eventName: 'map_double_tapped',
        properties: { zoom_level: mapInstance.getZoom() }
      });
      // If immersive mode is active: disable it and exit — no zoom, nothing else.
      if (immersiveHidden) {
        if (onDoubleTap) onDoubleTap(true);
        return;
      }
      // Immersive mode is off: proceed with zoom
      if (onDoubleTap) onDoubleTap(true);
    },
  });



  // Handle zoom-in on double tap via window event (fired from MapSection onDoubleTap)
  useEffect(() => {
    const handleDoubleTapZoom = (e) => {
      const delta = e?.detail?.delta ?? 0.2;
      const currentZoomLevel = mapInstance.getZoom();
      window._lastProgrammaticMapMove = Date.now();
      mapInstance.setZoom(currentZoomLevel + delta, { animate: true });
    };
    window.addEventListener('mapDoubleTapZoom', handleDoubleTapZoom);
    return () => window.removeEventListener('mapDoubleTapZoom', handleDoubleTapZoom);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // CRITICAL: Track real user touch/pointer gestures on the map container.
  // The _lastProgrammaticMapMove timer is refreshed every GPS tick (~1-5s) in phase 2,
  // which means zoomstart/dragend always sees timeSinceProgrammatic < 1200ms and
  // incorrectly classifies user pinch-zoom and drag as programmatic — silently
  // swallowing the onMapInteraction() call that should unlock the FAB.
  // Solution: record the EXACT moment a real finger/pointer touches the map so
  // zoomstart/dragend can override the timer check when a gesture JUST started.
  useEffect(() => {
    const mapContainer = mapInstance.getContainer();
    if (!mapContainer) return;
    const onGestureStart = () => {
      window._lastUserGestureStart = Date.now();
    };
    mapContainer.addEventListener('touchstart', onGestureStart, { passive: true });
    mapContainer.addEventListener('pointerdown', onGestureStart, { passive: true });
    return () => {
      mapContainer.removeEventListener('touchstart', onGestureStart);
      mapContainer.removeEventListener('pointerdown', onGestureStart);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}