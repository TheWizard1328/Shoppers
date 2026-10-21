// ─────────────────────────────────────────────────────────────────────────────
// routeRules.js — THE SINGLE RULE BASE for route optimization + polyline
// generation. OWNER DIRECTIVE (Oct 21 2026): "one set of rules, two engines".
//
// Imported by BOTH engines:
//   • CLIENT  — clientRouteEngine.js, serverOptimizationMode.js,
//              routePolylineGenerator.js (bundled by Vite)
//   • SERVER  — rxServerRouteOptimizer/entry.ts (Deno, relative import)
//
// RULE: every sequencing/window/polyline-eligibility/dwell rule lives HERE and
// ONLY here. Engines pass shape adapters (plain accessors) — they must never
// re-implement a rule. If you change route behavior, you change this file.
// ─────────────────────────────────────────────────────────────────────────────

// 2-hour chronology bands (owner rule Oct 5 2026)
export const TIME_BAND_MINUTES = 120;

// Dwell + same-address rules (owner ladder rules)
export const SAME_ADDRESS_TRAVEL_MINUTES = 2;
export const PICKUP_DWELL_MINUTES = 15;
export const DELIVERY_DWELL_MINUTES = 5;
export const SAME_ADDRESS_KM = 0.05;

// Missing/invalid time → Infinity (both engines' canonical semantics).
export function parseTimeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return Infinity;
  const parts = timeStr.split(':');
  if (parts.length < 2) return Infinity;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return Infinity;
  return h * 60 + m;
}

