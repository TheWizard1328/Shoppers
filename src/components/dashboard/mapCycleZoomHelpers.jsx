export const getPhaseBoundsMaxZoom = (spanKm, fallbackMinZoom = 12.5) => {
  if (!Number.isFinite(spanKm) || spanKm <= 0) {
    return 17.5;
  }

  if (spanKm <= 15) {
    return 17.5;
  }

  return Math.max(
    fallbackMinZoom,
    Math.min(17.5, Math.round((16.8 - Math.log2(spanKm + 1) * 1.05) * 10) / 10)
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