/**
 * interStoreDisplayName.js
 * Resolves the display name for ISP/ISD inter-store deliveries.
 *
 * delivery_id format: ISP-{timestamp}-{fromPhone}-{toPhone}
 * We extract the fromPhone (digits only) and look it up in InterStoreLocation.
 * Display format: "{Store Name}(ISP)"
 */

import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { offlineDB } from './offlineDatabase';

// Simple in-memory cache: phone digits -> store_name / full location
const phoneCache = new Map();        // digits -> store_name
const locationCache = new Map();     // digits -> full InterStoreLocation record
let allLocationsPromise = null;

function indexLocations(locs) {
  (locs || []).forEach((loc) => {
    if (loc?.store_phone && loc?.store_name) {
      const digits = String(loc.store_phone).replace(/\D/g, '');
      if (digits) {
        phoneCache.set(digits, loc.store_name);
        locationCache.set(digits, loc);
      }
    }
  });
}

/**
 * Reset the fetch promise — call this after bulk-seeding the cache externally
 * (e.g. bootstrap sync) so getAllLocations() doesn't re-run a stale promise.
 */
export function resetInterStoreLocationsCache() {
  allLocationsPromise = null;
}

/**
 * Exported so interStoreGeocode can update the in-memory cache after saving coords.
 */
export function indexInterStoreLocation(loc) {
  if (!loc?.store_phone || !loc?.store_name) return;
  const digits = String(loc.store_phone).replace(/\D/g, '');
  if (digits) {
    phoneCache.set(digits, loc.store_name);
    locationCache.set(digits, loc);
  }
}

export async function getAllLocations() {
  if (allLocationsPromise) return allLocationsPromise;

  allLocationsPromise = (async () => {
    // 1. Try offline DB first (instant, no network)
    try {
      const offline = await offlineDB.getAll(offlineDB.STORES.INTER_STORE_LOCATIONS);
      if (offline && offline.length > 0) {
        indexLocations(offline);
        return offline;
      }
    } catch (_) {}

    // 2. Fall back to API
    try {
      const locs = await base44.entities.InterStoreLocation.list();
      indexLocations(locs);
      return locs || [];
    } catch (_) {
      return [];
    }
  })();

  return allLocationsPromise;
}

/**
 * Parses an ISP/ISD delivery_id into its components.
 * Format: ISP-{timestamp}-{pickupLocationPhone10}-{assignedStorePhone10}
 *   - pickupLocationPhone (parts[2]): matched against InterStoreLocation.store_phone
 *   - assignedStorePhone  (parts[3]): matched against Store.phone
 * Returns null if not an ISP/ISD delivery.
 */
export function parseInterStoreDeliveryId(delivery_id) {
  if (!delivery_id) return null;
  const upper = String(delivery_id).toUpperCase();
  const isISP = upper.startsWith('ISP-');
  const isISD = upper.startsWith('ISD-');
  if (!isISP && !isISD) return null;
  const parts = String(delivery_id).split('-');
  if (parts.length < 3) return null;
  return {
    type: isISP ? 'ISP' : 'ISD',
    timestamp: parts[1] || null,
    pickupLocationPhone: parts[2] ? parts[2].replace(/\D/g, '') : null,
    assignedStorePhone: parts[3] ? parts[3].replace(/\D/g, '') : null,
  };
}

/**
 * Extracts the relevant phone digits from an ISP/ISD delivery_id.
 * ISP = driver picks up FROM the source store → use pickupLocationPhone (parts[2])
 * ISD = driver drops off TO the dest store   → use assignedStorePhone (parts[3])
 * Returns null if not an ISP/ISD delivery.
 */
export function extractFromPhoneFromDeliveryId(delivery_id) {
  const parsed = parseInterStoreDeliveryId(delivery_id);
  if (!parsed) return null;
  // ISP → driver picks up FROM the InterStoreLocation identified by pickupLocationPhone (parts[2]).
  // ISD → driver drops off AT the InterStoreLocation identified by assignedStorePhone (parts[3]).
  if (parsed.type === 'ISD') return parsed.assignedStorePhone || null;
  return parsed.pickupLocationPhone || null;
}

