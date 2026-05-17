import React, { useMemo } from "react";
import { Polyline } from "react-leaflet";

const FINISHED = ["completed", "failed", "cancelled", "returned"];

const decodePolyline = (str) => {
  let index = 0, lat = 0, lng = 0, coordinates = [];
  while (index < str.length) {
    let b, shift = 0, result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += dlat;
    shift = 0; result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    const dlng = (result & 1) ? ~(result >> 1) : (result >> 1);
    lng += dlng;
    coordinates.push([lat / 1e5, lng / 1e5]);
  }
  return coordinates;
};

/**
 * Renders faded green polylines for finished stops that have an encoded_polyline string.
 * Only shown to admins when a specific driver is selected.
 */
export default function FinishedStopsPolylines({ deliveryMarkers = [], pickupMarkers = [], selectedDriverId = null }) {
  const lines = useMemo(() => {
    if (!selectedDriverId || selectedDriverId === "all") return [];

    const allStops = [...deliveryMarkers, ...pickupMarkers];
    const finishedStops = allStops.filter(
      (stop) =>
        stop &&
        stop.driver_id === selectedDriverId &&
        FINISHED.includes(stop.status) &&
        typeof stop.encoded_polyline === "string" &&
        stop.encoded_polyline.trim().length > 0
    );

    return finishedStops.flatMap((stop) => {
      try {
        const coords = decodePolyline(stop.encoded_polyline);
        if (!coords || coords.length < 2) return [];
        return [
          <Polyline
            key={`finished-poly-${stop.id}`}
            positions={coords}
            pathOptions={{
              color: "#16a34a",
              weight: 3,
              opacity: 0.25,
              lineJoin: "round",
              lineCap: "round",
            }}
            pane="routeBasePane"
          />
        ];
      } catch {
        return [];
      }
    });
  }, [deliveryMarkers, pickupMarkers, selectedDriverId]);

  return lines.length ? <>{lines}</> : null;
}