import { useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';

/**
 * Patient delivery pushes (owner spec Nov 24 2026).
 *
 * Four states, one push each, copy approved verbatim by the owner:
 *   pending  "Dear <name>, Your Rx delivery is ready and awaiting pickup by the
 *            driver at <pickup ETA> - <+30 min>"
 *   pickup   "Dear <name>, Your Rx delivery has been picked up by the driver and
 *            ETA is <eta> - <+30 min>"
 *   next     "Dear <name>, Your Rx is next for delivery with an ETA of <eta>"
 *   delayed  "Dear <name>, Your Rx delivery is slightly delayed but should arrive
 *            now by <eta> - <+30 min>"
 *
 * Delivery rules:
 *   • Only today's active stops for a real patient (store pickups are skipped).
 *   • Everything is evaluated after a settle window, so a route optimization
 *     that lands right after a status change still supplies the final ETA.
 *   • The "next" push waits 30s and re-checks the flag, so a re-optimize that
 *     moves the flag before then never notifies the wrong patient.
 *   • One push per state per delivery per device (localStorage ledger); the
 *     delayed push also remembers the window it sent and only fires again when
 *     the arrival window moves later.
 */

const LEDGER_KEY = 'rxdeliver:patientDeliveryPushes';
const SETTLE_MS = 45000;
const NEXT_STABLE_MS = 30000;
const PENDING_FRESH_MS = 10 * 60 * 1000;
const ACTIVE = new Set(['pending', 'in_transit', 'en_route']);

function readLedger() {
  try {
    return JSON.parse(localStorage.getItem(LEDGER_KEY) || '{}') || {};
  } catch (_) {
    return {};
  }
}

function writeLedger(ledger) {
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
  } catch (_) { /* private mode / quota — pushes simply may repeat */ }
}

function parseHHmm(value) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(value || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  return h * 60 + min;
}

