// Central delivery identity stamping.
//
// Every Delivery record must carry two identity fields, and neither may be
// blank. Owner report Nov 7 2026: 27 historical rows had a null delivery_id
// (the Driver Legend silently dropped them because it tested for the DID
// prefix) and 1126 rows had a null company_id.
//
//   delivery_id -> DID-<epoch ms>-<9 chars>   (BIK- for a cycling marker)
//   company_id  -> the logistics company that owns the stop (RGistics)
//
// resolveDeliveryCompanyId is deliberately tolerant about WHICH user object it
// is handed. The dashboard's currentUser can be the auth user, which has no
// company_id, while the matching AppUser record does. The cached value is
// seeded by every write, so only the very first write on a fresh device ever
// falls through to the logistics company constant.

export const LOGISTICS_COMPANY_ID = '69c753c2d8261cec3a2a2b81'; // RGistics
const CACHE_KEY = 'rxdeliver_company_id';

let cachedCompanyId = null;

export const rememberCompanyId = (id) => {
  const value = String(id || '').trim();
  if (!value) return;
  cachedCompanyId = value;
  try {
    localStorage.setItem(CACHE_KEY, value);
  } catch {
    /* storage unavailable — the in-memory cache still holds it */
  }
};

export const getCachedCompanyId = () => {
  if (cachedCompanyId) return cachedCompanyId;
  try {
    const stored = localStorage.getItem(CACHE_KEY);
    if (stored) {
      cachedCompanyId = stored;
      return stored;
    }
  } catch {
    /* ignore */
  }
  return null;
};

export const resolveDeliveryCompanyId = (currentUser) => {
  const fromUser = String(currentUser?.company_id || '').trim();
  if (fromUser) {
    rememberCompanyId(fromUser);
    return fromUser;
  }
  return getCachedCompanyId() || LOGISTICS_COMPANY_ID;
};

export const isCyclingMarkerPayload = (d) =>
  d?.is_cycling_marker === true || String(d?.delivery_notes || '').includes('Cycling Route');

export const generateDeliveryIdValue = (d) => {
  const prefix = isCyclingMarkerPayload(d) ? 'BIK' : 'DID';
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
};

/**
 * Returns a copy of a delivery payload with delivery_id and company_id filled
 * in when they are missing. Existing values always win — this never rewrites a
 * real id or another company's id.
 */
export const ensureDeliveryIdentity = (payload, currentUser) => {
  if (!payload) return payload;
  const next = { ...payload };
  let changed = false;
  if (!String(next.delivery_id || '').trim()) {
    next.delivery_id = generateDeliveryIdValue(next);
    changed = true;
  }
  if (!String(next.company_id || '').trim()) {
    next.company_id = resolveDeliveryCompanyId(currentUser);
    changed = true;
  }
  rememberCompanyId(next.company_id);
  return changed ? next : payload;
};

/** Same stamping for an array of payloads (batch saves). */
export const ensureDeliveryIdentityBatch = (payloads, currentUser) =>
  (Array.isArray(payloads) ? payloads : []).map((p) => ensureDeliveryIdentity(p, currentUser));
