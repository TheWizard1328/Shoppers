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

const entityIdCache = new Map();   // InterStoreLocation record id -> record

function indexLocations(locs) {
  (locs || []).forEach((loc) => {
    if (loc?.store_phone && loc?.store_name) {
      const digits = String(loc.store_phone).replace(/\D/g, '');
      if (digits) {
        phoneCache.set(digits, loc.store_name);
        locationCache.set(digits, loc);
      }
    }
    if (loc?.id) entityIdCache.set(loc.id, loc);
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
  if (loc?.id) entityIdCache.set(loc.id, loc);
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
      // Persist to IDB so the next boot resolves instantly from IDB instead of
      // re-fetching (and so offline boots have the data at all).
      if (locs && locs.length) {
        offlineDB.bulkSave(offlineDB.STORES.INTER_STORE_LOCATIONS, locs).catch(() => {});
      }
      return locs || [];
    } catch (_) {
      // Do NOT cache a failed fetch forever — the promise previously stayed
      // resolved-with-[] for the whole session, leaving stop names "Unknown"
      // even after the network recovered. Reset so the next call retries.
      allLocationsPromise = null;
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
 * Looks up an InterStoreLocation by its entity ID (the _interstore_source_id or _interstore_dest_id
 * stored on the delivery). Falls back to offlineDB then API. Caches the result.
 * Used by clientRouteEngine to resolve coords for freshly-created ISP/ISD records
 * before the phone-based locationCache is warm.
 */
export async function getInterStoreLocationByEntityId(entityId) {
  if (!entityId) return null;
  // Check if we already have it in locationCache (keyed by phone)
  for (const loc of locationCache.values()) {
    if (loc.id === entityId) return loc;
  }
  // Try offlineDB
  try {
    const { offlineDB: _odb } = await import('./offlineDatabase');
    const allLocs = await _odb.getAll(_odb.STORES.INTER_STORE_LOCATIONS).catch(() => []);
    const found = (allLocs || []).find(l => l?.id === entityId);
    if (found) {
      indexInterStoreLocation(found); // warm the cache
      return found;
    }
  } catch { /* non-fatal */ }
  // Fall back to API
  try {
    const { base44: _b44 } = await import('@/api/base44Client');
    const results = await _b44.entities.InterStoreLocation.filter({ id: entityId }).catch(() => []);
    const found = results?.[0] || null;
    if (found) {
      indexInterStoreLocation(found); // warm the cache
      return found;
    }
  } catch { /* non-fatal */ }
  return null;
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

  // OWNER FEATURE (Oct 22 2026): live GPS updates for InterStore stops — when
  // the driver updates the location's coords (StopCard Update GPS),
  // patientGPSUpdater dispatches 'interStoreGpsUpdated' with the record id;
  // mounted cards adopt the fresh coords immediately (navigation + markers)
  // without waiting for a remount.
  useEffect(() => {
    const onGpsUpdated = (e) => {
      const detail = e?.detail || {};
      if (!detail.id) return;
      setLocation((prev) => (prev?.id === detail.id
        ? { ...prev, store_latitude: detail.latitude, store_longitude: detail.longitude }
        : prev));
    };
    window.addEventListener('interStoreGpsUpdated', onGpsUpdated);
    return () => window.removeEventListener('interStoreGpsUpdated', onGpsUpdated);
  }, []);

  return location;
}

/**
 * INTERSTORE DETECTION THAT DOES NOT TRUST THE ID PREFIX.
 * OWNER REPORT Nov 16 2026: an InterStore drop-off created from the Add To Route form
 * on some paths is saved with a plain `DID-...` delivery_id (no ISD-/ISP- prefix) while
 * its real identity sits in `_interstore_source_id` / `_interstore_dest_id` and in
 * delivery_notes ("InterStore DropOff"). Every prefix-only test then treated that stop
 * as a normal store pickup: it drew as a pickup marker and the edit form opened as
 * "Edit Pickup". These helpers look at the record itself, so the classification
 * survives a reload.
 */
export function getInterStoreKindOf(delivery) {
  if (!delivery) return null;
  const id = String(delivery.delivery_id || '').toUpperCase();
  if (id.startsWith('ISD-')) return 'ISD';
  if (id.startsWith('ISP-')) return 'ISP';
  const notes = String(delivery.delivery_notes || '');
  if (/interstore\s*drop\s*-?\s*off/i.test(notes)) return 'ISD';
  if (/interstore\s*pick\s*-?\s*up/i.test(notes)) return 'ISP';
  // Legacy rows with no notes and no prefix: any interstore pointer means it is one.
  if (delivery._interstore_dest_id || delivery._interstore_source_id) {
    return delivery._interstore_dest_id ? 'ISD' : 'ISP';
  }
  return null;
}

export function isInterStoreRecord(delivery) {
  return !!getInterStoreKindOf(delivery);
}

/** Synchronous InterStoreLocation lookup by the entity id stored on the delivery. */
export function getInterStoreLocationByEntityIdSync(entityId) {
  if (!entityId) return null;
  return entityIdCache.get(entityId) || null;
}

/**
 * Resolve the InterStoreLocation for a record without relying on the id prefix.
 * ISD uses the destination, ISP uses the source. Warms the shared cache first.
 */
export async function resolveInterStoreLocationForRecord(delivery) {
  const kind = getInterStoreKindOf(delivery);
  if (!kind) return null;
  const entityId = kind === 'ISD' ? delivery._interstore_dest_id : delivery._interstore_source_id;
  if (entityId) {
    const cached = entityIdCache.get(entityId);
    if (cached) return cached;
    try {
      const fromApi = await getInterStoreLocationByEntityId(entityId);
      if (fromApi) { indexInterStoreLocation(fromApi); return fromApi; }
    } catch (_) {}
  }
  return resolveInterStoreLocation(delivery.delivery_id);
}

/**
 * DISPLAY NAME FOR AN INTER-STORE STOP — the SAME string the stop card shows
 * (owner report Nov 20 2026: the cycling selection panel listed a Hamptons
 * inter-store drop-off as plain "Hamptons", while its stop card reads
 * "InterStore DropOff"). Card parity lives in useDeliveryDisplayInfo:
 *   ISD → 'InterStore DropOff'      ISP → '{Store Name}(ISP)'
 * Use this anywhere a non-card list has to name an inter-store stop.
 */
export function getInterStoreStopName(delivery) {
  const kind = getInterStoreKindOf(delivery);
  if (!kind) return null;
  if (kind === 'ISD') return 'InterStore DropOff';
  const loc = getInterStoreLocationForRecordSync(delivery);
  return loc?.store_name ? `${loc.store_name}(ISP)` : 'InterStore PickUp';
}

/** Sync variant used while building map markers: entity-id cache first, phone cache second. */
export function getInterStoreLocationForRecordSync(delivery) {
  const kind = getInterStoreKindOf(delivery);
  if (!kind) return null;
  const entityId = kind === 'ISD' ? delivery._interstore_dest_id : delivery._interstore_source_id;
  if (entityId && entityIdCache.get(entityId)) return entityIdCache.get(entityId);
  return getInterStoreLocationSync(delivery.delivery_id);
}
