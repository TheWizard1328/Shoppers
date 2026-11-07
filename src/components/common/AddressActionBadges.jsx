import React, { useState } from 'react';
import { Loader2, RefreshCw, MapPin } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { haversineKm } from '@/components/utils/geoUtils';
import { updatePatientLocal } from '@/components/utils/entityMutations';
import { isCurrentDevicePrimary } from '@/components/utils/deviceManager';
import PatientStoreMapDialog from './PatientStoreMapDialog';

/**
 * Two round action badges that sit to the LEFT of the Change badge, above the
 * address field (owner spec Nov 6 2026):
 *
 *  1. Refresh distance from store — measures the REAL road distance between the
 *     assigned store's GPS and the patient's GPS with the same Google call the
 *     new-patient address lookup uses (getGoogleDrivingDistance), NOT crow
 *     flies, and SAVES it on the patient record (distance_from_store).
 *     On the edit delivery form it additionally clears that stop's extra
 *     kilometre override, but ONLY when the new distance is GREATER than the
 *     override already stored there — a refresh may never shrink paid km.
 *
 *  2. Show map — square route-editor style map with the patient and store pins,
 *     plus the driver's live position when this device is the driver's primary.
 */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export default function AddressActionBadges({
  patient = null,
  store = null,
  delivery = null,
  currentUser = null,
  disabled = false,
  onDistanceUpdated,
  onPaidKmOverrideCleared,
  onError,
  className = '',
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [mapOpen, setMapOpen] = useState(false);
  const [driverLocation, setDriverLocation] = useState(null);

  const patientLat = num(patient?.latitude);
  const patientLng = num(patient?.longitude);
  const storeLat = num(store?.latitude);
  const storeLng = num(store?.longitude);
  const hasBothSides = patientLat !== null && patientLng !== null && storeLat !== null && storeLng !== null;

  const handleRefresh = async () => {
    if (disabled || busy) return;
    if (!hasBothSides) {
      setProblem('No patient or store GPS yet — set the address first');
      onError?.('This patient has no GPS coordinates yet — set the address first.');
      return;
    }
    setBusy(true);
    setProblem('');
    try {
      let km = null;
      try {
        const res = await base44.functions.invoke('getGoogleDrivingDistance', {
          originLat: storeLat,
          originLng: storeLng,
          destLat: patientLat,
          destLng: patientLng,
        });
        const driving = res?.data?.distance_km ?? res?.distance_km;
        if (Number.isFinite(Number(driving)) && Number(driving) > 0) km = Number(driving);
      } catch (e) {
        // Google unavailable (key/quota/offline) — fall back exactly like the
        // patient form's store-change path does.
      }
      if (km === null) {
        const straight = haversineKm(storeLat, storeLng, patientLat, patientLng);
        if (Number.isFinite(Number(straight)) && Number(straight) > 0) km = Number(straight);
      }
      if (km === null) throw new Error('Could not measure the distance');

      const rounded = Math.round(km * 100) / 100;

      // 1. Save on the patient record (distance_from_store is what payroll reads).
      if (patient?.id) {
        await updatePatientLocal(patient.id, { distance_from_store: rounded });
      }
      onDistanceUpdated?.(rounded);

      // 2. Extra km override: clear only when the new distance is BIGGER.
      if (delivery) {
        const storedOverride = num(delivery.paid_km_override) || 0;
        if (rounded > storedOverride) onPaidKmOverrideCleared?.(rounded);
      }
    } catch (err) {
      console.warn('[AddressActionBadges] distance refresh failed:', err?.message);
      setProblem('Distance refresh failed — check the connection and retry');
      onError?.('Distance refresh failed. Check the device connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const openMap = async () => {
    setMapOpen(true);
    if (driverLocation || !currentUser?.id) return;
    const lat = num(currentUser?.current_latitude);
    const lng = num(currentUser?.current_longitude);
    if (lat === null || lng === null) return;
    try {
      const primary = await isCurrentDevicePrimary(currentUser.id);
      if (primary) {
        setDriverLocation({
          latitude: lat,
          longitude: lng,
          name: currentUser.full_name || currentUser.user_name || 'You',
        });
      }
    } catch { /* driver pin is a bonus, never a blocker */ }
  };

  const roundBase =
    'inline-flex items-center justify-center h-6 w-6 shrink-0 rounded-full border transition-colors select-none';
  // index.css gives EVERY button a 44px min-height (touch targets). These are
  // meant to be 24px round chips, so the rule is neutralised inline — an inline
  // style is the only thing that beats it without !important games elsewhere.
  const roundStyle = { minHeight: 0, minWidth: 0, padding: 0, height: 24, width: 24, flex: '0 0 auto' };
  const enabledCls =
    'bg-emerald-100 text-emerald-700 border-emerald-300 hover:bg-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-700 dark:hover:bg-emerald-900/70';
  const disabledCls =
    'bg-slate-100 text-slate-400 border-slate-200 dark:bg-slate-800 dark:text-slate-500 dark:border-slate-700 cursor-not-allowed opacity-60';

  return (
    <div className={`flex items-center gap-1 ${className}`}>
      <button
        type="button"
        onClick={handleRefresh}
        disabled={disabled || busy}
        title={problem || (hasBothSides
          ? 'Re-measure the real driving distance between the store and this patient, then save it'
          : 'Patient GPS missing — the distance cannot be measured yet')}
        aria-label="Refresh distance from store"
        style={roundStyle}
        className={`${roundBase} ${disabled || busy || !hasBothSides ? disabledCls : enabledCls} ${problem ? 'ring-1 ring-red-400 border-red-300 dark:ring-red-600' : ''}`}>
        {busy
          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
          : <RefreshCw className="w-3.5 h-3.5" />}
      </button>

      <button
        type="button"
        onClick={openMap}
        disabled={disabled}
        title="Show the patient, the store and this driver on a map"
        aria-label="Show map"
        style={roundStyle}
        className={`${roundBase} ${disabled ? disabledCls : enabledCls}`}>
        <MapPin className="w-3.5 h-3.5" />
      </button>

      <PatientStoreMapDialog
        open={mapOpen}
        onClose={() => setMapOpen(false)}
        patient={patient}
        store={store}
        driverLocation={driverLocation}
      />
    </div>
  );
}
