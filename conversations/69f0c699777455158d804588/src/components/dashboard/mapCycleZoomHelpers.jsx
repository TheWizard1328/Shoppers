export const getPhaseBoundsMaxZoom = (spanKm, fallbackMinZoom = 12.0) => {
  if (!Number.isFinite(spanKm) || spanKm <= 0) {
    return 18;
  }

  // Smooth linear decay — NO cliffs at any boundary.
  // For small spans (≤8km) maxZoom stays at 18 (tight follow).
  // Between 8–48km it decreases linearly at -0.15 levels/km, so a 1km GPS
  // movement only changes maxZoom by ~0.15 — well within zoomSnap=0.25,
  // preventing the jarring full-level zoom jumps the driver was seeing.
  if (spanKm <= 8) {
    return 18;
  }

  // Linear decay: 18 at 8km → ~12 at ~48km, clamped to fallbackMinZoom.
  // Max change per 0.5km GPS movement = 0.075 levels (negligible).
  const decay = (spanKm - 8) * 0.15;
  const raw = 18 - decay;

  return Math.max(
    fallbackMinZoom,
    Math.min(18, Math.round(raw * 10) / 10)
  );
};

export const getBoundsSpanKm = (coordinates = []) => {
  if (!Array.isArray(coordinates) || coordinates.length === 0) {
    return 0;
  }

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  coordinates.forEach(([lat, lon]) => {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
  });

  const latSpan = maxLat - minLat;
  const lonSpan = maxLon - minLon;
  const maxSpan = Math.max(latSpan, lonSpan);

  return maxSpan * 111.0;
};
