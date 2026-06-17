// Mirrors the matching logic from the updateMatchingPatientGPS backend function.
// Used by PatientGPSUpdatesDialog to compute matches client-side from offline DB.

const MATCH_RADIUS_KM = 0.15;

const STREET_TYPE_MAP = {
  avenue: 'ave', ave: 'ave', street: 'st', st: 'st', road: 'rd', rd: 'rd',
  drive: 'dr', dr: 'dr', boulevard: 'blvd', blvd: 'blvd', trail: 'trl', trl: 'trl',
  crescent: 'cres', cres: 'cres', court: 'ct', ct: 'ct', lane: 'ln', ln: 'ln',
  place: 'pl', pl: 'pl', parkway: 'pkwy', pkwy: 'pkwy', highway: 'hwy', hwy: 'hwy',
  terrace: 'ter', ter: 'ter', way: 'way'
};

const STREET_TYPES = new Set(Object.values(STREET_TYPE_MAP));

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeStreetToken(token) {
  return STREET_TYPE_MAP[token] || token;
}

export function extractStreetKey(address) {
  let value = String(address || '').toLowerCase();
  value = value.split(',')[0] || value;
  // Normalize compass directions BEFORE stripping so "Northwest" matches "NW"
  value = value
    .replace(/\bnorthwest\b/g, 'nw')
    .replace(/\bnortheast\b/g, 'ne')
    .replace(/\bsouthwest\b/g, 'sw')
    .replace(/\bsoutheast\b/g, 'se')
    .replace(/\bnorth\b/g, 'n')
    .replace(/\bsouth\b/g, 's')
    .replace(/\beast\b/g, 'e')
    .replace(/\bwest\b/g, 'w');
  value = value
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(?:buzz|buzzer|buz)\s*[:.-]?\s*[a-z0-9-]+\b/g, ' ')
    .replace(/\b(?:apt|apartment|suite|ste|unit|room|rm|floor|fl)\s*[:.-]?\s*[a-z0-9-]+\b/g, ' ')
    .replace(/#\s*[a-z0-9-]+\b/g, ' ')
    .replace(/[.,]/g, ' ')
    .replace(/\b(?:n|s|e|w|ne|nw|se|sw)\b/g, ' ');

  const tokens = normalizeWhitespace(value).split(' ').filter(Boolean).map(normalizeStreetToken);
  if (tokens.length === 0) return '';

  if (/^\d/.test(tokens[0])) {
    const collected = [];
    for (const token of tokens) {
      collected.push(token);
      if (STREET_TYPES.has(token)) break;
    }
    return normalizeWhitespace(collected.join(' '));
  }

  const streetTypeIndexes = tokens.map((token, index) => (STREET_TYPES.has(token) ? index : -1)).filter((index) => index >= 0);
  if (streetTypeIndexes.length >= 2) return normalizeWhitespace(tokens.slice(0, streetTypeIndexes[1] + 1).join(' '));
  if (streetTypeIndexes.length === 1) return normalizeWhitespace(tokens.slice(0, streetTypeIndexes[0] + 1).join(' '));
  return normalizeWhitespace(tokens.slice(0, 4).join(' '));
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/**
 * Given a log entry and the full local patients array, return matching patients.
 * Mirrors the backend previewAll matching logic exactly.
 */
export function findMatchingPatients(log, allPatients) {
  const sourcePatientId = log.source_patient_id || log.patient_id;
  const sourcePatient = allPatients.find((p) => p?.id === sourcePatientId);
  if (!sourcePatient) return [];

  const sourceStreetKey = extractStreetKey(sourcePatient.address);
  if (!sourceStreetKey) return [];

  const newLat = Number(log.new_latitude);
  const newLon = Number(log.new_longitude);
  const hasNewCoords = Number.isFinite(newLat) && Number.isFinite(newLon);

  const seen = new Set([sourcePatientId]);
  const matching = [];

  for (const p of allPatients) {
    if (!p?.id || seen.has(p.id)) continue;
    const key = extractStreetKey(p.address);
    if (!key || key !== sourceStreetKey) continue;

    const pLat = Number(p.latitude);
    const pLon = Number(p.longitude);
    const hasCoords = Number.isFinite(pLat) && Number.isFinite(pLon);
    const withinRadius = !hasCoords || (hasNewCoords && haversineKm(pLat, pLon, newLat, newLon) <= MATCH_RADIUS_KM);
    if (!withinRadius) continue;

    matching.push(p);
    seen.add(p.id);
  }

  return matching;
}