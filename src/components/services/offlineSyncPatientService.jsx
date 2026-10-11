import { queueEntityRequest } from '../utils/requestQueue';

export const createOfflineSyncPatientService = ({ offlineDB, Patient, invalidateEntityCache }) => {
  const syncPatientsByIds = async (patientIds = [], batchSize = 50) => {
    const uniquePatientIds = Array.from(new Set((patientIds || []).filter(Boolean)));
    let totalPatients = 0;
    let freshPatients = [];

    for (let i = 0; i < uniquePatientIds.length; i += batchSize) {
      const batchIds = uniquePatientIds.slice(i, i + batchSize);
      const batchPatients = await queueEntityRequest(() => Patient.filter({ id: { $in: batchIds } }), 'Patient.filter:byIds');

      if (batchPatients && batchPatients.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, batchPatients);
        invalidateEntityCache('Patient');
        totalPatients += batchPatients.length;
        freshPatients = [...freshPatients, ...batchPatients];
        // Notify the UI immediately — stop cards resolve "Unknown" names as
        // soon as the record lands, instead of waiting for a page reload.
        try { window.dispatchEvent(new CustomEvent('patientsSyncedFromServer', { detail: { patients: batchPatients } })); } catch (_) {}
      }

      await new Promise((r) => setTimeout(r, 200));
    }

    await offlineDB.updateSyncMetadata('Patient', new Date().toISOString(), new Date().toISOString());
    return { totalPatients, freshPatients };
  };

  return { syncPatientsByIds };
};