/**
 * Client-side patient matching using IndexedDB.
 *
 * Replaces the server-side patient search in scanPrescriptionLabel.
 * The backend now ONLY does LLM extraction — all matching is done
 * against the offline patient database (rxdeliver_persistent_offline_v2).
 *
 * Matching strategy (mirrors the old server logic):
 *   1. Phone-first: last 7 digits against patient.phone
 *   2. Name fallback: fuzzy name match
 *   3. Address scoring to refine
 *   4. Scoping: dispatcher → their stores, driver → active pickup stores
 */

import { offlineDB } from './offlineDatabase';

// ── Normalizers ──────────────────────────────────────────────────────────────

const normalizePhone = (s) => (s || '').replace(/\D/g, '');

const normalizeAddress = (address) =>
  (address || '')
    .toLowerCase()
    .trim()
    .replace(/\b(avenue|ave|street|st|road|rd|drive|dr|boulevard|blvd|lane|ln)\b/gi, '')
    .replace(/\b(nw|ne|sw|se|north|south|east|west)\b/gi, '')
    .replace(/[,\-\.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// ── Exact match check ────────────────────────────────────────────────────────

const isExactMatch = (patient, extracted) => {
  const patientName = (patient.full_name || '').toLowerCase().trim();
  const extractedName = (extracted.patient_name || '').toLowerCase().trim();
  const nameMatch = patientName === extractedName;

  const patientPhone = normalizePhone(patient.phone);
  const extractedPhone = normalizePhone(extracted.phone_number || '');
  const phoneMatch = patientPhone && extractedPhone && patientPhone === extractedPhone;

  const patientAddressNorm = normalizeAddress(patient.address);
  const extractedAddressNorm = normalizeAddress(extracted.street_address || '');
  const addressMatch = patientAddressNorm && extractedAddressNorm && patientAddressNorm === extractedAddressNorm;

  return nameMatch && (addressMatch || phoneMatch);
};

// ── Fuzzy scoring ─────────────────────────────────────────────────────────────

const calculateMatchScore = (patient, extracted) => {
  if (isExactMatch(patient, extracted)) return 100;

  let score = 0;
  let maxScore = 0;

  // Name matching (weight: 40%)
  maxScore += 40;
  const patientName = (patient.full_name || '').toLowerCase().trim();
  const extractedName = (extracted.patient_name || '').toLowerCase().trim();
  if (patientName === extractedName) {
    score += 40;
  } else if (patientName.includes(extractedName) || extractedName.includes(patientName)) {
    score += 30;
  } else {
    const nameWords = extractedName.split(/\s+/);
    const patientWords = patientName.split(/\s+/);
    const matchedWords = nameWords.filter(word =>
      patientWords.some(pw => pw.includes(word) || word.includes(pw))
    );
    score += (matchedWords.length / nameWords.length) * 40;
  }

  // Address matching (weight: 35%)
  maxScore += 35;
  const patientAddressNorm = normalizeAddress(patient.address);
  const extractedAddressNorm = normalizeAddress(extracted.street_address || '');
  if (patientAddressNorm === extractedAddressNorm) {
    score += 35;
  } else if (patientAddressNorm.includes(extractedAddressNorm) || extractedAddressNorm.includes(patientAddressNorm)) {
    score += 28;
  } else {
    const addressWords = extractedAddressNorm.split(/\s+/).filter(w => w.length > 2);
    const patientAddressWords = patientAddressNorm.split(/\s+/);
    const matchedWords = addressWords.filter(word =>
      patientAddressWords.some(pw => pw.includes(word) || word.includes(pw))
    );
    if (addressWords.length > 0) {
      score += (matchedWords.length / addressWords.length) * 35;
    }
  }

  // Phone matching (weight: 25%)
  maxScore += 25;
  const patientPhone = normalizePhone(patient.phone);
  const extractedPhone = normalizePhone(extracted.phone_number || '');
  if (patientPhone === extractedPhone) {
    score += 25;
  } else if (patientPhone.includes(extractedPhone) || extractedPhone.includes(patientPhone)) {
    score += 15;
  }

  return (score / maxScore) * 100;
};

// ── Scoping ──────────────────────────────────────────────────────────────────

const scopeStoreIds = (appUser, activePickupStoreIds = [], nearestStoreId = null) => {
  if (!appUser) return null;

  const isDispatcher = appUser.app_roles?.includes('dispatcher');
  const isDriver = appUser.app_roles?.includes('driver');
  const isAdmin = appUser.app_roles?.includes('admin');

  if (isAdmin) return null; // Admins search all

  if (isDriver) {
    if (nearestStoreId) {
      const others = (activePickupStoreIds?.length ? activePickupStoreIds : (appUser.store_ids || [])).filter(id => id !== nearestStoreId);
      return [nearestStoreId, ...others];
    }
    return activePickupStoreIds?.length > 0
      ? activePickupStoreIds
      : (appUser.store_ids || []);
  }

  if (isDispatcher) {
    return appUser.store_ids || [];
  }

  return null;
};

// ── Main matching function ───────────────────────────────────────────────────

export const matchPatientFromIDB = async (extractedData, options = {}) => {
  const { appUser, activePickupStoreIds = [], nearestStoreId = null } = options;

  if (!extractedData?.patient_name) {
    console.warn('[patientMatchIDB] No patient_name in extracted data');
    return { extractedData, exactMatches: [], matches: [] };
  }

  const allPatients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
  if (!allPatients || allPatients.length === 0) {
    console.log('[patientMatchIDB] No patients in IDB');
    return { extractedData, exactMatches: [], matches: [] };
  }

  console.log('[patientMatchIDB] ' + allPatients.length + ' patients in IDB');

  const scopedStoreIds = scopeStoreIds(appUser, activePickupStoreIds, nearestStoreId);
  let patients = allPatients;
  if (scopedStoreIds && scopedStoreIds.length > 0) {
    const idSet = new Set(scopedStoreIds);
    patients = allPatients.filter(p => p.store_id && idSet.has(p.store_id));
    console.log('[patientMatchIDB] Scoped to ' + patients.length + ' patients (' + scopedStoreIds.length + ' stores)');

    if (patients.length === 0) {
      console.log('[patientMatchIDB] Scoped search empty — falling back to all patients');
      patients = allPatients;
    }
  }

  // Phone-first narrowing
  const extractedDigits = normalizePhone(extractedData.phone_number || '');
  const last7 = extractedDigits.slice(-7);

  let candidates = patients;

  if (last7.length >= 7) {
    const phoneMatches = patients.filter(p => {
      const pd = normalizePhone(p.phone);
      return pd.includes(last7) || pd.endsWith(last7);
    });
    if (phoneMatches.length > 0) {
      console.log('[patientMatchIDB] Phone narrowing: ' + phoneMatches.length + ' candidates (last7=' + last7 + ')');
      candidates = phoneMatches;
    }
  }

  // Name narrowing (if phone yielded too many or none)
  if (candidates.length === patients.length && extractedData.patient_name) {
    const nameLower = extractedData.patient_name.toLowerCase().trim();
    const nameMatches = patients.filter(p =>
      (p.full_name || '').toLowerCase().includes(nameLower) ||
      nameLower.includes((p.full_name || '').toLowerCase())
    );
    if (nameMatches.length > 0 && nameMatches.length < candidates.length) {
      console.log('[patientMatchIDB] Name narrowing: ' + nameMatches.length + ' candidates');
      candidates = nameMatches;
    }
  }

  // Score all candidates
  const scored = candidates
    .map(patient => ({
      patient,
      matchScore: calculateMatchScore(patient, extractedData),
    }))
    .filter(item => item.matchScore >= 60)
    .sort((a, b) => b.matchScore - a.matchScore);

  console.log('[patientMatchIDB] ' + scored.length + ' matches >=60%');
  if (scored.length > 0) {
    console.log('[patientMatchIDB] Top:', scored.slice(0, 3).map(m => ({
      name: m.patient.full_name, score: Math.round(m.matchScore),
    })));
  }

  const exactMatches = scored.filter(item => item.matchScore === 100);
  const partialMatches = scored.filter(item => item.matchScore < 100);

  return {
    extractedData,
    exactMatches: exactMatches.map(item => ({
      patient: item.patient,
      matchScore: 100,
    })),
    matches: partialMatches.map(item => ({
      patient: item.patient,
      matchScore: Math.round(item.matchScore),
    })),
  };
};
