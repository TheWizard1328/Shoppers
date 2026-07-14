import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet-polylinedecorator";

export default function RouteDirectionDecorator({ positions = [], color = "#2563EB", pattern = "120px", size = 9, pane = "routeBasePane" }) {
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
      // Pane must exist as a real DOM element before polylinedecorator tries appendChild
      if (!map._panes[pane] || !(map._panes[pane] instanceof Element)) {
        if (attempt < 40) retryRef.current = setTimeout(() => tryAdd(attempt + 1), 50);
        return;
      }

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
              pathOptions: { stroke: false, fillOpacity: 0.9, fillColor: color || '#2563EB', pane }
            })
          }]
        });
        decorator.addTo(map);
        decoratorRef.current = decorator;
      } catch (err) {
        // addTo failed (pane DOM not fully ready) — retry
        if (attempt < 40) retryRef.current = setTimeout(() => tryAdd(attempt + 1), 50);
      }
    };

    tryAdd();
    return cleanup;
  }, [map, positions, color, pattern, size, pane]);

  return null;
}