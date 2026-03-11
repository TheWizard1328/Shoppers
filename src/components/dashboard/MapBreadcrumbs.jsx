import React from 'react';
import { Circle } from 'react-leaflet';

/**
 * Renders historical and real-time GPS breadcrumb trails on the map.
 */
export default function MapBreadcrumbs({ breadcrumbsData, safeUsers }) {
  const circles = [];

  // Historical breadcrumbs from DeliveryBreadcrumbs entity
  if (breadcrumbsData.historical && breadcrumbsData.historical.length > 0) {
    breadcrumbsData.historical.forEach((trail) => {
      if (!trail || !trail.breadcrumbs || !Array.isArray(trail.breadcrumbs)) return;
      const color = '#39FF14';

      trail.breadcrumbs.forEach(([lat, lng], idx) => {
        if (typeof lat !== 'number' || typeof lng !== 'number' || isNaN(lat) || isNaN(lng)) return;
        circles.push(
          <Circle
            key={`historical-breadcrumb-${trail.id}-${idx}`}
            center={[lat, lng]}
            radius={4}
            pathOptions={{ color, fillColor: color, fillOpacity: 0.6, weight: 1, opacity: 0.8 }}
          />
        );
      });
    });
  }

  // Current/real-time breadcrumbs from offline database
  if (breadcrumbsData.current && breadcrumbsData.current.length > 0) {
    const color = '#39FF14';
    breadcrumbsData.current.forEach((b, idx) => {
      if (!b || typeof b.lat !== 'number' || typeof b.lng !== 'number') return;
      circles.push(
        <Circle
          key={`current-breadcrumb-${idx}`}
          center={[b.lat, b.lng]}
          radius={5}
          pathOptions={{ color, fillColor: color, fillOpacity: 0.8, weight: 1.5, opacity: 1 }}
        />
      );
    });
  }

  return circles.length > 0 ? <>{circles}</> : null;
}