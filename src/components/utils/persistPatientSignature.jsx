import { offlineDB } from "./offlineDatabase";
import { updatePatient } from "./entityMutations";

export async function persistPatientSignature(patientId, signatureImageUrl) {
  if (!patientId) return null;

  const updates = {
    signature_image_url: signatureImageUrl || null
  };

  const existingPatient = await offlineDB.getById(offlineDB.STORES.PATIENTS, patientId);

  if (existingPatient) {
    return updatePatient(patientId, updates);
  }

  return updatePatient(patientId, updates);
}