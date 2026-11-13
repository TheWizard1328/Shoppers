import React, { useEffect, useState } from 'react';
import { Loader2, RefreshCw, MapPin } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { base44 } from '@/api/base44Client';
import { haversineKm } from '@/components/utils/geoUtils';
import { updatePatientLocal } from '@/components/utils/entityMutations';
import { isCurrentDevicePrimary } from '@/components/utils/deviceManager';
import { isDriver, isAdmin, isAppOwner } from '@/components/utils/userRoles';
import PatientStoreMapDialog from './PatientStoreMapDialog';
import { useDevice } from '@/components/utils/DeviceContext';

// OWNER SPEC (Nov 12 2026): on an ACTIVE or FINISHED stop the App Owner's map
// badge opens the Stop Details "Polyline & Deviation Points" tool instead of the
// patient/store map. Lazy so leaflet + the route engine only load when opened.
const StopPolylineDeviationMap = React.lazy(() => import('@/components/admin/StopPolylineDeviationMap'));

// Stops that have a leg worth debugging: on the road, or already driven.
const POLYLINE_MAP_STATUSES = ['en_route', 'in_transit', 'completed', 'failed'];

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
 *
 * LIMIT (owner spec Nov 7 2026): a DRIVER may refresh a given delivery + delivery
 * date only ONCE. Every refresh writes a KmRefreshLog row (delivery_id +
 * delivery_date + who + old/new km), and a driver is blocked as soon as a row
 * exists for that pair, on any device. Owner / admin / dispatcher are unlimited —
 * the log is still written so the owner can audit who moved a distance.
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
  polylineDelivery = null, // full Delivery record from the Edit Delivery form (owner map routing)
  className = '',
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [usedHere, setUsedHere] = useState(false);   // used in THIS session
  const [usedBefore, setUsedBefore] = useState(false); // already logged on the server
  const refreshLimitApplies = !!delivery?.id && isDriver(currentUser) && !isAdmin(currentUser);
  const refreshLocked = refreshLimitApplies && (usedHere || usedBefore);
  const [mapOpen, setMapOpen] = useState(false);
  const [driverLocation, setDriverLocation] = useState(null);
  const [polylineTarget, setPolylineTarget] = useState(null); // stop shown in the polyline tool

  // Keep the open polyline panel in step with edits made on OTHER devices
  // (owner request Nov 13 2026): the dialog holds a snapshot, so a deviation
  // point added or deleted elsewhere never reached it. Re-read the record
  // whenever the live deliveries land, and only swap when something changed.
  useEffect(() => {
    if (!polylineTarget?.id) return undefined;
    const refresh = async () => {
      const id = polylineTarget.id;
      const same = (a, b) =>
        String(a?.updated_date || '') === String(b?.updated_date || '') &&
        String(a?.encoded_polyline || '') === String(b?.encoded_polyline || '') &&
        JSON.stringify(a?.deviation_waypoints || []) === JSON.stringify(b?.deviation_waypoints || []);
      let fresh = (Array.isArray(window.__appDeliveries) ? window.__appDeliveries : [])
        .find((d) => String(d?.id) === String(id)) || null;
      if (!fresh) {
        try {
          const { offlineDB } = await import('@/components/utils/offlineDatabase');
          fresh = await offlineDB.getById(offlineDB.STORES.DELIVERIES, id);
        } catch (_) { fresh = null; }
      }
      if (!fresh) return;
      setPolylineTarget((prev) => (prev && String(prev.id) === String(fresh.id) && same(prev, fresh) ? prev : fresh));
    };
    window.addEventListener('deliveriesUpdated', refresh);
    return () => window.removeEventListener('deliveriesUpdated', refresh);
  }, [polylineTarget?.id]);
  const [resolving, setResolving] = useState(false);
  // Desktop / tablet landscape: the map panel is centred in the map area (right
  // of the dashboard sidebar) and 50% wider — same rule the Edit forms follow.
  const { isMobile: isPhoneLayout } = useDevice();

  useEffect(() => {
    let cancelled = false;
    if (!delivery?.id || !refreshLimitApplies) { setUsedBefore(false); return undefined; }
    (async () => {
      try {
        const rows = await base44.entities.KmRefreshLog.filter({
          delivery_id: String(delivery.id),
          delivery_date: String(delivery.delivery_date || ''),
        });
        if (!cancelled) setUsedBefore(Array.isArray(rows) && rows.length > 0);
      } catch {
        // A failed lookup must never block a legitimate refresh.
        if (!cancelled) setUsedBefore(false);
      }
    })();
    return () => { cancelled = true; };
  }, [delivery?.id, delivery?.delivery_date, refreshLimitApplies]);

  const patientLat = num(patient?.latitude);
  const patientLng = num(patient?.longitude);
  const storeLat = num(store?.latitude);
  const storeLng = num(store?.longitude);
  const hasBothSides = patientLat !== null && patientLng !== null && storeLat !== null && storeLng !== null;

  const handleRefresh = async () => {
    if (disabled || busy) return;
    if (refreshLocked) {
      setProblem('Distance already updated for this delivery');
      onError?.('This delivery already had its distance updated. One refresh per delivery per date.');
      return;
    }
    const previousKm = num(patient?.distance_from_store);
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

      // 3. Log the refresh (one per delivery + date for drivers; audit trail for
      // everyone else). Never blocks the save if the log write fails.
      try {
        await base44.entities.KmRefreshLog.create({
          delivery_id: delivery?.id ? String(delivery.id) : '',
          delivery_date: String(delivery?.delivery_date || ''),
          patient_id: patient?.id ? String(patient.id) : '',
          user_id: currentUser?.id ? String(currentUser.id) : '',
          user_name: currentUser?.full_name || currentUser?.user_name || '',
          old_km: previousKm === null ? undefined : previousKm,
          new_km: rounded,
          refreshed_at: new Date().toISOString(),
        });
        if (refreshLimitApplies) setUsedHere(true);
      } catch (logErr) {
        console.warn('[AddressActionBadges] refresh log failed:', logErr?.message);
      }

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

  // The stop the owner wants to debug. Edit Delivery hands over the record; Edit
  // Patient has no stop context, so the patient's own stop is resolved — today's
  // first, else the newest one that is on the road or already driven.
  const resolvePolylineStop = async () => {
    const mirror = Array.isArray(window.__appDeliveries) ? window.__appDeliveries : [];
    if (polylineDelivery?.id) {
      const fresh = mirror.find((d) => String(d?.id) === String(polylineDelivery.id));
      return fresh || polylineDelivery;
    }
    const pid = patient?.id || patient?.patient_id || null;
    if (!pid) return null;
    let rows = mirror.filter((d) => String(d?.patient_id) === String(pid));
    if (rows.length === 0) {
      try {
        rows = (await base44.entities.Delivery.filter({ patient_id: String(pid) })) || [];
      } catch { rows = []; }
    }
    const relevant = rows.filter((d) => POLYLINE_MAP_STATUSES.includes(String(d?.status || '').toLowerCase()));
    if (relevant.length === 0) return null;
    const today = new Date().toLocaleDateString('en-CA');
    const todays = relevant.filter((d) => String(d?.delivery_date || '').slice(0, 10) === today);
    const pool = todays.length ? todays : relevant;
    return pool.slice().sort((a, b) =>
      String(b?.delivery_date || '').localeCompare(String(a?.delivery_date || '')) ||
      (Number(b?.stop_order) || 0) - (Number(a?.stop_order) || 0)
    )[0];
  };

  const openMap = async () => {
    // App Owner + active/finished stop → Polyline & Deviation Points tool.
    // Pending (and staged/cancelled) stops keep the patient/store map.
    if (isAppOwner(currentUser)) {
      setResolving(true);
      try {
        const stop = await resolvePolylineStop();
        if (stop && POLYLINE_MAP_STATUSES.includes(String(stop?.status || '').toLowerCase())) {
          setPolylineTarget(stop);
          return;
        }
      } catch (err) {
        console.warn('[AddressActionBadges] stop resolution failed:', err?.message);
      } finally {
        setResolving(false);
      }
    }
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
        disabled={disabled || busy || refreshLocked}
        title={problem || (refreshLocked
          ? 'Distance already updated for this delivery — one refresh per delivery per date'
          : hasBothSides
            ? 'Re-measure the real driving distance between the store and this patient, then save it'
            : 'Patient GPS missing — the distance cannot be measured yet')}
        aria-label="Refresh distance from store"
        style={roundStyle}
        className={`${roundBase} ${disabled || busy || !hasBothSides || refreshLocked ? disabledCls : enabledCls} ${problem ? 'ring-1 ring-red-400 border-red-300 dark:ring-red-600' : ''}`}>
        {busy
          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
          : <RefreshCw className="w-3.5 h-3.5" />}
      </button>

      <button
        type="button"
        onClick={openMap}
        disabled={disabled || resolving}
        title={isAppOwner(currentUser)
          ? 'App Owner: a pending stop shows the patient/store map; a stop on the road or already driven opens Polyline & Deviation Points'
          : 'Show the patient, the store and this driver on a map'}
        aria-label="Show map"
        style={roundStyle}
        className={`${roundBase} ${disabled ? disabledCls : enabledCls}`}>
        {resolving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MapPin className="w-3.5 h-3.5" />}
      </button>

      <PatientStoreMapDialog
        open={mapOpen}
        onClose={() => setMapOpen(false)}
        patient={patient}
        store={store}
        driverLocation={driverLocation}
      />

      {/* Polyline & Deviation Points (App Owner, active/finished stops only) —
          the same tool the Stop Details side panel renders. */}
      <Dialog open={!!polylineTarget} onOpenChange={(o) => { if (!o) setPolylineTarget(null); }}>
        <DialogContent
          /* The Edit Delivery / Edit Patient forms are full-screen layers at
             z-[10020] (their own popovers go to 10051), so a stock dialog
             (overlay 10000 / content 10001) opened from inside them rendered
             BEHIND the form (owner report Nov 12 2026). Raise both. */
          overlayClassName={`z-[10060] ${isPhoneLayout ? '' : 'map-dialog-overlay-wide'}`}
          className={`z-[10070] max-h-[92vh] overflow-y-auto p-3 sm:p-4 ${isPhoneLayout ? 'max-w-2xl w-[96vw]' : 'map-dialog-wide'}`}>
          <DialogHeader>
            <DialogTitle className="text-sm">
              Polyline &amp; Deviation Points
              {polylineTarget?.status ? <span className="ml-1.5 text-[11px] font-normal text-slate-500 dark:text-slate-400">· {String(polylineTarget.status).replace(/_/g, ' ')}</span> : null}
            </DialogTitle>
          </DialogHeader>
          {polylineTarget &&
          <React.Suspense fallback={<div className="flex items-center justify-center py-10 text-xs text-slate-500 dark:text-slate-400"><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Loading map…</div>}>
              <StopPolylineDeviationMap delivery={polylineTarget} mapHeight={isPhoneLayout ? 240 : 360} />
            </React.Suspense>
          }
        </DialogContent>
      </Dialog>
    </div>
  );
}