function fmtMinutes(total) {
  const wrapped = ((Math.round(total) % 1440) + 1440) % 1440;
  const h24 = Math.floor(wrapped / 60);
  const min = wrapped % 60;
  const suffix = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(min).padStart(2, '0')} ${suffix}`;
}

/** Minutes-of-day for a delivery's ETA, falling back to its window start. */
function etaMinutes(delivery) {
  const eta = parseHHmm(delivery?.delivery_time_eta);
  if (eta != null) return eta;
  return parseHHmm(delivery?.delivery_time_start);
}

function windowText(startMinutes) {
  return `${fmtMinutes(startMinutes)} - ${fmtMinutes(startMinutes + 30)}`;
}

export function buildPatientDeliveryMessage({ state, patientName, etaText, window }) {
  const name = String(patientName || '').trim().split(/\s+/)[0] || 'there';
  switch (state) {
    case 'pending':
      return `Dear ${name}, Your Rx delivery is ready and awaiting pickup by the driver at ${window}`;
    case 'pickup':
      return `Dear ${name}, Your Rx delivery has been picked up by the driver and ETA is ${window}`;
    case 'next':
      return `Dear ${name}, Your Rx is next for delivery with an ETA of ${etaText}`;
    case 'delayed':
      return `Dear ${name}, Your Rx delivery is slightly delayed but should arrive now by ${window}`;
    default:
      return '';
  }
}

/**
 * Sends ONE delivery-state notification: a push, plus an in-app message that is
 * only written when at least one device accepted the push (owner rule, Nov 24
 * 2026). The server writes the in-app row itself with no push of its own, so a
 * patient can never get a duplicate for the same state. Returns the server
 * result: { sent, in_app, deduped, ... }.
 */
async function pushPatient(patientId, title, body, tag, store = {}) {
  if (!patientId || !body) return { sent: 0, in_app: false };
  return base44.functions.invoke('patientPush', {
    action: 'notify',
    patient_id: patientId,
    title: title || 'Your pharmacy',
    body,
    url: '/patient-portal',
    tag,
    store_id: store.store_id || '',
    store_name: store.store_name || '',
    sender_name: store.sender_name || '',
  }).catch(() => ({ sent: 0, in_app: false }));
}

function albertaTodayKey() {
  return new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Watches the dashboard's deliveries and sends the four patient pushes.
 * Mount once (Dashboard). `enabled` should be the primary-device flag so only
 * the device actually driving the route notifies patients.
 */
export function usePatientDeliveryPushes({ deliveries, patients, currentUser, enabled }) {
  const deliveriesRef = useRef(deliveries);
  const patientsRef = useRef(patients);
  const userRef = useRef(currentUser);
  const enabledRef = useRef(enabled);
  const settleTimerRef = useRef(null);
  const nextTimersRef = useRef(new Map());

  deliveriesRef.current = deliveries;
  patientsRef.current = patients;
  userRef.current = currentUser;
  enabledRef.current = enabled;

  const evaluate = useRef(null);

  evaluate.current = async () => {
    // OWNER REPORT (Nov 25 2026): a dispatcher or admin adding a pending stop
    // notified nobody, because this whole pass was primary-device only. The
    // "created as pending" notice now runs on every device (the server dedupes the
    // same body for 12h); the live-route states stay primary-device only.
    const primaryDevice = !!enabledRef.current;
    const list = Array.isArray(deliveriesRef.current) ? deliveriesRef.current : [];
    const people = Array.isArray(patientsRef.current) ? patientsRef.current : [];
    if (list.length === 0) return;

    const today = albertaTodayKey();
    const nameById = new Map();
    for (const p of people) {
      if (p?.id) nameById.set(String(p.id), p.full_name || p.name || '');
    }

    const ledger = readLedger();
    const now = Date.now();

    // Parent pickup per PUID, so a pending stop can quote the pickup ETA.
    const pickupByPuid = new Map();
    for (const d of list) {
      if (d?.puid && !d.patient_id) pickupByPuid.set(String(d.puid), d);
    }

    for (const delivery of list) {
      if (!delivery?.id || !delivery.patient_id) continue;
      if (String(delivery.delivery_date || '') !== today) continue;
      const status = String(delivery.status || '').toLowerCase();
      if (!ACTIVE.has(status)) continue;

      const entry = ledger[delivery.id] || {};
      const patientName = nameById.get(String(delivery.patient_id)) || delivery.patient_name || '';
      const title = delivery.store_name || 'Your pharmacy';
      const eta = etaMinutes(delivery);

      // ── 1. Created as pending ──────────────────────────────────────────
      if (status === 'pending' && !entry.pending) {
        const createdMs = delivery.created_date ? Date.parse(delivery.created_date) : 0;
        if (createdMs && now - createdMs <= PENDING_FRESH_MS) {
          const parentPickup = delivery.puid ? pickupByPuid.get(String(delivery.puid)) : null;
          const pickupMinutes = etaMinutes(parentPickup) ?? eta;
          if (pickupMinutes != null) {
            const body = buildPatientDeliveryMessage({
              state: 'pending',
              patientName,
              window: windowText(pickupMinutes),
            });
            // The notice is credited to the driver who owns the stop, so it never
          // reads as a pharmacy-team message he did not send.
          const creatorName = String(delivery.driver_name || '').trim()
            || String(userRef.current?.user_name || userRef.current?.full_name || '').trim();
          await pushPatient(delivery.patient_id, title, body, `rx-pending-${delivery.id}`, { store_id: delivery.store_id, store_name: delivery.store_name, sender_name: creatorName });
            entry.pending = true;
            entry.etaEnd = pickupMinutes + 30;
          }
        }
      }

      // ── 2. Picked up (covers staged -> in_transit jumps) ────────────────
      if (primaryDevice && (status === 'in_transit' || status === 'en_route') && !entry.pickup && eta != null) {
        const body = buildPatientDeliveryMessage({
          state: 'pickup',
          patientName,
          window: windowText(eta),
        });
        await pushPatient(delivery.patient_id, title, body, `rx-pickup-${delivery.id}`, { store_id: delivery.store_id, store_name: delivery.store_name });
        entry.pickup = true;
        entry.etaEnd = eta + 30;
      }

      // ── 4. Arrival window moved later than the one already sent ─────────
      if (primaryDevice && entry.pickup && eta != null) {
        const newEnd = eta + 30;
        const sentEnd = Number(entry.etaEnd || 0);
        // OWNER REPORT (Nov 25 2026): Katelyn got three "slightly delayed"
        // notices in six minutes because the old test fired on ANY minute of
        // slip. A delay notice now needs a REAL slip of at least 15 minutes on
        // top of what she was last told, and at most one every 20 minutes.
        const DELAY_SLIP_MIN = 15;
        const DELAY_COOLDOWN_MS = 20 * 60 * 1000;
        const slippedEnough = sentEnd && newEnd - sentEnd >= DELAY_SLIP_MIN;
        const cooledDown = !entry.delayedAt || now - Number(entry.delayedAt) >= DELAY_COOLDOWN_MS;
        if (slippedEnough && cooledDown) {
          const body = buildPatientDeliveryMessage({
            state: 'delayed',
            patientName,
            window: windowText(eta),
          });
          await pushPatient(delivery.patient_id, title, body, `rx-delayed-${delivery.id}`, { store_id: delivery.store_id, store_name: delivery.store_name });
          entry.etaEnd = newEnd;
          entry.delayedAt = now;
        }
      }

      ledger[delivery.id] = entry;
    }

    // ── 3. Next delivery, stable for 30s ─────────────────────────────────
    const flagged = list.filter((d) => d?.isNextDelivery === true && d.patient_id && ACTIVE.has(String(d.status || '').toLowerCase()));
    const flaggedIds = new Set(flagged.map((d) => String(d.id)));
    for (const [id, timer] of nextTimersRef.current.entries()) {
      if (!flaggedIds.has(id)) {
        clearTimeout(timer);
        nextTimersRef.current.delete(id);
      }
    }
    for (const delivery of flagged) {
      const id = String(delivery.id);
      if (ledger[id]?.next) continue;
      if (nextTimersRef.current.has(id)) continue;
      const timer = setTimeout(async () => {
        nextTimersRef.current.delete(id);
        if (!enabledRef.current) return;
        const latest = (deliveriesRef.current || []).find((d) => String(d.id) === id);
        // Re-check after the settle: a re-optimize may have moved the flag.
        if (!latest || latest.isNextDelivery !== true) return;
        const status = String(latest.status || '').toLowerCase();
        if (!ACTIVE.has(status)) return;
        const eta = etaMinutes(latest);
        if (eta == null) return;
        const led = readLedger();
        if (led[id]?.next) return;
        const people2 = Array.isArray(patientsRef.current) ? patientsRef.current : [];
        const nm = people2.find((p) => String(p?.id) === String(latest.patient_id));
        const patientName = nm?.full_name || nm?.name || latest.patient_name || '';
        const body = buildPatientDeliveryMessage({
          state: 'next',
          patientName,
          etaText: fmtMinutes(eta),
        });
        await pushPatient(latest.patient_id, latest.store_name || 'Your pharmacy', body, `rx-next-${id}`, { store_id: latest.store_id, store_name: latest.store_name });
        led[id] = { ...(led[id] || {}), next: true };
        writeLedger(led);
      }, NEXT_STABLE_MS);
      nextTimersRef.current.set(id, timer);
    }

    writeLedger(ledger);
  };

  // Settle window: any change to the route restarts it, so pushes always carry
  // the ETA that survived the optimization.
  // OWNER REPORT (Nov 25 2026): no patient push arrived when a stop was added to
  // the route. The old effect CLEARED the settle timer on every deliveries change,
  // and an active route changes constantly, so the timer was perpetually restarted
  // and evaluate() never ran. The window is now armed once per burst: the first
  // change schedules it, later changes ride along, and it always fires.
  useEffect(() => {
    if (!enabled) return undefined;
    if (settleTimerRef.current) return undefined;
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      evaluate.current?.().catch(() => {});
    }, SETTLE_MS);
    return undefined;
  }, [deliveries, patients, enabled]);

  useEffect(() => () => {
    for (const timer of nextTimersRef.current.values()) clearTimeout(timer);
    nextTimersRef.current.clear();
  }, []);
}

export default usePatientDeliveryPushes;
