/**
 * interStorePolylineCoords.js
 *
 * Resolves the true destination coordinates for ISP/ISD stops for polyline rendering.
 *
 * ISP delivery_id format: ISP-<timestamp>-<pickup_phone>-<dropoff_phone>
 * ISD delivery_id format: ISD-<timestamp>-<pickup_phone>-<dropoff_phone>
 *
 * - ISP (InterStore Pickup): destination is the PICKUP location → phone = parts[2]
 * - ISD (InterStore Dropoff): destination is the DROPOFF location → phone = parts[3]
 *
 * These coords are looked up from the InterStoreLocation database (cached on window).
 */

const stripPhone = (s) => String(s || '').replace(/\D/g, '');

/**
 * Given an ISP/ISD delivery object and the list of all interstore locations,
 * returns { latitude, longitude } for the stop's TRUE destination, or null.
 */
export function resolveInterStoreStopCoords(delivery, interStoreLocations) {
  if (!delivery) return null;
  const did = String(delivery.delivery_id || '');
  const upper = did.toUpperCase();
  if (!upper.startsWith('ISP-') && !upper.startsWith('ISD-')) return null;

  const parts = did.split('-');
  // ISP → pickup phone is parts[2], ISD → dropoff phone is parts[3]
  const targetPhone = upper.startsWith('ISP-') ? stripPhone(parts[2]) : stripPhone(parts[3]);
  if (!targetPhone) return null;

  const locations = Array.isArray(interStoreLocations) ? interStoreLocations : [];
  const loc = locations.find((l) => stripPhone(l?.store_phone) === targetPhone);
  const lat = Number(loc?.store_latitude);
  const lon = Number(loc?.store_longitude);
  if (Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0)) {
    return { latitude: lat, longitude: lon };
  }

  // Also try matching by _interstore_source_id / _interstore_dest_id if set
  const idField = upper.startsWith('ISP-') ? delivery._interstore_source_id : delivery._interstore_dest_id;
  if (idField) {
    const byId = locations.find((l) => l?.id === idField);
    const lat2 = Number(byId?.store_latitude);
    const lon2 = Number(byId?.store_longitude);
    if (Number.isFinite(lat2) && Number.isFinite(lon2) && !(lat2 === 0 && lon2 === 0)) {
      return { latitude: lat2, longitude: lon2 };
    }
  }

  return null;
}

/**
 * Returns true if this stop is an ISP or ISD interstore stop.
 */
export function isInterStoreStop(delivery) {
  const upper = String(delivery?.delivery_id || '').toUpperCase();
  return upper.startsWith('ISP-') || upper.startsWith('ISD-');
}