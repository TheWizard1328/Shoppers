/**
 * Map balloon helpers (owner request Nov 3 2026).
 *
 * The marker info balloons now carry the COD amount — right aligned beside the
 * store name on a single-stop balloon, and between the patient name and the ETA
 * on a clustered balloon — plus the shared location address, right aligned with
 * the store name inside a cluster.
 */
import { cleanBuzzerFromAddress } from '../utils/addressCleaner';

/** COD amount in dollars for a delivery/marker, 0 when there is none. */
export function codAmountOf(row) {
  const value = Number(row?.cod_total_amount_required || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** "$12.34" / "" when there is no COD. */
export function formatCodAmount(row) {
  const amount = codAmountOf(row);
  return amount > 0 ? `$${amount.toFixed(2)}` : '';
}

/**
 * One address for a cluster of stops that share a location: the first patient
 * address on the marker list (buzzer codes stripped), else the store address
 * (pickup clusters).
 */
export function clusterLocationAddress(stops) {
  const list = Array.isArray(stops) ? stops.filter(Boolean) : [];
  for (const stop of list) {
    const raw = stop?.patient?.address || stop?.patient_address || stop?.address || '';
    const cleaned = cleanBuzzerFromAddress(String(raw || ''));
    if (cleaned) return cleaned;
  }
  const storeAddress = list[0]?.store?.address || '';
  return cleanBuzzerFromAddress(String(storeAddress || ''));
}

export default { codAmountOf, formatCodAmount, clusterLocationAddress };
