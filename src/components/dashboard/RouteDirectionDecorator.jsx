import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet-polylinedecorator";

export default function RouteDirectionDecorator({ positions = [], color = "#2563EB", pattern = "120px", size = 9, pane = "overlayPane" }) {
  const map = useMap();
  const decoratorRef = useRef(null);
  const retryRef = useRef(null);

  useEffect(() => {
    const validPositions = Array.isArray(positions)
      ? positions.filter((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
      : [];

    const cleanup = () => {
      if (retryRef.current) { clearTimeout(retryRef.current); retryRef.current = null; }
      if (decoratorRef.current) {
        try { map.removeLayer(decoratorRef.current); } catch (_) {}
        decoratorRef.current = null;
      }
    };

    if (!map || !map._loaded || !map._panes || validPositions.length < 2) return cleanup;

    const tryAdd = (attempt = 0) => {
      // Use the standard overlayPane (always exists) for the arrowhead marker icon.
      // Custom panes like currentLegPane/completedBreadcrumbPane may not be initialized yet
      // and passing them to pathOptions causes _initIcon to crash with appendChild on undefined.
      const iconPane = map._panes['markerPane'] ? 'markerPane' : 'overlayPane';

      if (decoratorRef.current) {
        try { map.removeLayer(decoratorRef.current); } catch (_) {}
        decoratorRef.current = null;
      }

      try {
        const decorator = L.polylineDecorator(validPositions, {
          patterns: [{
            offset: pattern,
            repeat: pattern,
            symbol: L.Symbol.arrowHead({
              pixelSize: size,
              polygon: true,
              pathOptions: {
                stroke: false,
                fillOpacity: 0.9,
                fillColor: color || '#2563EB',
                // Always use a built-in pane for the arrowhead icon — custom panes
                // created by react-leaflet <Pane> components may not exist at mount time.
                pane: iconPane,
              }
            })
          }]
        });
        decorator.addTo(map);
        decoratorRef.current = decorator;
      } catch (err) {
        // Map or pane not ready — retry up to 40 times (2 seconds)
        if (attempt < 40) retryRef.current = setTimeout(() => tryAdd(attempt + 1), 50);
      }
    };

    tryAdd();
    return cleanup;
  }, [map, positions, color, pattern, size]);

  return null;
}