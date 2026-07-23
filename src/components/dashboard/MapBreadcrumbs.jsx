import React, { useMemo } from 'react';
import { Polyline } from 'react-leaflet';

const HISTORICAL_COLOR = '#f97316';
const LIVE_COLOR = '#2563eb';

// 1e5 precision — MUST match the client encoder in locationBreadcrumbService.jsx
const POLY_PRECISION = 1e5;

// Detect corrupted points from the old bitwise-overflow encoder.
function isCorruptedPoint(lat, lng) {
  return (
    !Number.isFinite(lat) || !Number.isFinite(lng) ||
    (Math.abs(lat) > 1 && Math.abs(lng) < 0.01)
  );
}

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

// Downsample an array of [lat, lng] coordinates to at most maxPoints.
// Uses stride-based sampling to preserve the overall shape.
function downsample(coords, maxPoints) {
  if (!Array.isArray(coords) || coords.length <= maxPoints) return coords;
  const stride = Math.ceil(coords.length / maxPoints);
  const result = [];
  for (let i = 0; i < coords.length; i += stride) {
    result.push(coords[i]);
  }
  // Always include the last point for visual continuity
  if (result[result.length - 1] !== coords[coords.length - 1]) {
    result.push(coords[coords.length - 1]);
  }
  return result;
}

// Max points per polyline — prevents memory/render crashes on mobile.
// 2000 points is more than enough for visual accuracy at any zoom level.
const MAX_POINTS_PER_LINE = 2000;

class BreadcrumbErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error) {
    console.warn('⚠️ MapBreadcrumbs render error (suppressed):', error?.message);
  }
  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

function MapBreadcrumbsInner({ breadcrumbsData }) {
  // Memoize the polyline rendering to avoid re-decoding on every render
  const lines = useMemo(() => {
    const result = [];

    // Historical breadcrumbs: each record has encoded_polyline
    const historical = breadcrumbsData?.historical;
    if (Array.isArray(historical) && historical.length > 0) {
      historical.forEach((trail) => {
        if (!trail?.encoded_polyline) return;

        // Use pre-decoded _coords if available, otherwise decode
        let coords = trail._coords && trail._coords.length > 0
          ? trail._coords
          : decodePolyline(trail.encoded_polyline);

        // Filter corrupted/invalid coordinates
        coords = coords.filter(c => !isCorruptedPoint(c[0], c[1]));
        if (coords.length < 2) return;

        // Downsample for performance on mobile
        coords = downsample(coords, MAX_POINTS_PER_LINE);

        result.push(
          <Polyline
            key={`historical-bc-${trail.id || trail.stop_order}`}
            positions={coords}
            pathOptions={{
              color: HISTORICAL_COLOR,
              weight: 3,
              opacity: 0.8,
              dashArray: '6 6',
            }}
          />
        );
      });
    }

    // Live/current breadcrumbs: array of {lat, lng} points
    const current = breadcrumbsData?.current;
    if (Array.isArray(current) && current.length >= 2) {
      let coords = current
        .filter(p => !isCorruptedPoint(p?.lat, p?.lng))
        .map(p => [p.lat, p.lng]);

      if (coords.length >= 2) {
        coords = downsample(coords, MAX_POINTS_PER_LINE);
        result.push(
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

    return result;
  }, [breadcrumbsData]);

  return lines.length > 0 ? <>{lines}</> : null;
}

export default function MapBreadcrumbs({ breadcrumbsData }) {
  return (
    <BreadcrumbErrorBoundary>
      <MapBreadcrumbsInner breadcrumbsData={breadcrumbsData} />
    </BreadcrumbErrorBoundary>
  );
}
