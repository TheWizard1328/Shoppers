import React, { useMemo } from 'react';
import { Polyline, CircleMarker } from 'react-leaflet';

const HISTORICAL_COLOR = '#f97316';
const LIVE_COLOR = '#2563eb';

const decodePolyline = (encoded) => {
  if (!encoded || typeof encoded !== 'string') return [];
  let index = 0, lat = 0, lng = 0;
  const coords = [];
  while (index < encoded.length) {
    let shift = 0, result = 0, byte;
    do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lat / 1e5, lng / 1e5]);
  }
  return coords;
};

const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'];

export default function MapBreadcrumbs({ breadcrumbsData, completedStopMarkers = [] }) {
  const lines = [];

  // Historical breadcrumbs: each record has encoded_polyline
  if (breadcrumbsData.historical && breadcrumbsData.historical.length > 0) {
    breadcrumbsData.historical.forEach((trail) => {
      if (!trail?.encoded_polyline) return;
      const coords = decodePolyline(trail.encoded_polyline);
      if (coords.length < 2) return;
      lines.push(
        <Polyline
          key={`historical-bc-${trail.id || trail.stop_order}`}
          positions={coords}
          pathOptions={{
            color: HISTORICAL_COLOR,
            weight: 3,
            opacity: 0.8,
            dashArray: '6 4',
          }}
        />
      );
    });
  }

  // Live/current breadcrumbs: array of {lat, lng} points — render as a single polyline
  if (breadcrumbsData.current && breadcrumbsData.current.length >= 2) {
    const coords = breadcrumbsData.current
      .filter(p => Number.isFinite(p?.lat) && Number.isFinite(p?.lng))
      .map(p => [p.lat, p.lng]);
    if (coords.length >= 2) {
      lines.push(
        <Polyline
          key="live-bc"
          positions={coords}
          pathOptions={{
            color: LIVE_COLOR,
            weight: 3,
            opacity: 0.85,
          }}
        />
      );
    }
  }

  // Small green dot at each completed stop's resolved GPS position
  const stopDots = completedStopMarkers
    .filter((m) => m && FINISHED_STATUSES.includes(m.status) && Number.isFinite(m.latitude) && Number.isFinite(m.longitude))
    .map((m) => (
      <CircleMarker
        key={`stop-dot-${m.id}`}
        center={[m.latitude, m.longitude]}
        radius={5}
        pathOptions={{
          color: '#ffffff',
          weight: 1.5,
          fillColor: '#16a34a',
          fillOpacity: 1,
        }}
      />
    ));

  const all = [...lines, ...stopDots];
  return all.length > 0 ? <>{all}</> : null;
}