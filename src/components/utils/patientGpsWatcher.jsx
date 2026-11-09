/**
 * patientGpsWatcher — one choke point for "did a patient's coordinates move".
 *
 * OWNER SPEC (Nov 9 2026): coordinates were changing with no user action and
 * nothing could say who / where / when / how. Every patient write that touches
 * latitude or longitude now calls logPatientGpsChange, which compares the OLD
 * record against the merged result and writes ONE PatientGPSLog row carrying
 * old, new, distance, user, device, source, action and caller.
 *
 * "How/why" comes from a stamp: user-facing GPS actions call stampGpsIntent()
 * immediately before saving, so a change that carries a stamp is user-driven and
 * a change with NO stamp is a background write. The stamp is one-shot and
 * expires in 20s so it can never leak onto a later write.
 *
 * Rows are skipped when nothing changed or the move is under MIN_MOVE_M for an
 * un-stamped write (jitter / re-geocode noise). User-stamped moves always log.
 */

const MIN_MOVE_M = 50;
const STAMP_TTL_MS = 20000;

let _stamp = null;

/** Call immediately before a user GPS action saves. */
export const stampGpsIntent = (action = 'user_action', extra = {}) => {
  _stamp = { action: String(action), source: 'user', at: Date.now(), ...extra };
};

export const clearGpsIntent = () => { _stamp = null; };

const takeStamp = () => {
  const st = _stamp;
  _stamp = null;
  if (!st) return null;
  if (Date.now() - st.at > STAMP_TTL_MS) return null;
  return st;
};

const distM = (lat1, lon1, lat2, lon2) => {
  const R = 6371000;
  const toRad = (d) => (Number(d) * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

const deviceId = () => {
  try { return localStorage.getItem('rxdeliver_device_identifier') || ''; } catch (_) { return ''; }
};

/**
 * @param {object} args
 * @param {object} args.existing the patient record BEFORE the write (IDB read)
 * @param {object} args.patient  the merged patient AFTER the write
 * @param {string} [args.source] explicit source ('user' | 'background')
 * @param {string} [args.action] explicit action label
 */
export const logPatientGpsChange = async ({ existing, patient, source, action, user } = {}) => {
  try {
    const e = existing || {};
    const n = patient || {};
    const oldLat = Number(e.latitude);
    const oldLng = Number(e.longitude);
    const newLat = Number(n.latitude);
    const newLng = Number(n.longitude);
    if (!Number.isFinite(oldLat) || !Number.isFinite(oldLng)) return null;
    if (!Number.isFinite(newLat) || !Number.isFinite(newLng)) return null;
    if (oldLat === newLat && oldLng === newLng) return null;

    const stamp = takeStamp();
    const src = String(source || stamp?.source || 'background');
    const act = String(action || stamp?.action || 'unstamped');
    const moved = distM(oldLat, oldLng, newLat, newLng);
    if (src !== 'user' && moved < MIN_MOVE_M) return null;

    const caller = (new Error().stack || '').split('\n').slice(2, 6)
      .map((l) => l.trim().replace(/^at /, '')).join(' <- ').slice(0, 500);

    let userName = user?.full_name || user?.email || '';
    let userId = user?.id || user?.user_id || '';
    if (!userName) {
      try {
        const { base44 } = await import('@/api/base44Client');
        const me = await base44.auth.me();
        userName = me?.full_name || me?.email || 'Unknown';
        userId = me?.id || userId;
      } catch (_) { userName = userName || 'Unknown'; }
    }

    const { base44 } = await import('@/api/base44Client');
    await base44.entities.PatientGPSLog.create({
      patient_id: n.id || e.id || '',
      patient_name: n.full_name || e.full_name || '',
      patient_address: n.address || e.address || '',
      store_id: n.store_id || e.store_id || '',
      is_source_patient: true,
      old_latitude: oldLat,
      old_longitude: oldLng,
      new_latitude: newLat,
      new_longitude: newLng,
      updated_by_user_id: userId,
      updated_by_user_name: userName,
      normalized_address: n.address || e.address || '',
      related_patients_updated_count: 0,
      matched_patient_ids: [],
      change_source: src,
      change_action: act,
      caller,
      distance_m: Math.round(moved),
      device_identifier: deviceId(),
    });
    notifyOwnerOfGpsChange({ patient: { ...n, id: n.id || e.id }, moved: Math.round(moved), src, act }).catch(() => {});
    return { moved: Math.round(moved), source: src, action: act };
  } catch (err) {
    console.warn('[patientGpsWatcher] log skipped:', err?.message || err);
    return null;
  }
};


/**
 * OWNER ALERTS (owner spec Nov 9 2026): push + in-app message for every GPS
 * change, EXCEPT a user-stamped change on one of the owner's own stops. So a
 * driver's stop moving always alerts, and the owner's stop alerts only when
 * nobody stamped a gesture (the silent-writer case).
 */
const notifyOwnerOfGpsChange = async ({ patient, moved, src, act }) => {
  try {
    const [{ getAppOwners, sendDeliveryMessage, sendPushForNotification }, { base44 }] = await Promise.all([
      import('@/components/utils/deliveryMessaging'),
      import('@/api/base44Client'),
    ]);
    const owners = (await getAppOwners()) || [];
    if (!owners.length) return;
    const ownerIds = owners.map((o) => o.user_id || o.id).filter(Boolean);
    let stops = [];
    try {
      stops = (await base44.entities.Delivery.filter({ patient_id: patient.id }, '-created_date', 20)) || [];
    } catch (_) { stops = []; }
    const live = stops.filter((d) => ['pending', 'en_route', 'in_transit', 'completed'].includes(String(d.status || '')));
    const onlyOwnerStops = live.length > 0 && live.every((d) => ownerIds.includes(d.driver_id));
    if (src === 'user' && onlyOwnerStops) return;

    const driverNames = [...new Set(live.map((d) => d.driver_name).filter(Boolean))].join(', ') || 'no active stop';
    const content = `Patient GPS moved ${moved}m — ${patient.full_name || patient.id} — driver: ${driverNames} — ${src}/${act} — ${Number(patient.latitude).toFixed(5)},${Number(patient.longitude).toFixed(5)}`;
    for (const o of owners) {
      const rid = o.user_id || o.id;
      if (!rid) continue;
      await sendDeliveryMessage({ senderId: 'system', senderName: 'GPS Watch', receiverId: rid, receiverName: o.full_name || '', content }).catch(() => {});
      await sendPushForNotification({ receiverId: rid, senderName: 'GPS Watch', content, event: 'patient_gps_changed', titleOverride: 'Patient GPS changed' }).catch(() => {});
    }
  } catch (err) {
    console.warn('[patientGpsWatcher] alert skipped:', err?.message || err);
  }
};

export const GPS_MIN_MOVE_M = MIN_MOVE_M;
