/**
 * deliveryTypeUtils.js
 *
 * APP-WIDE delivery type classification rules.
 *
 * A delivery without a patient_id can be one of three things:
 *
 *   1. ISP (Inter-Store Pickup)  — delivery_id starts with "ISP-"
 *      • Driver picks up from an InterStoreLocation
 *      • Location data comes from InterStoreLocation (offline DB)
 *
 *   2. ISD (Inter-Store Drop-off) — delivery_id starts with "ISD-"
 *      • Driver drops off at an InterStoreLocation
 *      • Location data comes from InterStoreLocation (offline DB)
 *
 *   3. Store Pickup               — no patient_id, not ISP/ISD
 *      • Driver picks up from a Store
 *      • Location data comes from Store (offline DB)
 *
 * A delivery WITH a patient_id is always a standard patient delivery.
 */

/**
 * Returns true if the delivery_id indicates an inter-store transfer (ISP or ISD).
 */
export function isInterStoreDeliveryId(delivery_id) {
  if (!delivery_id) return false;
  const upper = String(delivery_id).toUpperCase();
  return upper.startsWith('ISP-') || upper.startsWith('ISD-');
}

/**
 * Returns 'ISP', 'ISD', 'STORE_PICKUP', or 'PATIENT_DELIVERY'.
 */
export function getDeliveryType(delivery) {
  if (!delivery) return 'PATIENT_DELIVERY';
  if (delivery.patient_id) return 'PATIENT_DELIVERY';

  const upper = String(delivery.delivery_id || '').toUpperCase();
  if (upper.startsWith('ISP-')) return 'ISP';
  if (upper.startsWith('ISD-')) return 'ISD';
  return 'STORE_PICKUP';
}

/**
 * Convenience flags derived from getDeliveryType.
 */
export function getDeliveryTypeFlags(delivery) {
  const type = getDeliveryType(delivery);
  return {
    type,
    isPatientDelivery: type === 'PATIENT_DELIVERY',
    isStorePickup:     type === 'STORE_PICKUP',
    isISP:             type === 'ISP',
    isISD:             type === 'ISD',
    isInterStore:      type === 'ISP' || type === 'ISD',
    /** Only a store pickup — ISP and ISD are deliveries, not pickups */
    isPickup:          type === 'STORE_PICKUP',
  };
}

/**
 * Resolves the stop location for a delivery from already-loaded data.
 *
 * @param {object} delivery
 * @param {object|null} patient      - resolved patient record (or null)
 * @param {object|null} store        - resolved Store record (or null)
 * @param {object|null} interStoreLoc - resolved InterStoreLocation record (or null)
 * @returns {{ latitude, longitude, address, name, phone }}
 */
export function resolveStopLocation(delivery, patient, store, interStoreLoc) {
  const { isPatientDelivery, isInterStore, isStorePickup } = getDeliveryTypeFlags(delivery);

  if (isPatientDelivery && patient) {
    return {
      latitude:  patient.latitude,
      longitude: patient.longitude,
      address:   patient.address,
      name:      patient.full_name,
      phone:     patient.phone,
    };
  }

  if (isInterStore && interStoreLoc) {
    return {
      latitude:  interStoreLoc.store_latitude,
      longitude: interStoreLoc.store_longitude,
      address:   interStoreLoc.store_address,
      name:      interStoreLoc.store_name,
      phone:     interStoreLoc.store_phone,
    };
  }

  if (isStorePickup && store) {
    return {
      latitude:  store.latitude,
      longitude: store.longitude,
      address:   store.address,
      name:      store.name,
      phone:     store.phone,
    };
  }

  return { latitude: null, longitude: null, address: null, name: null, phone: null };
}