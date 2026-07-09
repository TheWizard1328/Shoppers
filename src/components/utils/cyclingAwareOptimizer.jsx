/**
 * cyclingAwareOptimizer.jsx
 *
 * Detects whether a driver's current delivery list has an active cycling segment
 * (an unfinished set of stops between a cycling start marker and a cycling end marker).
 *
 * Returns null if no active cycling segment exists, or a descriptor object if one does.
 */

const FINISHED = new Set(['completed', 'failed', 'cancelled', 'returned']);

/**
 * Detect an active cycling segment in the given delivery list.
 *
 * @param {Array} deliveries  - All deliveries for a single driver on a single date
 * @param {Array} patients    - Full patients list (for coordinate lookup)
 * @param {Array} stores      - Full stores list (for coordinate lookup)
 * @returns {object|null}
 *   null — no active cycling segment
 *   {
 *     startMarker,               // the cycling-start delivery record
 *     endMarker,                 // the cycling-end delivery record
 *     endMarkerCoords,           // { lat, lon }
 *     cyclingOriginCoords,       // { lat, lon } — first unfinished cycling stop coords
 *     unfinishedCyclingStopIds,  // string[]
 *   }
 */
export function detectActiveCyclingSegment(deliveries, patients, stores) {
  if (!deliveries || deliveries.length === 0) return null;

  // Sort by stop_order so we iterate in route order
  const sorted = [...deliveries].sort((a, b) => (a.stop_order ?? 0) - (b.stop_order ?? 0));

  // Find start + end cycling markers
  const startMarker = sorted.find((d) => d.is_cycling_marker && d.cycling_marker_type === 'start');
  const endMarker = sorted.find((d) => d.is_cycling_marker && d.cycling_marker_type === 'end');

  if (!startMarker || !endMarker) return null;

  // The segment is "active" only if neither marker is finished
  if (FINISHED.has(startMarker.status) && FINISHED.has(endMarker.status)) return null;
  if (FINISHED.has(endMarker.status)) return null;

  const startOrder = Number(startMarker.stop_order ?? 0);
  const endOrder = Number(endMarker.stop_order ?? 0);

  // Stops strictly between start and end markers
  const cyclingStops = sorted.filter((d) => {
    const ord = Number(d.stop_order ?? 0);
    return !d.is_cycling_marker && ord > startOrder && ord < endOrder;
  });

  const unfinishedCyclingStops = cyclingStops.filter((d) => !FINISHED.has(d.status));
  const unfinishedCyclingStopIds = unfinishedCyclingStops.map((d) => d.id);

  // Resolve end-marker coordinates (from the endMarker's patient or store)
  const endMarkerCoords = resolveDeliveryCoords(endMarker, patients, stores);
  if (!endMarkerCoords) return null;

  // Resolve cycling origin — first unfinished cycling stop, fallback to start marker
  const firstUnfinished = unfinishedCyclingStops[0] || cyclingStops[0];
  const cyclingOriginCoords = firstUnfinished
    ? resolveDeliveryCoords(firstUnfinished, patients, stores)
    : resolveDeliveryCoords(startMarker, patients, stores);

  if (!cyclingOriginCoords) return null;

  return {
    startMarker,
    endMarker,
    endMarkerCoords,
    cyclingOriginCoords,
    unfinishedCyclingStopIds,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveDeliveryCoords(delivery, patients, stores) {
  if (!delivery) return null;

  // Direct lat/lon on the delivery record
  if (delivery.latitude && delivery.longitude) {
    return { lat: Number(delivery.latitude), lon: Number(delivery.longitude) };
  }

  // From linked patient
  if (delivery.patient_id && patients) {
    const patient = patients.find((p) => p?.id === delivery.patient_id);
    if (patient?.latitude && patient?.longitude) {
      return { lat: Number(patient.latitude), lon: Number(patient.longitude) };
    }
  }

  // From linked store
  if (delivery.store_id && stores) {
    const store = stores.find((s) => s?.id === delivery.store_id);
    if (store?.latitude && store?.longitude) {
      return { lat: Number(store.latitude), lon: Number(store.longitude) };
    }
  }

  return null;
}