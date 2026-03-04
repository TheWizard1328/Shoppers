export const calculateFannedPosition = (originalLat, originalLng, markerIndex, totalMarkers, stopOrder, currentZoom) => {
  if (currentZoom < 11 || currentZoom > 18) {
    return [originalLat, originalLng];
  }

  const baseRadius = 0.0008;
  const dynamicRadius = 0.0008;
  const radius = baseRadius + (18 - currentZoom) * dynamicRadius;

  let arcWidth;
  if (totalMarkers <= 2) {
    arcWidth = 90;
  } else if (totalMarkers === 3) {
    arcWidth = 120;
  } else if (totalMarkers === 4) {
    arcWidth = 140;
  } else {
    arcWidth = Math.min(180, 140 + (totalMarkers - 4) * 10);
  }

  const arcWidthRad = (arcWidth * Math.PI) / 180;
  const startAngle = (Math.PI / 2) - (arcWidthRad / 2);
  const endAngle = (Math.PI / 2) + (arcWidthRad / 2);

  let angle;
  if (totalMarkers === 1) {
    angle = Math.PI / 2;
  } else {
    const angleStep = (endAngle - startAngle) / (totalMarkers - 1);
    angle = startAngle + ((totalMarkers - 1 - markerIndex) * angleStep);
  }

  const fannedLat = originalLat + radius * Math.sin(angle);
  const fannedLng = originalLng + radius * Math.cos(angle);

  return [fannedLat, fannedLng];
};