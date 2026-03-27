export function isReturnAddress(address) {
  return String(address || '').toUpperCase().includes('(RTN)');
}

export function getReturnCountFromPatientId(delivery, patients = []) {
  if (!delivery?.patient_id) {
    console.log('[Payroll Return Debug] Missing patient_id for delivery', {
      deliveryId: delivery?.id,
      driverId: delivery?.driver_id,
      patientName: delivery?.patient_name || 'Unknown',
      patientId: delivery?.patient_id || 'Missing'
    });
    return 0;
  }

  const patient = patients.find((p) => p && (p.id === delivery.patient_id || p.patient_id === delivery.patient_id));
  const returnCount = isReturnAddress(patient?.address) ? 1 : 0;

  console.log('[Payroll Return Debug] Evaluating return delivery', {
    deliveryId: delivery?.id,
    driverId: delivery?.driver_id,
    patientName: patient?.full_name || delivery?.patient_name || 'Unknown',
    patientId: patient?.patient_id || patient?.id || delivery?.patient_id,
    matchedPatientRecordId: patient?.id || null,
    matchedPatientAddress: patient?.address || 'No address found',
    hasReturnMarker: isReturnAddress(patient?.address),
    returnCount
  });

  return returnCount;
}