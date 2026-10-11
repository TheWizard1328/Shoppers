/**
 * Temp Patient ID Map (Oct 6 2026)
 *
 * When a patient is created while offline (or with the network gate closed),
 * callers link new deliveries to the TEMP id (`temp_patient_...`). Once the
 * patient's queued create syncs, the patient exists under its REAL id, and
 * anything still referencing the temp id is orphaned: "Unknown" stop cards,
 * missing map markers, unmatchable COD items.
 *
 * This module is a tiny localStorage-backed map { tempId -> realId } so any
 * later sync step (queued delivery create/update payloads, IDB remaps) can
 * resolve the temp id to the real one — even across app restarts, since the
 * queue may drain long after the patient create itself.
 */

const STORAGE_KEY = 'rxdeliver_patient_temp_id_map_v1';
const MAX_ENTRIES = 500;

const readMap = () => {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
};

const writeMap = (map) => {
  try {
    if (typeof window === 'undefined') return;
    const keys = Object.keys(map);
    if (keys.length > MAX_ENTRIES) {
      const pruned = {};
      keys.slice(keys.length - MAX_ENTRIES).forEach((k) => { pruned[k] = map[k]; });
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pruned));
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch (_) { /* storage full/blocked — non-fatal */ }
};

/** Record that tempId now resolves to realId. No-ops on identical or missing ids. */
export const recordTempPatientId = (tempId, realId) => {
  if (!tempId || !realId || tempId === realId) return;
  if (!String(tempId).startsWith('temp_patient_')) return;
  const map = readMap();
  if (map[tempId] === realId) return;
  map[tempId] = realId;
  writeMap(map);
};

/** Resolve a patient id that may be a stale temp id. Returns the id to use. */
export const resolveTempPatientId = (patientId) => {
  if (!patientId || typeof patientId !== 'string') return patientId;
  if (!patientId.startsWith('temp_patient_')) return patientId;
  const map = readMap();
  return map[patientId] || patientId;
};
