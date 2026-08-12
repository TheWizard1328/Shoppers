// Shared Care Pro search-matching helper.
// Used by the Patients page and the Admin Patients table so both use identical
// Care Pro keyword recognition (any common spelling variant) and cp_name field matching.

const CARE_PRO_VARIANTS = [
  'care pro', "care pro's", 'care pros',
  'carepro', 'carepros', "carepro's",
  'care-pro', "care-pro's", 'care-pros',
];

export const isCareProSearch = (searchLower) =>
  CARE_PRO_VARIANTS.some((v) => searchLower.includes(v));

/**
 * Returns true if a patient matches the given search term.
 * Handles Care Pro keyword variants (matches any patient with care_pros=true)
 * and also searches cp_name plus the standard identifying fields.
 */
export const patientMatchesSearch = (patient, searchTerm, extraFields = []) => {
  if (!patient) return false;
  const trimmed = (searchTerm || '').trim();
  if (!trimmed) return true;
  const searchLower = trimmed.toLowerCase();
  if (isCareProSearch(searchLower) && patient.care_pros) return true;
  const searchFields = [
    patient.full_name,
    patient.address,
    patient.phone,
    patient.patient_id,
    patient.id,
    patient.notes,
    patient.cp_name,
    ...extraFields,
  ];
  return searchFields.some((field) => field && String(field).toLowerCase().includes(searchLower));
};

export { CARE_PRO_VARIANTS };