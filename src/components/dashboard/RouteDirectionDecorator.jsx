import { useEffect } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet-polylinedecorator";

export default function RouteDirectionDecorator({ positions = [], color = "#2563EB", pattern = "120px", size = 9, pane = "routeBasePane" }) {
  const map = useMap();

  useEffect(() => {
    const validPositions = Array.isArray(positions)
      ? positions.filter((point) => Array.isArray(point) && point.length >= 2 && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])))
      : [];

    if (!map || !map._loaded || !map._panes || validPositions.length < 2) return;

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
    return () => {
      map.removeLayer(decorator);
    };
  }, [map, positions, color, pattern, size, pane]);

  return null;
}