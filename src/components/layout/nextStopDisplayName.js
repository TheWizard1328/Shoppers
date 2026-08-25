/**
 * Resolves a human-readable display name for a delivery stop, used in the
 * persistent tracking notification ("Next: <name>"). Replaces the raw
 * `delivery_id` (DID-…) string that appeared before.
 *
 * Resolution order:
 *   1. InterStore stop → denormalized dest/source name on the delivery
 *   2. Patient delivery → patient full_name (looked up via patient_id)
 *   3. Store pickup → store name (looked up via store_id)
 *   4. Fallback → delivery_id
 *
 * @param {Object} stop      - The Delivery record
 * @param {Array}  patients  - Patient records (from AppDataContext)
 * @param {Array}  stores    - Store records (from AppDataContext)
 * @returns {string|null}
 */
export default function resolveNextStopDisplayName(stop, patients = [], stores = []) {
  if (!stop) return null;

  // InterStore (ISP / ISD) — use the denormalized name fields. Prefer the
  // destination name (the stop you're heading to), fall back to source.
  if (stop._interstore_dest_id || stop._interstore_dest_name ||
      stop._interstore_source_id || stop._interstore_source_name) {
    return stop._interstore_dest_name || stop._interstore_source_name || null;
  }

  // Patient delivery
  if (stop.patient_id) {
    const patient = patients.find(p => p && p.id === stop.patient_id);
    if (patient?.full_name) return patient.full_name;
  }

  // Store pickup (no patient_id)
  if (stop.store_id) {
    const store = stores.find(s => s && s.id === stop.store_id);
    if (store?.name) return store.name;
  }

  return stop.delivery_id || null;
}