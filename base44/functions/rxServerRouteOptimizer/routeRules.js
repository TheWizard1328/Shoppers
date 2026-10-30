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
//
// PARITY CHECKLIST (owner directive Oct 30 2026: "any changes that I make to the
// route optimizer should be mirrored both client and server side ... eventually
// we would be getting rid of the client side"). Before shipping ANY optimizer
// change, confirm BOTH engines pick it up:
//   1. Sequencing inputs      → resolveSequenceSearch() here (client v13 had its
//                              own copy; that is exactly how the order drifted)
//   2. Window bands / 2h sort → windowBandSort / windowBandOfStop here
//   3. ISP-before-ISD, pickup-before-pending → enforceIspBeforeIsd /
//                              enforcePickupBeforePendingDeliveries here
//   4. Dwell + same-address   → dwellMinutesForStop / isSameAddressAnchor here
//   5. Polyline eligibility   → isPolylineEligibleStop here
//   6. ETA ladder             → client calculateRealTimeETA chain, mirrored in
//                              entry.ts; window floors + dwell caps must match
// If a rule cannot live here (HERE/Google request shape), keep the mapping in a
// resolver function in THIS file and call it from both engines.
// ─────────────────────────────────────────────────────────────────────────────

// 2-hour chronology bands (owner rule Oct 5 2026)
export const TIME_BAND_MINUTES = 120;

// Dwell + same-address rules (owner ladder rules)
export const SAME_ADDRESS_TRAVEL_MINUTES = 2;
export const PICKUP_DWELL_MINUTES = 15;
export const DELIVERY_DWELL_MINUTES = 5;
export const SAME_ADDRESS_KM = 0.05;

// ─── Route preference → HERE sequence search (OWNER DIRECTIVE Oct 30 2026) ───
// "Any changes that I make to the route optimizer should be mirrored both client
// and server side." The Fastest / Shortest / Best preference used to be applied
// by each engine on its own (the client in v13, the server not at all) — exactly
// the drift this file exists to prevent. BOTH engines now call this one helper:
//   fastest  → mode=fastest,  improveFor=time      (quickest total drive)
//   shortest → mode=shortest, improveFor=distance   (fewest total km)
//   best     → mode=fastest,  improveFor=quality    (HERE's balanced pick)
// Traffic awareness adds HERE's traffic flag to the FASTEST modes only: HERE's
// shortest mode has no traffic weighting, so it is omitted there rather than
// silently degrading the request.
export const ROUTE_PREFERENCE_VALUES = ['fastest', 'shortest', 'best'];

export function resolveSequenceSearch({ routePreference, trafficAware, transportMode = 'car' } = {}) {
  const pref = ROUTE_PREFERENCE_VALUES.includes(routePreference) ? routePreference : 'fastest';
  const traffic = trafficAware === true;
  if (pref === 'shortest') {
    return { preference: pref, traffic: false, mode: `shortest;${transportMode}`, improveFor: 'distance' };
  }
  return {
    preference: pref,
    traffic,
    mode: `fastest;${transportMode};traffic:${traffic ? 'enabled' : 'disabled'}`,
    improveFor: pref === 'best' ? 'quality' : 'time',
  };
}

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

export function windowBandSort(stops, { routeIsToday, currentMinutes, windowOf, windowEndOf }) {
  const bandOf = (stop) => windowBandOfStop(stop, { routeIsToday, currentMinutes, windowOf });
  const inputOrder = new Map((stops || []).map((s, i) => [s, i]));
  const endMin = (stop) => {
    try {
      const raw = windowEndOf ? windowEndOf(stop) : '';
      const m = parseTimeToMinutes(raw || '');
      return Number.isFinite(m) && m > 0 ? m : NaN;
    } catch (_) { return NaN; }
  };
  return [...(stops || [])].sort((a, b) => {
    const bandDiff = bandOf(a) - bandOf(b);
    if (bandDiff !== 0) return bandDiff;
    // OWNER RULE (Oct 30 2026): "no matter what the route type is, time
    // windows should always be respected." Inside a band the stop whose window
    // CLOSES first now goes first, so a tighter deadline can no longer be
    // pushed past its window end by a later-closing neighbour (the live route
    // showed a 17:00-17:30 stop sitting behind a 17:30-18:00 one). Road order
    // still decides between stops whose windows close together or are open.
    const ea = endMin(a);
    const eb = endMin(b);
    if (Number.isFinite(ea) || Number.isFinite(eb)) {
      if (Number.isFinite(ea) && Number.isFinite(eb) && ea !== eb) return ea - eb;
      if (Number.isFinite(ea) && !Number.isFinite(eb)) return -1;
      if (!Number.isFinite(ea) && Number.isFinite(eb)) return 1;
    }
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
