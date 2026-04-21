import React, { useMemo } from 'react';
import { CircleMarker } from 'react-leaflet';

const HISTORICAL_COLOR = '#16a34a';
const LIVE_COLOR = '#2563eb';

export default function MapBreadcrumbs({ breadcrumbsData, currentZoom = 12 }) {
  const dots = [];
  const historicalDotRadius = useMemo(() => {
    const zoom = Number.isFinite(currentZoom) ? currentZoom : 12;
    return Math.max(1.5, Math.min(3.5, 1 + (zoom - 8) * 0.22));
  }, [currentZoom]);
  const liveDotRadius = useMemo(() => {
    const zoom = Number.isFinite(currentZoom) ? currentZoom : 12;
    return Math.max(2, Math.min(4.5, 1.4 + (zoom - 8) * 0.26));
  }, [currentZoom]);

  if (breadcrumbsData.historical && breadcrumbsData.historical.length > 0) {
    breadcrumbsData.historical.forEach((trail) => {
      if (!trail || !trail.breadcrumbs || !Array.isArray(trail.breadcrumbs)) return;

      trail.breadcrumbs
        .map((point, index) => ({
          lat: Number(point?.[0]),
          lng: Number(point?.[1]),
          key: `${trail.id}-${point?.[2] || index}`,
        }))
        .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng))
        .forEach((point) => {
          dots.push(
            <CircleMarker
              key={`historical-breadcrumb-point-${point.key}`}
              center={[point.lat, point.lng]}
              radius={historicalDotRadius}
              pathOptions={{
                color: HISTORICAL_COLOR,
                fillColor: HISTORICAL_COLOR,
                fillOpacity: 0.9,
                weight: 1,
              }}
            />
          );
        });
    });
  }

  if (breadcrumbsData.current && breadcrumbsData.current.length > 0) {
    breadcrumbsData.current
      .map((point, index) => ({
        lat: Number(point?.lat),
        lng: Number(point?.lng),
        key: `${point?.timestamp || 'no-ts'}-${index}`,
      }))
      .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng))
      .forEach((point) => {
        dots.push(
          <CircleMarker
            key={`current-breadcrumb-point-${point.key}`}
            center={[point.lat, point.lng]}
            radius={liveDotRadius}
            pathOptions={{
              color: LIVE_COLOR,
              fillColor: LIVE_COLOR,
              fillOpacity: 0.95,
              weight: 1,
            }}
          />
        );
      });
  }

  return dots.length > 0 ? <>{dots}</> : null;
}