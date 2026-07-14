import React, { useRef, useEffect } from 'react';

const markUserMapControlActive = (durationMs = 4000) => {
  if (typeof window === 'undefined') return;
  window._userMapControlUntil = Date.now() + durationMs;
};
import { useMapEvents } from 'react-leaflet';


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
      const timeSinceGesture = Date.now() - (window._lastUserGestureStart || 0);
      const isRealUserGesture = timeSinceGesture < 500;
      
      if (!isRealUserGesture && (isProgrammaticFromFlag || isProgrammaticFromTimer)) {
        return;
      }
      
      markUserMapControlActive();
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
        const timeSinceGesture = Date.now() - (window._lastUserGestureStart || 0);
        const isRealUserGesture = timeSinceGesture < 2000;

        if (!isProgrammaticDrag || isRealUserGesture) {
          markUserMapControlActive();
          if (onMapInteraction) {
            onMapInteraction(true);
          }
          window.dispatchEvent(new CustomEvent('mapBackgroundClick'));
        }
      }
    },
    movestart: () => {},
    zoomend: () => {
      const rawZoom = mapInstance.getZoom();
      const roundedZoom = Math.round(rawZoom * 10) / 10;
      window.__currentMapZoom = roundedZoom;
      window.__mapCurrentZoom = roundedZoom;
      
      if (roundedZoom !== currentZoom) {
        setCurrentZoom(roundedZoom);
        
        const timeSinceProgrammatic = Date.now() - (window._lastProgrammaticMapMove || 0);
        const isProgrammaticFromFlag = mapInstance._isProgrammaticZoom?.current === true;
        const isProgrammaticFromTimer = timeSinceProgrammatic < 1500;
        const isUserZoom = !isProgrammaticFromFlag && !isProgrammaticFromTimer;

        // Only echo zoom back to Dashboard state on genuine user zoom to avoid re-triggering setView
        if (isUserZoom && timeSinceProgrammatic >= 3500) {
          setMapZoom?.(roundedZoom);
        }
        
        if (isUserZoom) {
          markUserMapControlActive();
          if (zoomOverlayTimeoutRef.current) {
            clearTimeout(zoomOverlayTimeoutRef.current);
          }
          setShowZoomOverlay(true);
          zoomOverlayTimeoutRef.current = setTimeout(() => {
            setShowZoomOverlay(false);
          }, 3000);
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
      const center = mapInstance.getCenter();
      const newCenter = [center.lat, center.lng];
      window.__mapCurrentCenter = newCenter;
      window.__mapCurrentZoom = mapInstance.getZoom();
      
      const bounds = mapInstance.getBounds();
      setVisibleBounds(bounds);

      // Only echo center back to Dashboard state on genuine user moves.
      // fitBounds/setView fire moveend — echoing back updates mapCenter prop, which
      // re-triggers the setView effect causing a double-bounce.
      const timeSinceProgrammatic = Date.now() - (window._lastProgrammaticMapMove || 0);
      if (timeSinceProgrammatic < 3500) return;
      
      window.__currentMapCenter = newCenter;
      setMapCenter(prev => {
        if (!prev || prev[0] !== newCenter[0] || prev[1] !== newCenter[1]) {
          return newCenter;
        }
        return prev;
      });
    },
    click: () => {
      setFannedLocationKey(null);
      // Notify DashboardView that the map background was tapped so it can collapse expanded cards
      window.dispatchEvent(new CustomEvent('mapBackgroundClick'));
    },
    dblclick: (event) => {
      event?.originalEvent?.stopPropagation?.();
      if (immersiveHidden) {
        if (onDoubleTap) onDoubleTap(true);
        return;
      }
      if (onDoubleTap) onDoubleTap(true);
    },
  });



  // Restore map to saved center/zoom when a stop card collapses
  useEffect(() => {
    const handleRestoreMapView = (e) => {
      const { center, zoom } = e?.detail || {};
      if (!center || !zoom || !mapInstance) return;
      window._lastProgrammaticMapMove = Date.now() + 1500;
      mapInstance.setView(center, zoom, { animate: true, duration: 0.6 });
    };
    window.addEventListener('restoreMapView', handleRestoreMapView);
    return () => window.removeEventListener('restoreMapView', handleRestoreMapView);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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