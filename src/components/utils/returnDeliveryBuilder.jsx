export function buildReturnDeliveryData({ originalDelivery, originalPatient, returnPatient, store, routeDate, routeDateDeliveries, finalStoreId, finalAmpm, currentUser, generateUniqueSID, nextTrackingNumber, patients }) {
  const puid = originalDelivery?.puid || originalDelivery?.stop_id || null;
  // Resolve patient name: prefer passed originalPatient, then look up from patients array by patient_id,
  // then try extracting from existing notes, then fallback
  const resolvedPatient = originalPatient || (patients && originalDelivery?.patient_id ? patients.find((p) => p && p.id === originalDelivery.patient_id) : null);
  const extractedPatientName = originalDelivery?.delivery_notes?.match(/For:\s*(.+?)(?:\n|$)/)?.[1]?.trim();
  const failedPatientName = [
    resolvedPatient?.full_name,
    originalDelivery?.patient_name,
    extractedPatientName && extractedPatientName !== 'Unknown' ? extractedPatientName : null
  ].find((value) => typeof value === 'string' && value.trim() && value.trim() !== 'Unknown') || resolvedPatient?.full_name || 'Unknown';
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
    ampm_deliveries: finalAmpm
  };
}