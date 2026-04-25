import { useEffect } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet-polylinedecorator";

export default function RouteDirectionDecorator({ positions = [], color = "#2563EB", pattern = "90px", size = 8, pane = "routeBasePane" }) {
  const map = useMap();

  useEffect(() => {
    if (!map || !Array.isArray(positions) || positions.length < 2) return;

    const decorator = L.polylineDecorator(positions, {
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
              fillColor: color,
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