export function formatMinutesToTime(totalMinutes) {
  const m = Math.max(0, Math.round(Number(totalMinutes) || 0));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// Crow-flies distance in km (pure math, shared by both engines).
export function crowFliesKm(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = (((b.lon ?? b.lng) - (a.lon ?? a.lng)) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// ── RULE: pickup-window inheritance ──────────────────────────────────────────
// The single formula both engines use: a windowless patient delivery inherits
// its pickup's window START + 5 min. Returns the formatted window or null.
export function inheritedPickupWindowStart(pickupWindowStart) {
  const m = parseTimeToMinutes(pickupWindowStart);
  if (m === Infinity || m <= 0) return null;
  return formatMinutesToTime(m + 5);
}
// A patient delivery with NO window of its own inherits its pickup's window
// START + 5 min (Accept All stamps now+5 on windowless deliveries; windowless
// stops must never sort before their pickup's window band).
// Adapters: patientOf(s), puidOf(s), windowOf(s), setWindowOf(s, w),
//           isPickupOf(s), pickupKeyOf(s), pickupWindowOf(s) (optional override)
export function inheritPickupWindows(stops, adapters) {
  const {
    patientOf = (s) => s.patientId,
    puidOf = (s) => s.puid,
    windowOf = (s) => s.windowStart,
    setWindowOf = (s, w) => { s.windowStart = w; },
    isPickupOf = (s) => s.isPickup,
    pickupKeyOf = (s) => s.stopId,
    pickupWindowOf = null,
  } = adapters || {};

  const pickupWindowByStopId = new Map();
  for (const s of stops || []) {
    if (!isPickupOf(s)) continue;
    const w = pickupWindowOf ? pickupWindowOf(s) : windowOf(s);
    pickupWindowByStopId.set(pickupKeyOf(s), { start: w ?? null });
  }
  let inherited = 0;
  for (const s of stops || []) {
    if (!patientOf(s) || !puidOf(s)) continue;
    const own = windowOf(s);
    if (own && parseTimeToMinutes(own) !== Infinity) continue;
    const w = inheritedPickupWindowStart(pickupWindowByStopId.get(puidOf(s))?.start);
    if (w) {
      setWindowOf(s, w);
      inherited++;
    }
  }
  return inherited;
}

// ── RULE: 2-hour window-band chronology sort ─────────────────────────────────
// BAND = the stop's EARLIEST SERVABLE TIME (owner rule Oct 5 2026): no window,
// or a window already open (TODAY routes only) → the "now" band (earliest);
// a future window → its window's chronological band. Stable — ties keep the
// caller's order (HERE drive-time order). Returns the sorted array.
// windowOf(s): the stop's window-start string (or null).
export function windowBandOfStop(stop, { routeIsToday, currentMinutes, windowOf }) {
  const nowBand = Math.floor(currentMinutes / TIME_BAND_MINUTES);
  const m = parseTimeToMinutes(windowOf(stop) || '');
  if (!Number.isFinite(m) || m <= 0) return nowBand; // no window → servable now
  if (routeIsToday && m <= currentMinutes) return nowBand; // window already open → servable now
  return Math.floor(m / TIME_BAND_MINUTES); // future window → chronological band
}

export function windowBandSort(stops, { routeIsToday, currentMinutes, windowOf }) {
  const bandOf = (stop) => windowBandOfStop(stop, { routeIsToday, currentMinutes, windowOf });
  const inputOrder = new Map((stops || []).map((s, i) => [s, i]));
  return [...(stops || [])].sort((a, b) => {
    const bandDiff = bandOf(a) - bandOf(b);
    if (bandDiff !== 0) return bandDiff;
    return (inputOrder.get(a) ?? 0) - (inputOrder.get(b) ?? 0);
  });
}

// Gate for the band sort: does ANY stop carry a real future-ish window?
// windowOf(s) as above. Returns true when at least one stop has a
// resolvable window start > 00:00.
export function hasTimeWindows(stops, windowOf) {
  return (stops || []).some((s) => {
    const m = parseTimeToMinutes(windowOf(s) || '');
    return Number.isFinite(m) && m > 0;
  });
}

// ── RULE: ISP-before-ISD ordering constraint ──────────────────────────────────
// InterStore deliveries (ISD) must never precede their source pickup (ISP);
// ISD.puid === ISP.stop_id. Fixpoint swap loop, stable otherwise.
// Adapters: idOf(s), deliveryIdOf(s), puidOf(s), stopIdOf(s)
export function enforceIspBeforeIsd(stops, adapters) {
  const {
    idOf = (s) => s.id,
    deliveryIdOf = (s) => s.deliveryId,
    puidOf = (s) => s.puid,
    stopIdOf = (s) => s.stopId,
  } = adapters || {};
  let ordered = [...(stops || [])];
  const ispByStopId = new Map(ordered
    .filter((s) => String(deliveryIdOf(s) || '').startsWith('ISP'))
    .map((s) => [String(stopIdOf(s)), s]));
  let swapped = true;
  while (swapped) {
    swapped = false;
    for (let i = 0; i < ordered.length; i++) {
      const stop = ordered[i];
      if (String(deliveryIdOf(stop) || '').startsWith('ISD') && puidOf(stop)) {
        const linkedISP = ispByStopId.get(String(puidOf(stop)));
        if (!linkedISP) continue;
        const ispIdx = ordered.findIndex((s) => idOf(s) === idOf(linkedISP));
        if (ispIdx > i) {
          const tmp = ordered[i];
          ordered[i] = ordered[ispIdx];
          ordered[ispIdx] = tmp;
          swapped = true;
          break;
        }
      }
    }
  }
  return ordered;
}

// ── RULE: pending deliveries follow their pickup (LIVE route) ────────────────
// A PENDING patient stop cannot be delivered before its source pickup is
// visited (puid → pickup stop on the same route). In-hand stops (en_route /
// in_transit) are NOT constrained (owner rule Oct 1 2026). Fixpoint swap,
// mirrors enforceIspBeforeIsd. Adapters: idOf, patientOf, puidOf,
// statusOf, isPickupOf, pickupKeyOf.
export function enforcePickupBeforePendingDeliveries(stops, adapters) {
  const {
    idOf = (s) => s.id,
    patientOf = (s) => s.patientId,
    puidOf = (s) => s.puid,
    statusOf = (s) => s.status,
    isPickupOf = (s) => s.isPickup,
    pickupKeyOf = (s) => s.stopId,
  } = adapters || {};
  let ordered = [...(stops || [])];
  const pickupByKey = new Map(ordered.filter((s) => isPickupOf(s)).map((s) => [String(pickupKeyOf(s)), s]));
  let swapped = true;
  while (swapped) {
    swapped = false;
    for (let i = 0; i < ordered.length; i++) {
      const stop = ordered[i];
      const isPending = String(statusOf(stop) || '').toLowerCase() === 'pending';
      if (!isPending || !patientOf(stop) || !puidOf(stop)) continue;
      const pickup = pickupByKey.get(String(puidOf(stop)));
      if (!pickup) continue;
      const pIdx = ordered.findIndex((s) => idOf(s) === idOf(pickup));
      if (pIdx > i) {
        const tmp = ordered[i];
        ordered[i] = ordered[pIdx];
        ordered[pIdx] = tmp;
        swapped = true;
        break;
      }
    }
  }
  return ordered;
}

// ── RULE: polyline eligibility ───────────────────────────────────────────────
// ONLY en_route + in_transit stops (plus cycling markers and cycling-mode
// stops) receive polylines. A pending stop hasn't been picked up yet — no
// driving path renders into it; legs BRIDGE across pending stops.
export function isPolylineEligibleStop({ status, isCyclingMarker, transportMode }) {
  const st = String(status || '').toLowerCase();
  if (st === 'en_route' || st === 'in_transit') return true;
  if (isCyclingMarker === true) return true;
  if (String(transportMode || '').toLowerCase() === 'cycling') return true;
  return false;
}

// ── RULE: dwell minutes per stop type ────────────────────────────────────────
// extra_time override, else pickups 15 / deliveries 5 (ETA ladder dwell).
export function dwellMinutesForStop({ extraTime, isPickup }) {
  const extra = Number(extraTime);
  if (Number.isFinite(extra) && extra > 0) return extra;
  return isPickup ? PICKUP_DWELL_MINUTES : DELIVERY_DWELL_MINUTES;
}

// ── RULE: same-address adjacency (2-minute travel cap) ────────────────────────
export function isSameAddressAnchor(a, b, km = SAME_ADDRESS_KM) {
  const d = crowFliesKm(a, b);
  return Number.isFinite(d) && d < km;
}
