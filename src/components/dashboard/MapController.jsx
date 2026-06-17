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
      
      if (isProgrammaticFromFlag || isProgrammaticFromTimer) {
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
        
        if (!isProgrammaticDrag) {
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

  return null;
}