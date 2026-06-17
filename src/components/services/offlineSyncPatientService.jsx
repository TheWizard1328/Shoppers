export const createOfflineSyncPatientService = ({ offlineDB, Patient, invalidateEntityCache }) => {
  const syncPatientsByIds = async (patientIds = [], batchSize = 50) => {
    const uniquePatientIds = Array.from(new Set((patientIds || []).filter(Boolean)));
    let totalPatients = 0;
    let freshPatients = [];

    for (let i = 0; i < uniquePatientIds.length; i += batchSize) {
      const batchIds = uniquePatientIds.slice(i, i + batchSize);
      const batchPatients = await Patient.filter({ id: { $in: batchIds } });

      if (batchPatients && batchPatients.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, batchPatients);
        invalidateEntityCache('Patient');
        totalPatients += batchPatients.length;
        freshPatients = [...freshPatients, ...batchPatients];
      }

      await new Promise((r) => setTimeout(r, 200));
    }

    await offlineDB.updateSyncMetadata('Patient', new Date().toISOString(), new Date().toISOString());
    return { totalPatients, freshPatients };
  };

  return { syncPatientsByIds };
};