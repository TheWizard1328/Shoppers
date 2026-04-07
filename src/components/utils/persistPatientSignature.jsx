import { base44 } from "@/api/base44Client";
import { offlineDB } from "./offlineDatabase";
import { updatePatientLocal } from "./offlineMutations";

export async function persistPatientSignature(patientId, signatureImageUrl) {
  if (!patientId) return null;

  const updates = {
    signature_image_url: signatureImageUrl || null
  };

  const existingPatient = await offlineDB.getById(offlineDB.STORES.PATIENTS, patientId);

  if (existingPatient) {
    return updatePatientLocal(patientId, updates);
  }

  const updatedPatient = await base44.entities.Patient.update(patientId, updates);
  await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, [updatedPatient]);
  return updatedPatient;
}