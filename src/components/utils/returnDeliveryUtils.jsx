export function isReturnAddress(address) {
  return String(address || '').toUpperCase().includes('(RTN)');
}

export function getReturnCountFromPatientId(delivery, patients = []) {
  if (!delivery?.patient_id) return 0;
  const patient = patients.find((p) => p && (p.id === delivery.patient_id || p.patient_id === delivery.patient_id));
  return isReturnAddress(patient?.address) ? 1 : 0;
}