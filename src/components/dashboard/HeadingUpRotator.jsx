import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";

export default function HeadingUpRotator({ isMobile, currentDriverMarker }) {
  const map = useMap();
  const prevRef = useRef(null);

  useEffect(() => {
    const container = map?.getContainer?.();
    if (!isMobile || !container) return;
    if (!currentDriverMarker?.latitude || !currentDriverMarker?.longitude) return;

    const toRad = (d) => (d * Math.PI) / 180;
    const toDeg = (r) => (r * 180) / Math.PI;
    const bearing = (lat1, lon1, lat2, lon2) => {
      const φ1 = toRad(lat1), φ2 = toRad(lat2);
      const Δλ = toRad(lon2 - lon1);
      const y = Math.sin(Δλ) * Math.cos(φ2);
      const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
      return (toDeg(Math.atan2(y, x)) + 360) % 360;
    };

    const prev = prevRef.current;
    prevRef.current = { lat: currentDriverMarker.latitude, lon: currentDriverMarker.longitude };
    if (!prev) return;

    const brng = bearing(prev.lat, prev.lon, currentDriverMarker.latitude, currentDriverMarker.longitude);
    if (Number.isFinite(brng)) {
      container.style.transition = "transform 180ms linear";
      container.style.transformOrigin = "50% 50%";
      container.style.transform = `rotate(${-brng}deg)`;
    }
  }, [isMobile, currentDriverMarker?.latitude, currentDriverMarker?.longitude, map]);

  useEffect(() => {
    return () => {
      const container = map?.getContainer?.();
      if (container) container.style.transform = "";
    };
  }, [map]);

  return null;
}