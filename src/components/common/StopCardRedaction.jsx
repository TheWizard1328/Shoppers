import { useMemo } from "react";
import { formatAddressWithUnit, cleanBuzzerFromAddress } from '../utils/addressCleaner';
import { userHasRole } from '../utils/userRoles';

/**
 * Custom hook that encapsulates all patient data redaction logic for StopCard.
 * Returns display-safe values for name, address, and phone based on user role and delivery status.
 */
export function useDeliveryDisplayInfo({
  delivery,
  patient,
  store,
  currentUser,
  isPickup,
  isInterStore,
  isInterStorePickup,
  isStrippedDelivery,
  isStrippedForDispatcher,
}) {
  const displayName = useMemo(() => {
    if (!delivery) return '';
    if (isPickup && isInterStorePickup) {
      return delivery.patient_name || patient?.full_name || `${store?.name || 'Unknown Store'} Pickup`;
    }
    if (isPickup) return `${store?.name || 'Unknown Store'} Pickup`;
    return patient?.full_name || 'Unknown';
  }, [delivery, isPickup, isInterStorePickup, store, patient]);

  const displayAddress = useMemo(() => {
    if (!delivery) return '';
    if (isPickup) return cleanBuzzerFromAddress(store?.address || '');
    return formatAddressWithUnit(patient?.address || "", patient?.unit_number || delivery.unit_number || "");
  }, [delivery, isPickup, store, patient]);

  const displayPhone = useMemo(() => {
    if (!delivery) return '';
    if (isPickup) return store?.phone || '';
    return patient?.phone || '';
  }, [delivery, isPickup, store, patient]);

  const shouldRedact = useMemo(() => {
    if (!delivery || !currentUser) return false;
    if (isPickup || isInterStore || isInterStorePickup) return false;
    if (
      (delivery.status === 'completed' || delivery.status === 'failed') &&
      !userHasRole(currentUser, 'admin') &&
      !userHasRole(currentUser, 'dispatcher') &&
      userHasRole(currentUser, 'driver')
    ) {
      return true;
    }
    return false;
  }, [delivery?.status, isPickup, isInterStore, isInterStorePickup, currentUser]);

  const finalDisplayName = useMemo(() => {
    if (isInterStore || isInterStorePickup) return displayName;
    if (isStrippedDelivery && !shouldRedact) {
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
    if (isInterStore || isInterStorePickup) return displayPhone;
    if (isStrippedDelivery) return null;
    if (!shouldRedact) return displayPhone;
    if (!displayPhone) return null;
    return `(***) ***-${displayPhone.replace(/\D/g, '').slice(-4)}`;
  }, [isStrippedDelivery, shouldRedact, displayPhone, isInterStore, isInterStorePickup]);

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