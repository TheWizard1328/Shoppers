import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet-polylinedecorator";

export default function RouteDirectionDecorator({ positions = [], color = "#2563EB", pattern = "120px", size = 9, pane = "routeBasePane" }) {
  const map = useMap();
  const decoratorRef = useRef(null);

  useEffect(() => {
    const validPositions = Array.isArray(positions)
      ? positions.filter((point) => Array.isArray(point) && point.length >= 2 && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])))
      : [];

    if (!map || !map._loaded || !map._panes || validPositions.length < 2) return;

    const addDecorator = () => {
      // Guard: the target pane must exist in the DOM before leaflet-polylinedecorator
      // tries to appendChild into it. Custom panes created by <Pane> in react-leaflet
      // may not be available immediately after the map mounts.
      if (!map._panes[pane]) return false;

      if (decoratorRef.current) {
        try { map.removeLayer(decoratorRef.current); } catch (_) {}
        decoratorRef.current = null;
      }

      const decorator = L.polylineDecorator(validPositions, {
        patterns: [
          {
            offset: pattern,
            repeat: pattern,
            symbol: L.Symbol.arrowHead({
              pixelSize: size,
              polygon: true,
              pathOptions: {
                stroke: false,
                fillOpacity: 0.9,
                fillColor: color || '#2563EB',
                pane
              }
            })
          }
        ]
      });

      decorator.addTo(map);
      decoratorRef.current = decorator;
      return true;
    };

    // Try immediately; if the pane isn't ready yet, poll until it is (max 2s).
    if (!addDecorator()) {
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        if (addDecorator() || attempts >= 40) clearInterval(interval);
      }, 50);
      return () => {
        clearInterval(interval);
        if (decoratorRef.current) {
          try { map.removeLayer(decoratorRef.current); } catch (_) {}
          decoratorRef.current = null;
        }
      };
    }

    return () => {
      if (decoratorRef.current) {
        try { map.removeLayer(decoratorRef.current); } catch (_) {}
        decoratorRef.current = null;
      }
    };
  }, [map, positions, color, pattern, size, pane]);

  return null;
}