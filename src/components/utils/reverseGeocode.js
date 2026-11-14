// Nearest-address lookup for emergency alerts (owner request Nov 14 2026).
//
// The coords go out with the push IMMEDIATELY — a dispatcher must never wait on
// a geocode to learn where a driver is. This helper resolves a street address in
// parallel and is capped at ~1.2s, so a slow or offline lookup degrades to
// "coords only" instead of delaying the alert.
//
// Uses HERE reverse geocoding (the app's existing mapping provider and key).

import { getOrFetchHereApiKey } from './hereApiKeyStore';

const REVGEOCODE_URL = 'https://revgeocode.search.hereapi.com/v1/revgeocode';
const DEFAULT_TIMEOUT_MS = 1200;

export const hasUsableCoords = (latitude, longitude) => {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  // 0,0 is the classic "no fix yet" value some devices report.
  if (Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001) return false;
  return true;
};

export const formatCoords = (latitude, longitude, accuracy = null) => {
  if (!hasUsableCoords(latitude, longitude)) return '';
  const base = `${Number(latitude).toFixed(5)}, ${Number(longitude).toFixed(5)}`;
  const acc = Number(accuracy);
  return Number.isFinite(acc) && acc > 0 ? `${base} (±${Math.round(acc)} m)` : base;
};

export const buildMapUrl = (latitude, longitude) => {
  if (!hasUsableCoords(latitude, longitude)) return '';
  return `https://wego.here.com/?map=${Number(latitude).toFixed(5)},${Number(longitude).toFixed(5)},16,normal`;
};

/**
 * Resolve the nearest street address for a coordinate pair.
 * Never throws; returns null when the lookup cannot complete in time.
 */
export const reverseGeocode = async (latitude, longitude, timeoutMs = DEFAULT_TIMEOUT_MS) => {
  if (!hasUsableCoords(latitude, longitude)) return null;
  let timer = null;
  try {
    const apiKey = await getOrFetchHereApiKey().catch(() => null);
    if (!apiKey) return null;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    timer = setTimeout(() => { try { controller?.abort(); } catch { /* ignore */ } }, timeoutMs);
    const url = `${REVGEOCODE_URL}?at=${Number(latitude).toFixed(5)},${Number(longitude).toFixed(5)}&lang=en&limit=1&apiKey=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, controller ? { signal: controller.signal } : undefined);
    if (!res?.ok) return null;
    const json = await res.json();
    const item = json?.items?.[0];
    const label = item?.address?.label || item?.title || null;
    return label ? String(label).replace(/\s+/g, ' ').trim() : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * Quick GPS fix, biased towards a recent cached position so an alert never
 * waits on a cold satellite lock. Returns null instead of throwing.
 */
export const getQuickPosition = (timeoutMs = 4000) => new Promise((resolve) => {
  try {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy
      }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 }
    );
  } catch {
    resolve(null);
  }
});

export default reverseGeocode;