/**
 * Extracts the assigned store phone digits (parts[3]) from an ISP delivery_id.
 * This is matched against Store.phone to identify which Store the ISP belongs to.
 * Returns null if not an ISP delivery or no assignedStorePhone present.
 */
export function extractAssignedStorePhoneFromDeliveryId(delivery_id) {
  const parsed = parseInterStoreDeliveryId(delivery_id);
  if (!parsed) return null;
  return parsed.assignedStorePhone || null;
}

export function isInterStoreDelivery(delivery_id) {
  if (!delivery_id) return false;
  const upper = String(delivery_id).toUpperCase();
  return upper.startsWith('ISP-') || upper.startsWith('ISD-');
}

/**
 * Synchronously resolves the relevant InterStoreLocation record for a delivery_id.
 * ISP → from-store (pickup location), ISD → to-store (dropoff location).
 * Returns null if not cached yet.
 */
export function getInterStoreLocationSync(delivery_id) {
  const phone = extractFromPhoneFromDeliveryId(delivery_id);
  if (!phone) return null;
  return locationCache.get(phone) || null;
}

/**
 * Synchronously looks up an InterStoreLocation record by phone digits from the shared cache.
 * Returns null if not cached yet.
 */
export function getInterStoreLocationByPhone(phoneDigits) {
  if (!phoneDigits) return null;
  const digits = String(phoneDigits).replace(/\D/g, '');
  return locationCache.get(digits) || null;
}

/**
 * Resolves the store name for the "from" store of an ISP delivery.
 * Returns null if not found.
 */
export async function resolveInterStoreFromName(delivery_id) {
  const fromPhone = extractFromPhoneFromDeliveryId(delivery_id);
  if (!fromPhone) return null;
  if (phoneCache.has(fromPhone)) return phoneCache.get(fromPhone);
  await getAllLocations();
  return phoneCache.get(fromPhone) || null;
}

/**
 * Resolves the full InterStoreLocation record for the "from" store of an ISP delivery.
 * Returns null if not found.
 */
export async function resolveInterStoreLocation(delivery_id) {
  const fromPhone = extractFromPhoneFromDeliveryId(delivery_id);
  if (!fromPhone) return null;
  if (locationCache.has(fromPhone)) return locationCache.get(fromPhone);
  await getAllLocations();
  return locationCache.get(fromPhone) || null;
}

/**
 * React hook that resolves and returns the formatted ISP display name.
 * Returns null if not an ISP delivery or while loading.
 */
export function useInterStoreDisplayName(delivery_id) {
  const [name, setName] = useState(() => {
    const fromPhone = extractFromPhoneFromDeliveryId(delivery_id);
    if (!fromPhone) return null;
    const cached = phoneCache.get(fromPhone);
    return cached ? `${cached}(ISP)` : null;
  });

  useEffect(() => {
    if (!isInterStoreDelivery(delivery_id)) return;
    let cancelled = false;
    resolveInterStoreFromName(delivery_id).then((storeName) => {
      if (!cancelled && storeName) setName(`${storeName}(ISP)`);
    });
    return () => { cancelled = true; };
  }, [delivery_id]);

  return name;
}

/**
 * React hook that resolves and returns the full InterStoreLocation record.
 * Returns null if not an ISP/ISD delivery or while loading.
 * Uses shared in-memory cache — safe to call in many StopCard instances.
 */
export function useInterStoreLocation(delivery_id) {
  const [location, setLocation] = useState(() => {
    const fromPhone = extractFromPhoneFromDeliveryId(delivery_id);
    if (!fromPhone) return null;
    return locationCache.get(fromPhone) || null;
  });

  useEffect(() => {
    if (!isInterStoreDelivery(delivery_id)) { setLocation(null); return; }
    let cancelled = false;
    resolveInterStoreLocation(delivery_id).then((loc) => {
      if (!cancelled) setLocation(loc || null);
    });
    return () => { cancelled = true; };
  }, [delivery_id]);

  return location;
}