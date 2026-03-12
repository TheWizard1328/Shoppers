import React from 'react';
import { Polyline } from 'react-leaflet';

const getBreadcrumbRouteColor = () => {
  const root = document.documentElement;
  const isDarkMode = root.classList.contains('dark-theme') ||
    (root.classList.contains('auto-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
  return isDarkMode ? '#39FF14' : '#16a34a';
};

/**
 * Renders historical and real-time GPS breadcrumb trails on the map.
 */
export default function MapBreadcrumbs({ breadcrumbsData, safeUsers }) {
  const lines = [];
  const breadcrumbRouteColor = getBreadcrumbRouteColor();

  // Historical breadcrumbs from DeliveryBreadcrumbs entity
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

  // Current/real-time breadcrumbs from offline database
  if (breadcrumbsData.current && breadcrumbsData.current.length > 1) {
    const positions = breadcrumbsData.current
      .map((b) => [Number(b?.lat), Number(b?.lng)])
      .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));

    if (positions.length > 1) {
      lines.push(
        <Polyline
          key="current-breadcrumb-line"
          positions={positions}
          pathOptions={{ color: breadcrumbRouteColor, weight: 3, opacity: 0.95, lineJoin: 'round', lineCap: 'round' }}
        />
      );
    }
  }

  return lines.length > 0 ? <>{lines}</> : null;
}