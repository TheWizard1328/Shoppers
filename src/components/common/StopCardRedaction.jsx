import { useMemo } from "react";
import { formatAddressWithUnit, cleanBuzzerFromAddress } from '../utils/addressCleaner';
import { userHasRole } from '../utils/userRoles';
import { useInterStoreDisplayName, useInterStoreLocation } from '../utils/interStoreDisplayName';
import { getDeliveryTypeFlags } from '../utils/deliveryTypeUtils';

/**
 * Custom hook that encapsulates all patient data redaction logic for StopCard.
 * Returns display-safe values for name, address, and phone based on user role and delivery status.
 */
export function useDeliveryDisplayInfo({
  delivery,
  patient,
  store,
  currentUser,
  isStrippedDelivery,
  isStrippedForDispatcher,
}) {
  const { isPickup, isInterStore: isISPorISD, isISP, isISD, isStorePickup } = getDeliveryTypeFlags(delivery);
  // Legacy compat: callers may still pass these as props; the derived values above take precedence
  const isInterStore = isISPorISD;
  const isInterStorePickup = isISP || isISD;
  const ispDisplayName = useInterStoreDisplayName(delivery?.delivery_id);
  const ispLocation = useInterStoreLocation(delivery?.delivery_id);

  const displayName = useMemo(() => {
    if (!delivery) return '';
    // Cycling start markers have no patient/store — use delivery_notes as name
    if (delivery.is_cycling_start_marker) return delivery.delivery_notes || 'Cycling Route Start';
    if (isPickup && isInterStorePickup) {
      return delivery.patient_name || patient?.full_name || `${store?.name || 'Unknown Store'} Pickup`;
    }
    if (isPickup) return `${store?.name || 'Unknown Store'} Pickup`;
    return patient?.full_name || delivery.patient_name || 'Unknown';
  }, [delivery, isPickup, isInterStorePickup, store, patient]);

  const displayAddress = useMemo(() => {
    if (!delivery) return '';
    // ISP: use pickup (from) location address; ISD: use dropoff (to) location address
    if ((isISP || isISD) && ispLocation?.store_address) return cleanBuzzerFromAddress(ispLocation.store_address);
    if (isPickup) return cleanBuzzerFromAddress(store?.address || '');
    if (isInterStore) return cleanBuzzerFromAddress(store?.address || '');
    return patient?.address || "";
  }, [delivery, isISP, isISD, ispLocation, isPickup, isInterStore, store, patient]);

  const displayPhone = useMemo(() => {
    if (!delivery) return '';
    // ISP: use pickup (from) location phone; ISD: use dropoff (to) location phone
    if ((isISP || isISD) && ispLocation?.store_phone) return ispLocation.store_phone;
    if (isPickup) return store?.phone || '';
    if (isInterStore) return store?.phone || '';
    return patient?.phone || '';
  }, [delivery, isISP, isISD, ispLocation, isPickup, isInterStore, store, patient]);

  const shouldRedact = useMemo(() => {
    if (!delivery || !currentUser) return false;
    if (isPickup || isInterStore || isInterStorePickup) return false;
    // Redact for all finished deliveries (completed, failed, cancelled) for drivers
    const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'];
    if (
      FINISHED_STATUSES.includes(delivery.status) &&
      !userHasRole(currentUser, 'admin') &&
      !userHasRole(currentUser, 'dispatcher') &&
      userHasRole(currentUser, 'driver')
    ) {
      return true;
    }
    return false;
  }, [delivery?.status, isPickup, isInterStore, isInterStorePickup, currentUser]);

  const finalDisplayName = useMemo(() => {
    if (isISP && ispDisplayName) return ispDisplayName;
    if (isISD) return 'InterStore DropOff';
    if (isInterStore || isInterStorePickup) return displayName;
    if (isStrippedDelivery && !shouldRedact) {
      if (!isPickup && /\breturn\b/i.test(displayName || '')) return displayName;
      if (store?.name) return `${store.name} ${isPickup ? 'Pickup' : 'Delivery'}`;
      return isPickup ? 'Other Store Pickup' : 'Other Store Delivery';
    }
    if (!shouldRedact) return displayName;
    const firstName = patient?.full_name?.split(' ')[0] || '';
    return firstName + ' *****';
  }, [isStrippedDelivery, shouldRedact, displayName, patient, isPickup, store, isInterStore, isInterStorePickup]);

  const finalDisplayAddress = useMemo(() => {
    if (isInterStore || isInterStorePickup) return displayAddress;
    if (isStrippedDelivery) return '';
    if (!shouldRedact) return displayAddress;
    const firstPart = displayAddress?.split(' ')[0] || '';
    return firstPart + ' *****';
  }, [isStrippedDelivery, shouldRedact, displayAddress, isInterStore, isInterStorePickup]);

  const finalDisplayPhone = useMemo(() => {
    // ISP/ISD: always show the location's phone (never redact)
    if (isISP || isISD) return displayPhone || null;
    if (isInterStore || isInterStorePickup) return displayPhone;
    if (isStrippedDelivery) return null;
    if (!shouldRedact) return displayPhone;
    if (!displayPhone) return null;
    return `(***) ***-${displayPhone.replace(/\D/g, '').slice(-4)}`;
  }, [isISP, isStrippedDelivery, shouldRedact, displayPhone, isInterStore, isInterStorePickup]);

  return {
    displayName,
    displayAddress,
    displayPhone,
    shouldRedact,
    finalDisplayName,
    finalDisplayAddress,
    finalDisplayPhone,
  };
}