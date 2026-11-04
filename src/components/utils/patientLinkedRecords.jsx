import { lookupPatientPhoneMatches } from '@/functions/lookupPatientPhoneMatches';

/**
 * OWNER REQUEST Nov 4 2026
 * One login, every record. A patient can exist more than once with the same
 * name and phone number (different store, different address). Asking them to
 * pick "which one am I" is noise, so the portal treats every record sharing
 * that name + phone as ONE household and shows all of its deliveries.
 *
 * Returns [primaryId, ...siblingIds]. Never throws: on any failure the caller
 * keeps just the primary record and behaves exactly as before.
 */
const CACHE_KEY = 'rxdeliver_linked_patient_ids_v1';

const normalizePhone = (p) => String(p || '').replace(/\D/g, '');
const normName = (n) => String(n || '').trim().toLowerCase().replace(/\s+/g, ' ');

export async function resolveLinkedPatientIds(patient) {
  const primaryId = patient?.id || null;
  if (!primaryId) return [];

  const phone = normalizePhone(patient?.phone);
  if (phone.length < 7) return [primaryId];

  const cacheKey = `${CACHE_KEY}:${primaryId}:${phone}`;
  try {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      const ids = JSON.parse(cached);
      if (Array.isArray(ids) && ids.includes(primaryId)) return ids;
    }
  } catch { /* private mode — just refetch */ }

  let ids = [primaryId];
  try {
    const res = await lookupPatientPhoneMatches({ phone });
    const matches = res?.data?.matches || [];
    const name = normName(patient?.full_name);
    const sameHousehold = matches.filter((m) => m?.id && (!name || normName(m.full_name) === name));
    if (sameHousehold.length > 0) {
      ids = [...new Set([primaryId, ...sameHousehold.map((m) => m.id)])];
    }
  } catch { /* keep primary only */ }

  try { sessionStorage.setItem(cacheKey, JSON.stringify(ids)); } catch { /* ignore */ }
  return ids;
}
