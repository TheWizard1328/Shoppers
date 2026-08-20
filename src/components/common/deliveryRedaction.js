import { userHasRole } from '../utils/userRoles';
import { isReturnAddress } from '../utils/returnDeliveryUtils';
import { getDeliveryTypeFlags } from '../utils/deliveryTypeUtils';

const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'];

/**
 * Decides whether a finished patient stop's name/address/phone must be
 * redacted for the current viewer. Single source of truth shared by
 * StopCard and the map marker info balloon.
 *
 * Rules (mirror the original StopCardRedaction logic):
 *  - pickups, inter-store (ISP/ISD), and return stops are never redacted
 *  - redaction applies only to finished patient deliveries (completed/failed/cancelled)
 *  - redaction applies only to drivers (not admins/dispatchers)
 */
export function shouldRedactDeliveryInfo({ delivery, patient, currentUser }) {
  if (!delivery || !currentUser) return false;
  const { isPickup, isInterStore, isISP, isISD } = getDeliveryTypeFlags(delivery);
  if (isPickup || isInterStore || isISP || isISD) return false;
  // Return deliveries point at a store (the "patient" is a store return address),
  // not a real patient — never redact the store name.
  if (isReturnAddress(patient?.address) || isReturnAddress(delivery?.patient_name)) return false;
  if (
    FINISHED_STATUSES.includes(delivery.status) &&
    !userHasRole(currentUser, 'admin') &&
    !userHasRole(currentUser, 'dispatcher') &&
    userHasRole(currentUser, 'driver')
  ) {
    return true;
  }
  return false;
}

/**
 * Masks a patient name to match the StopCard format: first name + " *****".
 */
export function redactPatientName(patient) {
  const firstName = (patient?.full_name || '').split(' ')[0] || '';
  return `${firstName} *****`;
}