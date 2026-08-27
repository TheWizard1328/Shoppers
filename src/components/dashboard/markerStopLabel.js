import { isInterStoreDelivery } from '../utils/interStoreDisplayName';

/**
 * Returns the stop-row label for a marker inside a clustered
 * "stops at this location" map balloon.
 *
 * Distinguishes Inter-Store Pickups (ISP) and Dropoffs (ISD) from
 * regular Store Pickups and patient deliveries so the cluster balloon
 * correctly reflects what each stop actually is.
 */
export function getMarkerStopLabel(m) {
  if (!m) return 'Patient';
  if (isInterStoreDelivery(m.delivery_id)) {
    const isISP = String(m.delivery_id || '').toUpperCase().startsWith('ISP-');
    return isISP ? 'Inter-Store Pickup' : 'Inter-Store Dropoff';
  }
  return m.markerType === 'pickup' ? 'Store Pickup' : (m.patient?.full_name || 'Patient');
}