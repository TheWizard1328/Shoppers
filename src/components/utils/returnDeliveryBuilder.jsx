export function buildReturnDeliveryData({ originalDelivery, returnPatient, store, routeDate, routeDateDeliveries, finalStoreId, finalAmpm, currentUser, generateUniqueSID, nextTrackingNumber }) {
  const puid = originalDelivery?.puid || originalDelivery?.stop_id || null;
  const failedPatientName = originalDelivery?.patient_name || originalDelivery?.delivery_notes?.match(/For:\s*(.+?)(?:\n|$)/)?.[1]?.trim() || originalDelivery?.full_name || 'Unknown';
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