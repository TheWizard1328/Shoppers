/**
 * interStoreGeocode.js
 * Geocodes an InterStoreLocation's address and saves lat/lng back to the entity + offline DB.
 * Called lazily the first time a store is used (either as source or destination).
 */

import { base44 } from '@/api/base44Client';
import { offlineDB } from './offlineDatabase';

// In-memory set of location IDs currently being geocoded (prevents duplicate requests)
const geocodingInProgress = new Set();

// Strip ALL non-digit characters for phone comparison
const stripPhone = (s) => (s || '').replace(/\D/g, '');

const matchStoreByPhone = (phone, stores) => {
  const target = stripPhone(phone);
  if (!target) return null;
  return (stores || []).find((s) => s?.latitude && s?.longitude && stripPhone(s.phone) === target) || null;
};

/**
 * Persist lat/lng back to InterStoreLocation entity + offline DB + in-memory cache.
 */
async function saveCoords(location, lat, lng) {
  const updated = await base44.entities.InterStoreLocation.update(location.id, {
    store_latitude: lat,
    store_longitude: lng,
  });
  const record = { ...location, store_latitude: lat, store_longitude: lng, ...(updated || {}) };
  offlineDB.save(offlineDB.STORES.INTER_STORE_LOCATIONS, record).catch(() => null);
  try {
    const { indexInterStoreLocation } = await import('./interStoreDisplayName');
    if (typeof indexInterStoreLocation === 'function') indexInterStoreLocation(record);
  } catch (_) {}
  return record;
}

/**
 * If the given InterStoreLocation record is missing coords, resolves them and saves.
 * Fire-and-forget safe — never throws.
 */
export async function ensureInterStoreCoords(location) {
  if (!location?.id) return;
  if (location.store_latitude && location.store_longitude) return; // already have coords
  if (geocodingInProgress.has(location.id)) return; // already in flight

  geocodingInProgress.add(location.id);
  try {
    let lat = null, lng = null;

    // Step 1: Match via phone number against Store DB
    // Try offline DB first, then API
    let matched = null;
    try {
      const offlineStores = await offlineDB.getAll(offlineDB.STORES.STORES);
      matched = matchStoreByPhone(location.store_phone, offlineStores);
    } catch (_) {}

    if (!matched) {
      try {
        const apiStores = await base44.entities.Store.list();
        matched = matchStoreByPhone(location.store_phone, apiStores);
      } catch (_) {}
    }

    if (matched?.latitude && matched?.longitude) {
      lat = matched.latitude;
      lng = matched.longitude;
    }

    // Step 2: Fall back to Google Geocoding API
    if (!lat || !lng) {
      const addressStr = [location.store_address, location.city].filter(Boolean).join(', ');
      if (addressStr.trim()) {
        const res = await base44.functions.invoke('geocodeAddress', { address: addressStr });
        lat = res?.data?.latitude ?? null;
        lng = res?.data?.longitude ?? null;
      }
    }

    if (!lat || !lng) return;
    await saveCoords(location, lat, lng);

  } catch (_) {
    // Geocoding is best-effort — silent fail
  } finally {
    geocodingInProgress.delete(location.id);
  }
}

/**
 * Backfill coords for ALL InterStoreLocations that are missing lat/lng.
 * Loads stores once, matches by phone, then geocodes any remaining via Google.
 * Safe to call multiple times — skips records that already have coords.
 */
export async function backfillInterStoreCoords() {
  try {
    const [locations, offlineStores] = await Promise.all([
      base44.entities.InterStoreLocation.list(),
      offlineDB.getAll(offlineDB.STORES.STORES).catch(() => []),
    ]);

    const missing = (locations || []).filter((l) => l?.id && (!l.store_latitude || !l.store_longitude));
    if (missing.length === 0) return;

    // Load API stores once as a fallback pool
    let apiStores = null;

    for (const loc of missing) {
      if (geocodingInProgress.has(loc.id)) continue;
      geocodingInProgress.add(loc.id);
      try {
        let lat = null, lng = null;

        // Phone match — offline first
        let matched = matchStoreByPhone(loc.store_phone, offlineStores);
        if (!matched) {
          if (!apiStores) {
            try { apiStores = await base44.entities.Store.list(); } catch (_) { apiStores = []; }
          }
          matched = matchStoreByPhone(loc.store_phone, apiStores);
        }

        if (matched?.latitude && matched?.longitude) {
          lat = matched.latitude;
          lng = matched.longitude;
        }

        // Geocode fallback
        if (!lat || !lng) {
          const addressStr = [loc.store_address, loc.city].filter(Boolean).join(', ');
          if (addressStr.trim()) {
            const res = await base44.functions.invoke('geocodeAddress', { address: addressStr });
            lat = res?.data?.latitude ?? null;
            lng = res?.data?.longitude ?? null;
          }
        }

        if (lat && lng) await saveCoords(loc, lat, lng);
      } catch (_) {
        // per-record silent fail
      } finally {
        geocodingInProgress.delete(loc.id);
      }
    }
  } catch (_) {
    // silent fail
  }
}