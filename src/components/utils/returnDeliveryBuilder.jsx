export function resolveFailedPatientName({ originalDelivery, originalPatient, patients }) {
  // Resolve patient name: prefer passed originalPatient, then look up from patients array by patient_id,
  // then try extracting from existing notes, then fallback
  const resolvedPatient = originalPatient || (patients && originalDelivery?.patient_id ? patients.find((p) => p && p.id === originalDelivery.patient_id) : null);
  const extractedPatientName = originalDelivery?.delivery_notes?.match(/For:\s*(.+?)(?:\n|$)/)?.[1]?.trim();
  return [
    resolvedPatient?.full_name,
    originalDelivery?.patient_name,
    extractedPatientName && extractedPatientName !== 'Unknown' ? extractedPatientName : null
  ].find((value) => typeof value === 'string' && value.trim() && value.trim() !== 'Unknown') || resolvedPatient?.full_name || 'Unknown';
}

// ── Return km override (owner spec Nov 4 2026) ───────────────────────────────
// "if the delivery extra kilometer override is blank then we use the patient's
// distance from store otherwise it's the delivery's extra kilometer override
// field". The FAILED delivery's patient is the distance source; the store's
// Return patient only lends its name/phone to the return stop.
export function resolveReturnKmOverride({ originalDelivery, patients, originalPatient }) {
  const deliveryOverride = Number(originalDelivery?.paid_km_override);
  if (Number.isFinite(deliveryOverride) && deliveryOverride > 0) return deliveryOverride;
  const failedPatientId = originalDelivery?.patient_id || null;
  const failedPatient = failedPatientId
    ? ((patients || []).find((p) => p && p.id === failedPatientId)
        || (originalPatient && originalPatient.id === failedPatientId ? originalPatient : null))
    : null;
  const patientKm = Number(failedPatient?.distance_from_store);
  if (Number.isFinite(patientKm) && patientKm > 0) return patientKm;
  return null;
}

export function buildReturnDeliveryData({ originalDelivery, originalPatient, returnPatient, store, routeDate, routeDateDeliveries, finalStoreId, finalAmpm, currentUser, generateUniqueSID, nextTrackingNumber, patients, preferredTravelMode }) {
  const puid = originalDelivery?.puid || originalDelivery?.stop_id || null;
  const failedPatientName = resolveFailedPatientName({ originalDelivery, originalPatient, patients });
  const driverNotes = `From: ${originalDelivery?.delivery_date}\nFor: ${failedPatientName}\n(RTN)`;

  return {
    delivery_id: `DID-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
    created_by_app_user_id: currentUser?.id || null,
    dispatcher_id: originalDelivery?.dispatcher_id || null,
    patient_id: returnPatient?.id,
    store_id: finalStoreId,
    driver_id: originalDelivery?.driver_id,
    driver_name: originalDelivery?.driver_name,
    delivery_date: routeDate,
    delivery_time_start: originalDelivery?.delivery_time_start,
    delivery_time_end: originalDelivery?.delivery_time_end,
    status: 'in_transit',
    delivery_notes: driverNotes,
    patient_name: returnPatient?.full_name,
    patient_phone: returnPatient?.phone || store?.phone || '',
    store_phone: store?.phone || '',
    stop_id: generateUniqueSID(routeDateDeliveries || []),
    puid,
    tracking_number: String(nextTrackingNumber),
    // Owner spec Nov 4 2026: a brand-new return for this store inherits the
    // failed delivery's km override, or the failed patient's distance from
    // store when that override is blank. An existing return stop keeps the
    // LARGER of its own override and this value (handled in the merge path).
    paid_km_override: resolveReturnKmOverride({ originalDelivery, patients, originalPatient: null }),
    // Owner spec Nov 4 2026: fridge and oversized handling follows the item back
    // to the store, so a failed delivery carrying either flag passes it to the
    // return stop (temperature chain + handling both apply on the way back).
    fridge_item: originalDelivery?.fridge_item === true,
    oversized: originalDelivery?.oversized === true,
    ampm_deliveries: finalAmpm,
    transport_mode: (() => {
      // Prefer original delivery's transport_mode, then infer from route's other stops, then driver preference
      if (originalDelivery?.transport_mode) return originalDelivery.transport_mode;
      if (routeDateDeliveries && routeDateDeliveries.length > 0) {
        const modes = routeDateDeliveries.filter((d) => d?.transport_mode).map((d) => d.transport_mode);
        if (modes.length > 0) {
          const counts = modes.reduce((acc, m) => { acc[m] = (acc[m] || 0) + 1; return acc; }, {});
          return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
        }
      }
      return preferredTravelMode || 'driving';
    })()
  };
}

// ── Return-merge helpers ─────────────────────────────────────────────────────
// When a return is requested for a failed delivery, the driver's route may already
// contain an incomplete return stop for the same store (created by an earlier
// failed delivery from that store). Instead of creating a second return stop, the
// new patient's name is appended to the existing return's notes as "And: <name>"
// directly below the original "For: <name>" line.

const EDM_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit' });
export const getEdmontonDate = () => {
  const p = EDM_DATE_FORMATTER.formatToParts(new Date());
  return `${p.find(x => x.type === 'year').value}-${p.find(x => x.type === 'month').value}-${p.find(x => x.type === 'day').value}`;
};

/**
 * Find an existing incomplete return stop for the same store on the driver's route.
 * Match criteria: same driver, same route date, patient_id = the store's return
 * patient record, non-terminal status (still on the route), and not the delivery
 * being returned. Returns the earliest-in-route (lowest stop_order) match, or null.
 */
export function findExistingReturnDelivery({ allDeliveries = [], originalDelivery, returnPatient, routeDate }) {
  if (!returnPatient?.id || !originalDelivery?.driver_id || !routeDate) return null;
  const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
  const candidates = (allDeliveries || []).filter((d) =>
    d
    && d.id !== originalDelivery.id
    && d.patient_id === returnPatient.id
    && d.driver_id === originalDelivery.driver_id
    && d.delivery_date === routeDate
    && !TERMINAL.has(String(d.status || ''))
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (Number(a.stop_order) || 99999) - (Number(b.stop_order) || 99999));
  return candidates[0];
}

/**
 * Append a returned patient's name to an existing return stop's notes as
 * "And: <name>" on the line directly below the "For:" line (keeping "(RTN)" last).
 * Multiple merges stack additional "And:" lines below the first one.
 */
export function buildMergedReturnNotes(existingNotes, failedPatientName) {
  const notes = String(existingNotes || '').split('\n');
  const name = String(failedPatientName || 'Unknown').trim();
  const andLine = `And: ${name}`;

  // Already merged for this patient? Don't duplicate the line.
  if (notes.some((l) => l.trim() === andLine)) return notes.join('\n');

  const forIdx = notes.findIndex((l) => /^\s*For:/i.test(l));
  if (forIdx >= 0) {
    // Insert directly below the For: line (or below the last existing And: line).
    let insertAt = forIdx + 1;
    while (insertAt < notes.length && /^\s*And:/i.test(notes[insertAt])) insertAt++;
    notes.splice(insertAt, 0, andLine);
    return notes.join('\n');
  }
  const fromIdx = notes.findIndex((l) => /^\s*From:/i.test(l));
  if (fromIdx >= 0) {
    notes.splice(fromIdx + 1, 0, andLine);
    return notes.join('\n');
  }
  // No recognizable structure — prepend so it's visible.
  notes.unshift(andLine);
  return notes.join('\n');
}
