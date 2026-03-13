import React, { useMemo } from 'react';
import { CircleMarker, Polyline } from 'react-leaflet';

const getBreadcrumbRouteColor = () => {
  const root = document.documentElement;
  const isDarkMode = root.classList.contains('dark-theme') ||
    (root.classList.contains('auto-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
  return isDarkMode ? '#39FF14' : '#16a34a';
};

export default function MapBreadcrumbs({ breadcrumbsData, currentZoom = 12 }) {
  const lines = [];
  const breadcrumbRouteColor = getBreadcrumbRouteColor();
  const breadcrumbDotRadius = useMemo(() => {
    const zoom = Number.isFinite(currentZoom) ? currentZoom : 12;
    return Math.max(1.5, Math.min(4.5, 7 - zoom * 0.25));
  }, [currentZoom]);

  if (breadcrumbsData.historical && breadcrumbsData.historical.length > 0) {
    breadcrumbsData.historical.forEach((trail) => {
      if (!trail || !trail.breadcrumbs || !Array.isArray(trail.breadcrumbs)) return;
      const positions = trail.breadcrumbs
        .map(([lat, lng]) => [Number(lat), Number(lng)])
        .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));

      if (positions.length < 2) return;

      lines.push(
        <Polyline
          key={`historical-breadcrumb-line-${trail.id}`}
          positions={positions}
          pathOptions={{ color: breadcrumbRouteColor, weight: 3, opacity: 0.8, lineJoin: 'round', lineCap: 'round' }}
        />
      );
    });
  }

  if (breadcrumbsData.current && breadcrumbsData.current.length > 0) {
    breadcrumbsData.current
      .map((point, index) => ({
        lat: Number(point?.lat),
        lng: Number(point?.lng),
        key: point?.timestamp || index,
      }))
      .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng))
      .forEach((point) => {
        lines.push(
          <CircleMarker
            key={`current-breadcrumb-point-${point.key}`}
            center={[point.lat, point.lng]}
            radius={breadcrumbDotRadius}
            pathOptions={{
              color: breadcrumbRouteColor,
              fillColor: breadcrumbRouteColor,
              fillOpacity: 0.95,
              weight: 1,
            }}
          />
        );
      });
  }

  return lines.length > 0 ? <>{lines}</> : null;
}