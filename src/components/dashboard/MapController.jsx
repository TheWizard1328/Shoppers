import React, { useRef } from 'react';
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
  setVisibleBounds,
  setFannedLocationKey
}) {
  const lastTapRef = useRef(0);
  const isDraggingRef = useRef(false);
  const hasMovedRef = useRef(false);
  
  const mapInstance = useMapEvents({
    zoomstart: () => {
      const isProgrammaticFromFlag = mapInstance._isProgrammaticZoom?.current === true;
      const timeSinceProgrammatic = Date.now() - (window._lastProgrammaticMapMove || 0);
      const isProgrammaticFromTimer = timeSinceProgrammatic < 500;
      
      if (isProgrammaticFromFlag || isProgrammaticFromTimer) {
        console.log('🗺️ [MapController] ZOOM START - PROGRAMMATIC (ignoring)');
        return;
      }
      
      console.log('🗺️ [MapController] ZOOM START - USER INTERACTION');
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
        const isProgrammaticDrag = timeSinceProgrammatic < 1000;
        
        if (!isProgrammaticDrag) {
          console.log('🗺️ [MapController] DRAG END - USER INTERACTION');
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
      
      if (roundedZoom !== currentZoom) {
        setCurrentZoom(roundedZoom);
        
        const isProgrammaticFromFlag = mapInstance._isProgrammaticZoom?.current === true;
        const timeSinceProgrammatic = Date.now() - (window._lastProgrammaticMapMove || 0);
        const isProgrammaticFromTimer = timeSinceProgrammatic < 1000;
        
        if (!isProgrammaticFromFlag && !isProgrammaticFromTimer) {
          console.log('🗺️ [MapController] ZOOM END - USER INTERACTION (showing overlay)');
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
      const center = mapInstance.getCenter();
      const newCenter = [center.lat, center.lng];
      
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
      
      const now = Date.now();
      const timeSinceLastTap = now - lastTapRef.current;
      
      if (timeSinceLastTap < 300) {
        base44.analytics.track({
          eventName: 'map_double_tapped',
          properties: { zoom_level: mapInstance.getZoom() }
        });
        if (onDoubleTap) onDoubleTap();
      }
      
      lastTapRef.current = now;
    }
  });

  return null;
}