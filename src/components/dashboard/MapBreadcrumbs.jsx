import React, { useMemo } from 'react';
import { Polyline } from 'react-leaflet';

const HISTORICAL_COLOR = '#f97316';
const LIVE_COLOR = '#2563eb';

// 1e5 precision — MUST match the client encoder in locationBreadcrumbService.jsx
const POLY_PRECISION = 1e5;

const decodePolyline = (encoded) => {
  if (!encoded || typeof encoded !== 'string') return [];
  let index = 0, lat = 0, lng = 0;
  const coords = [];
  while (index < encoded.length) {
    let result = 0, multiplier = 1, byte;
    do { byte = encoded.charCodeAt(index++) - 63; result += (byte % 32) * multiplier; multiplier *= 32; } while (byte >= 0x20);
    lat += (result % 2 !== 0) ? -((result + 1) / 2) : (result / 2);
    result = 0; multiplier = 1;
    do { byte = encoded.charCodeAt(index++) - 63; result += (byte % 32) * multiplier; multiplier *= 32; } while (byte >= 0x20);
    lng += (result % 2 !== 0) ? -((result + 1) / 2) : (result / 2);
    coords.push([lat / POLY_PRECISION, lng / POLY_PRECISION]);
  }
  return coords;
};

export default function MapBreadcrumbs({ breadcrumbsData }) {
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

  return lines.length > 0 ? <>{lines}</> : null;
}
