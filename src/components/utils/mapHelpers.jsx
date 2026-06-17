/**
 * Returns true if the current device is running iOS (iPhone, iPad, iPod).
 */
export const isIOS = () => {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
};

/**
 * Returns a Google Maps web URL for the given address.
 */
export const getMapsUrl = (address) => {
  if (!address) return null;
  const encoded = encodeURIComponent(address);
  return `https://www.google.com/maps/dir/?api=1&destination=${encoded}`;
};

/**
 * Opens navigation for the given address.
 * On iOS (PWA): tries Google Maps app first, then Apple Maps app, then falls back to opening
 * Google Maps in a new Safari tab (outside the PWA webview) using a universal link.
 * On other platforms: opens Google Maps in a new tab.
 */
export const openInMaps = (address) => {
  if (!address) return;
  const encoded = encodeURIComponent(address);

  if (isIOS()) {
    // Try Google Maps native app first via its URL scheme
    const googleMapsApp = `comgooglemaps://?daddr=${encoded}&directionsmode=driving`;
    // Apple Maps native app scheme
    const appleMapsApp = `maps://?daddr=${encoded}`;
    // Final fallback: open Google Maps in Safari (new tab, outside PWA webview)
    const googleMapsWeb = `https://www.google.com/maps/dir/?api=1&destination=${encoded}`;

    // Attempt Google Maps app; if the page is still visible after 300ms it didn't open
    window.location.href = googleMapsApp;

    setTimeout(() => {
      if (document.visibilityState !== 'visible') return; // Google Maps app opened
      // Try Apple Maps app
      window.location.href = appleMapsApp;

      setTimeout(() => {
        if (document.visibilityState !== 'visible') return; // Apple Maps app opened
        // Neither app installed — open in a new Safari tab
        window.open(googleMapsWeb, '_blank');
      }, 300);
    }, 300);
  } else {
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${encoded}`, '_blank');
  }
};

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