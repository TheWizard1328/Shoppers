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
 *   moved    "Dear <name>, Your driver has moved your Rx to <date>. Your new
 *            delivery window will be confirmed when your driver is on duty."
 *            (added Nov 25 2026, owner-approved copy, no reason ever given)
 *   handoff  "Dear <name>, Your Rx delivery is now with <driver>, ETA <eta> -
 *            <+30 min>" (added Nov 25 2026, owner-approved copy)
 *
 * Delivery rules:
 *   • Only today's active stops for a real patient (store pickups are skipped);
 *     the moved check also looks at stops that just left today or sit on a
 *     future date, because that is what a move looks like.
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
// A moved / handed-off stop only notifies while the change is still news; a
// device that has been offline for days must not announce last week's edits.
const CHANGE_FRESH_MS = 2 * 60 * 60 * 1000;
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

export function buildPatientDeliveryMessage({ state, patientName, etaText, window, dateText, driverName }) {
  const name = String(patientName || '').trim().split(/\s+/)[0] || 'there';
  switch (state) {
    case 'pending':
      // OWNER REPORT (Nov 25 2026): a pending stop with no window anywhere used
      // to send NOTHING at all. The approved line still goes out, just without a
      // time it cannot honestly quote.
      return window
        ? `Dear ${name}, Your Rx delivery is ready and awaiting pickup by the driver at ${window}`
        : `Dear ${name}, Your Rx delivery is ready and awaiting pickup by the driver`;
    case 'pickup':
      return `Dear ${name}, Your Rx delivery has been picked up by the driver and ETA is ${window}`;
    case 'next':
      return `Dear ${name}, Your Rx is next for delivery with an ETA of ${etaText}`;
    case 'delayed':
      return `Dear ${name}, Your Rx delivery is slightly delayed but should arrive now by ${window}`;
    // OWNER APPROVED COPY (Nov 25 2026): the driver moved the stop to another
    // date. The window is deliberately left for "when your driver is on duty",
    // and no reason is ever given.
    case 'moved':
      return `Dear ${name}, Your driver has moved your Rx to ${dateText}. Your new delivery window will be confirmed when your driver is on duty.`;
    // OWNER APPROVED COPY (Nov 25 2026): the stop was passed to another driver.
    case 'handoff':
      return `Dear ${name}, Your Rx delivery is now with ${driverName}, ETA ${window}`;
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

/** YYYY-MM-DD for tomorrow in Edmonton, so a move can say "Tomorrow". */
function albertaTomorrowKey() {
  return new Date(Date.now() - 6 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** "Tomorrow" / "Thu, Nov 27" for the moved notice. */
function dateLabel(dateKey) {
  const key = String(dateKey || '').slice(0, 10);
  if (!key) return 'a new date';
  if (key === albertaTodayKey()) return 'today';
  if (key === albertaTomorrowKey()) return 'Tomorrow';
  const ms = Date.parse(`${key}T12:00:00Z`);
  if (!Number.isFinite(ms)) return key;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Edmonton',
    }).format(new Date(ms));
  } catch {
    return key;
  }
}

/** First name for the handoff line ("now with Sarah, ETA 2:10 - 2:40 PM"). */
function firstNameOf(value) {
  return String(value || '').trim().split(/\s+/)[0] || '';
}

/**
 * Watches the dashboard's deliveries and sends the four patient pushes.
 * Mount once (Dashboard). The pass runs on every device, because a dispatcher or
 * an admin adding a stop must reach the patient just like the driver's own
 * phone does — that covers created-pending, moved, handoff and picked up (all
 * deduped server-side). `enabled` (primary-device flag) now only gates the two
 * narration states, next and delayed, so one phone does not narrate the route
 * three times over.
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

      const entry = ledger[delivery.id] || {};
      const patientName = nameById.get(String(delivery.patient_id)) || delivery.patient_name || '';
      const title = delivery.store_name || 'Your pharmacy';
      const eta = etaMinutes(delivery);
      const status = String(delivery.status || '').toLowerCase();
      const dateKey = String(delivery.delivery_date || '').slice(0, 10);
      const driverId = String(delivery.driver_id || '');

      // ── 5. MOVED TO A NEW DATE (owner request Nov 25 2026) ───────────────
      // Checked BEFORE the today filter: the whole point is a stop that just
      // left today (or moved between future dates). The ledger remembers the
      // date this device last saw, so a change is detectable from any path that
      // writes delivery_date (bulk edit, transfer dialog, stop card, offline).
      if (entry.date && dateKey && entry.date !== dateKey && ACTIVE.has(status)) {
        const changedMs = delivery.updated_date ? Date.parse(delivery.updated_date) : 0;
        const fresh = !changedMs || now - changedMs <= CHANGE_FRESH_MS;
        if (fresh) {
          const body = buildPatientDeliveryMessage({
            state: 'moved',
            patientName,
            dateText: dateLabel(dateKey),
          });
          await pushPatient(delivery.patient_id, title, body, `rx-moved-${delivery.id}-${dateKey}`, {
            store_id: delivery.store_id,
            store_name: delivery.store_name,
            sender_name: String(delivery.driver_name || '').trim(),
          });
        }
      }
      if (dateKey) entry.date = dateKey;

      // ── 6. HANDED OFF TO ANOTHER DRIVER (owner request Nov 25 2026) ──────
      // Only a real reassignment from one driver to a DIFFERENT one counts:
      // unassigned -> driver (that is a dispatcher assigning, and the patient
      // already hears about a new stop) and driver -> unassigned are skipped.
      if (entry.driverId && driverId && entry.driverId !== driverId && ACTIVE.has(status)
        && dateKey === today) {
        const changedMs = delivery.updated_date ? Date.parse(delivery.updated_date) : 0;
        const fresh = !changedMs || now - changedMs <= CHANGE_FRESH_MS;
        const newDriver = firstNameOf(delivery.driver_name);
        const windowMinutes = eta;
        if (fresh && newDriver && windowMinutes != null) {
          const body = buildPatientDeliveryMessage({
            state: 'handoff',
            patientName,
            driverName: newDriver,
            window: windowText(windowMinutes),
          });
          await pushPatient(delivery.patient_id, title, body, `rx-handoff-${delivery.id}-${driverId}`, {
            store_id: delivery.store_id,
            store_name: delivery.store_name,
            sender_name: String(delivery.driver_name || '').trim(),
          });
        }
      }
      if (driverId) entry.driverId = driverId;
      ledger[delivery.id] = entry;

      if (dateKey !== today) continue;
      if (!ACTIVE.has(status)) continue;

      // ── 1. Created as pending ──────────────────────────────────────────
      if (status === 'pending' && !entry.pending) {
        const createdMs = delivery.created_date ? Date.parse(delivery.created_date) : 0;
        if (createdMs && now - createdMs <= PENDING_FRESH_MS) {
          const parentPickup = delivery.puid ? pickupByPuid.get(String(delivery.puid)) : null;
          const pickupMinutes = etaMinutes(parentPickup) ?? eta;
          {
            const body = buildPatientDeliveryMessage({
              state: 'pending',
              patientName,
              window: pickupMinutes != null ? windowText(pickupMinutes) : null,
            });
            // The notice is credited to the driver who owns the stop, so it never
          // reads as a pharmacy-team message he did not send.
          const creatorName = String(delivery.driver_name || '').trim()
            || String(userRef.current?.user_name || userRef.current?.full_name || '').trim();
          await pushPatient(delivery.patient_id, title, body, `rx-pending-${delivery.id}`, { store_id: delivery.store_id, store_name: delivery.store_name, sender_name: creatorName });
            entry.pending = true;
            if (pickupMinutes != null) entry.etaEnd = pickupMinutes + 30;
          }
        }
      }

      // ── 2. Picked up (covers staged -> in_transit jumps) ────────────────
      // OWNER REQUEST (Nov 25 2026): a stop can be added straight to a driver's
      // route as in_transit from three places — a dispatcher, an admin, or the
      // driver — and all three must reach the patient. So this state is no longer
      // primary-device only (the server dedupes one body per 12h). To stop a
      // dashboard opened hours later from re-announcing an old pickup, the status
      // change has to be recent; the window falls back to the parent pickup's ETA
      // when the stop itself has none yet.
      if (!entry.pickup && (status === 'in_transit' || status === 'en_route')) {
        const changedMs = delivery.updated_date ? Date.parse(delivery.updated_date) : 0;
        const fresh = !changedMs || now - changedMs <= CHANGE_FRESH_MS;
        const parentPickup = delivery.puid ? pickupByPuid.get(String(delivery.puid)) : null;
        const pickupMinutes = eta ?? etaMinutes(parentPickup);
        if (fresh && pickupMinutes != null) {
          const body = buildPatientDeliveryMessage({
            state: 'pickup',
            patientName,
            window: windowText(pickupMinutes),
          });
          await pushPatient(delivery.patient_id, title, body, `rx-pickup-${delivery.id}`, { store_id: delivery.store_id, store_name: delivery.store_name });
          entry.pickup = true;
          entry.etaEnd = pickupMinutes + 30;
        }
        // The primary device ADOPTS the picked-up state even when another device
        // sent the notice, because the delayed check below is keyed on it — a
        // dispatcher's push must not cost the driver's phone its delay notices.
        if (primaryDevice && !entry.pickup && pickupMinutes != null) {
          entry.pickup = true;
          entry.etaEnd = pickupMinutes + 30;
        }
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
    // OWNER REPORT (Nov 25 2026): the "delivery created" notice never reached a
    // patient when a DISPATCHER (or a non-primary driver device) added the stop,
    // because this whole pass was primary-device only. Every dashboard now runs
    // the pass; the live-route states stay primary-device only inside evaluate(),
    // and the server dedupes a body it already pushed in the last 12h, so several
    // devices cannot double-notify.
    if (settleTimerRef.current) return undefined;
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      evaluate.current?.().catch(() => {});
    }, SETTLE_MS);
    return undefined;
  }, [deliveries, patients]);

  useEffect(() => () => {
    for (const timer of nextTimersRef.current.values()) clearTimeout(timer);
    nextTimersRef.current.clear();
  }, []);
}

export default usePatientDeliveryPushes;
