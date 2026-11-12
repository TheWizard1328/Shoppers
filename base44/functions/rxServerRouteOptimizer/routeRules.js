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
//   best     → mode=fastest,  improveFor=time       (quality is rejected by v8)
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
  // OWNER REPORT Nov 12 2026 (verified against the live HERE endpoint): v8
  // findsequence2 answers 400 "Parameter 'improveFor' only accepts 'time' or
  // 'distance'" for improveFor=quality, so the "best" preference used to make
  // EVERY sequencing call fail and the route fell back to crow-flies ordering.
  // "best" now asks for time and keeps HERE's balanced default through the
  // traffic flag, which is what quality was meant to express.
  return {
    preference: pref,
    traffic,
    mode: `fastest;${transportMode};traffic:${traffic ? 'enabled' : 'disabled'}`,
    improveFor: 'time',
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

// ── RETIRED (Nov 3 2026): windowBandSort / enforceWindowDeadlines ───────────
// OWNER SPEC, verbatim: "we are basically supposed to use the time windows as
// gates for ordering meaning deliveries must be done after the delivery start
// time anytime after the delivery start time and if there is a delivery end
// time the optimizer should be able to place that stop anywhere prior to that
// end time and not have to hoist it first if there's time to get to it with
// other stops before it."
// Both helpers below are NO LONGER CALLED by either engine. Windows now travel
// with the HERE waypoint payload (both sides, ±30-minute sway, past starts
// clamped to the current time, pickups never gated), so HERE sequences by road
// while honouring them and no post-hoc band sort or hoist pass runs at all.
// Measured on the real Nov 3 route: the old banded order drove 142.2 km, this
// is 122.3 km. Kept only as reference — do NOT re-wire them.

// ── RULE: 2-hour window-band chronology sort (RETIRED — see above) ───────────
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
    // OWNER SPEC (Nov 3 2026) SUPERSEDES the Oct 30 "closes first" hoist:
    // "deliveries must be done after the delivery start time, anytime after
    // the delivery start time, and if there is a delivery END time the
    // optimizer should be able to place that stop ANYWHERE prior to that end
    // time and not have to hoist it first if there's time to get to it with
    // other stops before it."
    // So inside a band the road order (HERE drive time) now decides, full stop.
    // A stop is no longer pulled to the front because its window merely closes
    // sooner — that hoist is what sent the owner's 13:30-15:30 stop 10 km east
    // first, back west for six stops, then east again past it for two more.
    // Deadline protection moved to enforceWindowDeadlines below, which lifts a
    // stop only when the forward clock proves it would otherwise arrive late.
    return (inputOrder.get(a) ?? 0) - (inputOrder.get(b) ?? 0);
  });
}

// ── RULE: window STARTS gate the clock, window ENDS are deadlines ────────────
// OWNER SPEC (Nov 3 2026), verbatim: "we are basically supposed to use the time
// windows as gates for ordering meaning deliveries must be done after the
// delivery start time anytime after the delivery start time and if there is a
// delivery end time the optimizer should be able to place that stop anywhere
// prior to that end time and not have to hoist it first if there's time to get
// to it with other stops before it."
// Walks the order with a forward clock (wait for a start that has not opened
// yet, then add leg + dwell) and lifts ONLY a stop the simulation proves will
// arrive after its own window end. The lift is the smallest one that fixes the
// violation (nearest earlier slot first) and it never increases the total
// number of late stops. No end time → never lifted, ever.
// Adapters: startOf(s), endOf(s), coordsOf(s) -> {lat,lng}|null or legMinutes(a,b).
export function enforceWindowDeadlines(stops, {
  currentMinutes,
  startOf,
  endOf,
  coordsOf,
  legMinutes,
  dwellMinutes = 2,
  averageSpeedKph = 32,
  maxLifts = 6,
} = {}) {
  const toMin = (v) => {
    const m = parseTimeToMinutes(v || '');
    return Number.isFinite(m) && m > 0 ? m : NaN;
  };
  const legMin = (a, b) => {
    try {
      if (legMinutes) {
        const m = legMinutes(a, b);
        if (Number.isFinite(m) && m >= 0) return m;
      }
      const ca = coordsOf ? coordsOf(a) : null;
      const cb = coordsOf ? coordsOf(b) : null;
      if (ca && cb && Number.isFinite(ca.lat) && Number.isFinite(cb.lat)) {
        const dLat = ((cb.lat - ca.lat) * Math.PI) / 180;
        const dLng = ((cb.lng - ca.lng) * Math.PI) / 180;
        const h = Math.sin(dLat / 2) ** 2
          + Math.cos((ca.lat * Math.PI) / 180) * Math.cos((cb.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
        const km = 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
        return Math.max(1, Math.round((km / Math.max(10, averageSpeedKph)) * 60));
      }
    } catch (_) { /* fall through to the generic hop */ }
    return 5;
  };
  const simulate = (arr) => {
    let t = Number.isFinite(currentMinutes) ? currentMinutes : 0;
    const arrivals = [];
    let violations = 0;
    for (let i = 0; i < arr.length; i++) {
      if (i > 0) t += legMin(arr[i - 1], arr[i]);
      const st = toMin(startOf ? startOf(arr[i]) : null);
      if (Number.isFinite(st) && t < st) t = st; // gate: never before the start
      arrivals.push(t);
      const en = toMin(endOf ? endOf(arr[i]) : null);
      if (Number.isFinite(en) && t > en) violations++;
      t += dwellMinutes;
    }
    return { arrivals, violations };
  };

  let out = [...(stops || [])];
  if (out.length < 2) return out;
  let sim = simulate(out);
  for (let lift = 0; lift < maxLifts && sim.violations > 0; lift++) {
    let riskIdx = -1;
    for (let i = 0; i < out.length; i++) {
      const en = toMin(endOf ? endOf(out[i]) : null);
      if (Number.isFinite(en) && sim.arrivals[i] > en) { riskIdx = i; break; }
    }
    if (riskIdx <= 0) break; // nothing earlier to lift past
    const risky = out[riskIdx];
    const riskyEnd = toMin(endOf ? endOf(risky) : null);
    let applied = false;
    for (let j = riskIdx - 1; j >= 0; j--) {
      const cand = out.slice();
      cand.splice(riskIdx, 1);
      cand.splice(j, 0, risky);
      const candSim = simulate(cand);
      const riskyOnTime = !Number.isFinite(riskyEnd) || candSim.arrivals[j] <= riskyEnd;
      if (riskyOnTime && candSim.violations < sim.violations) {
        out = cand;
        sim = candSim;
        applied = true;
        break;
      }
    }
    if (!applied) break;
  }
  return out;
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

// ─────────────────────────────────────────────────────────────────────────────
// RULE: an IN-HAND stop is never dragged behind its own pickup
// (owner directive Nov 3 2026: "it is the delivery must be after pickup rule
// I think. even though this stop is already in transit. That status should
// negate the pickup before delivery rule.")
//
// The pickup-first constraint exists because the driver cannot hand over meds
// still sitting on the store shelf. A stop that is en_route/in_transit already
// HAS its meds in hand, so the constraint does not apply to it at all: its own
// window decides its position, exactly like every other in-hand stop.
//
// RUns LAST, after the window bands / pickup swaps / ISP-ISD passes, so no
// earlier swap can leave an in-hand stop sitting behind its own pickup. Only
// lifts the delivery AHEAD of the pickup; never pushes anything else around.
//   · in-hand delivery whose pickup is AHEAD of it, and
//   · (its start is blank — in-hand blanks lead the route) or
//   · (its start is at/before the pickup's start),
// moves to just before that pickup. A stop whose window opens AFTER the
// pickup's window stays put: it was sequenced there on purpose.
// ── RULE: PICKUP WINDOW SEQUENCE (owner directive Nov 4 2026) ───────────────
// "The delivery time windows for pickups are only designed to make sure the
// pickups are in the right sequence before a route starts, and to keep them in
// the right sequence throughout the day. When it comes to live sequencing the
// delivery END times for pickups aren't absolute — all that matters is that
// pickups are sequenced in the right order based on their pickup START windows."
//
// So: unfilled pickups are ordered by their window START relative to each
// other, start only (never an end), every time the route is sequenced —
// including mid-day retries and live re-optimizations. Everything that is not
// an unfilled pickup keeps its position, so geography between pickups survives.
export function enforcePickupWindowOrder(stops, adapters) {
  const {
    isPickupOf = (s) => s.isPickup,
    statusOf = (s) => s.status,
    startOf = (s) => s.deliveryTimeStart,
    parseStart = null,
  } = adapters || {};
  const parse = parseStart || ((v) => {
    const m = String(v || '').trim().match(/^(\d{1,2}):(\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  });
  const CLOSED = new Set(['completed', 'failed', 'cancelled', 'returned']);
  const isOpenPickup = (s) => !!isPickupOf(s) && !CLOSED.has(String(statusOf(s) || '').toLowerCase());
  let ordered = [...(stops || [])];
  if (ordered.filter(isOpenPickup).length < 2) return ordered;
  let guard = 0;
  let moved = true;
  while (moved && guard < 200) {
    moved = false;
    guard += 1;
    const idxs = ordered.reduce((acc, s, i) => (isOpenPickup(s) ? acc.concat(i) : acc), []);
    for (let k = 0; k < idxs.length - 1; k++) {
      const a = ordered[idxs[k]];
      const b = ordered[idxs[k + 1]];
      const sa = parse(startOf(a));
      const sb = parse(startOf(b));
      if (Number.isFinite(sa) && Number.isFinite(sb) && sb < sa) {
        ordered.splice(idxs[k + 1], 1);
        ordered.splice(idxs[k], 0, b);
        moved = true;
        break;
      }
    }
  }
  return ordered;
}

export function enforceInHandBeforeItsPickup(stops, adapters) {
  const {
    idOf = (s) => s.id,
    patientOf = (s) => s.patientId,
    puidOf = (s) => s.puid,
    statusOf = (s) => s.status,
    isPickupOf = (s) => s.isPickup,
    pickupKeyOf = (s) => s.stopId,
    startOf = (s) => s.deliveryTimeStart,
    parseStart = null,
  } = adapters || {};
  const parse = parseStart || ((v) => {
    const m = String(v || '').trim().match(/^(\d{1,2}):(\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  });
  const IN_HAND = new Set(['en_route', 'in_transit']);
  let ordered = [...(stops || [])];
  const pickupByKey = new Map(ordered.filter((s) => isPickupOf(s)).map((s) => [String(pickupKeyOf(s)), s]));
  if (pickupByKey.size === 0) return ordered;
  let guard = 0;
  let moved = true;
  while (moved && guard < 200) {
    moved = false;
    guard += 1;
    for (let i = 0; i < ordered.length; i++) {
      const stop = ordered[i];
      if (isPickupOf(stop) || !patientOf(stop) || !puidOf(stop)) continue;
      if (!IN_HAND.has(String(statusOf(stop) || '').toLowerCase())) continue;
      const pickup = pickupByKey.get(String(puidOf(stop)));
      if (!pickup) continue;
      const pIdx = ordered.findIndex((s) => idOf(s) === idOf(pickup));
      if (pIdx < 0 || pIdx > i) continue; // pickup already after the stop (or absent)
      const dStart = parse(startOf(stop));
      const pStart = parse(startOf(pickup));
      const leads = !Number.isFinite(dStart) || !Number.isFinite(pStart) || dStart <= pStart;
      if (!leads) continue;
      ordered.splice(i, 1);
      const target = ordered.findIndex((s) => idOf(s) === idOf(pickup));
      ordered.splice(target, 0, stop);
      moved = true;
      break;
    }
  }
  return ordered;
}

// ── RULE: cycling block structure (owner report Nov 3 2026) ──────────────────
// A cycling loop is ONE contiguous block in the route:
//     [cycling START marker] → [every cycling-mode stop] → [cycling END marker]
// and every non-cycling stop is AFTER the end marker (leading pickups / already
// finished work excepted — they are the loop's origin and stay in front).
//
// Symptom that produced this rule: Robert's route came back with the END marker
// at position 9, one driving delivery right behind it, and the three remaining
// cycling stops scattered at 11-13 — driving stops "optimized before the
// cycling stops instead of after the cycling end marker" — from BOTH the manual
// optimize FAB and the Start button. Every earlier pass (window bands, pickup
// follow, ISP/ISD, unit micro-sort, in-hand repair) sorts stops individually and
// has no idea the loop is structural, so ANY of them can pull a driving stop
// into the block. This rule runs LAST in both engines: it takes whatever order
// those passes produced and restores the block, keeping each group's relative
// order (so window chronology inside the cycling stops and inside the driving
// stops survives untouched).
//
// Returns a NEW array. No-op (same array content, in original order) when the
// route has no end marker or no cycling stops — a route without an end marker is
// a single-pool driving route by owner rule (Sep 8 2026).
export function enforceCyclingBlock(stops, adapters) {
  const {
    idOf = (s) => s?.id,
    notesOf = (s) => s?.deliveryNotes,
    isMarkerOf = (s) => s?.isCyclingMarker === true,
    transportModeOf = (s) => s?.transportMode,
    statusOf = (s) => s?.status,
  } = adapters || {};
  const ordered = [...(stops || [])];
  if (ordered.length < 2) return ordered;

  const notesOfLower = (s) => String(notesOf(s) || '').toLowerCase();
  const isMarker = (s) => isMarkerOf(s) === true;
  const isCycleStop = (s) => !isMarker(s) && String(transportModeOf(s) || '').toLowerCase() === 'cycling';
  const isFinished = (s) => ['completed', 'failed', 'cancelled'].includes(String(statusOf(s) || '').toLowerCase());

  const endMarker = ordered.find((s) => isMarker(s) && notesOfLower(s).includes('end') && !isFinished(s)) || null;
  const cyclingStops = ordered.filter((s) => isCycleStop(s) && !isFinished(s));
  if (!endMarker || cyclingStops.length === 0) return ordered;

  const startMarker = ordered.find((s) => isMarker(s) && notesOfLower(s).includes('start') && !isFinished(s)) || null;
  // End marker that carried "start" in its notes (defensive): never treat it as both.
  const startIsEnd = startMarker && idOf(startMarker) === idOf(endMarker);

  const blockIds = new Set(
    [startIsEnd ? null : startMarker, ...cyclingStops, endMarker]
      .filter(Boolean)
      .map((s) => String(idOf(s)))
  );
  const blockMembers = ordered.filter((s) => blockIds.has(String(idOf(s))));
  if (blockMembers.length <= 1) return ordered;

  const firstBlockIdx = ordered.findIndex((s) => blockIds.has(String(idOf(s))));
  if (firstBlockIdx < 0) return ordered;

  // Everything the loop has to travel through already ordered, EXCLUDING the
  // markers themselves (they are positional anchors, placed by this rule).
  const cyclingOrdered = ordered.filter((s) => isCycleStop(s) && !isFinished(s) && blockIds.has(String(idOf(s))));

  const leading = ordered.slice(0, firstBlockIdx);
  const trailing = ordered.filter((s) => !blockIds.has(String(idOf(s))) && !leading.includes(s));

  const next = [
    ...leading,
    ...(startIsEnd ? [] : startMarker ? [startMarker] : []),
    ...cyclingOrdered,
    endMarker,
    ...trailing,
  ];

  // Preserve length and identity — a rule bug must never drop or duplicate a stop.
  if (next.length !== ordered.length) return ordered;
  const sameOrder = next.every((s, i) => idOf(s) === idOf(ordered[i]));
  return sameOrder ? ordered : next;
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

// ═══════════════════════════════════════════════════════════════════════════
// RULE: unit-number micro-sort for clustered stops (SHARED, both engines)
// ═══════════════════════════════════════════════════════════════════════════
// OWNER SPEC (Oct 26 2026, restated Nov 2 2026): "stops that share the same
// address or GPS coordinates should be getting subsorted via their unit
// numbers." A building with units 222 / 312 / 210 / 336 must be walked
// 210 -> 222 -> 312 -> 336, not in whatever order findsequence2 returned.
//
// Clustering: identical rounded GPS (4dp ≈ 11 m) OR identical normalized
// street address (unit/apt/suite/room/floor tokens stripped, because units in
// one building often carry slightly different coordinates).
// PUID-partitioned: units sort WITHIN each pickup chain only, so a delivery can
// never jump ahead of its own pickup; chains keep their first-appearance order.
//
// The client engine (clientRouteEngine.js) and the server engine (entry.ts)
// both call THIS function with their own adapters — one rule, two engines.
export const UNIT_GPS_PRECISION = 4;
// Strips the unit TOKEN *and its value* ('Unit 222', 'Apt #12B', '#222')
// so the same building collapses to one address key.
const UNIT_TOKEN_RX = /(?:\b(?:UNIT|APT|APARTMENT|SUITE|STE|RM|ROOM|FL|FLOOR|BLDG|BUILDING|BAY|SPC|SPACE)\b\.?\s*#?\s*[A-Z0-9-]+|#\s*[A-Z0-9-]+)/gi;

export function normalizeAddressKey(address) {
  const addr = String(address || '').trim();
  if (!addr) return '';
  return addr
    .toUpperCase()
    .replace(UNIT_TOKEN_RX, ' ')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Numeric-aware: 210 < 222 < 312 < 336; unnumbered after numbered; letters A/B/C.
export function compareUnitNumbers(a, b) {
  const sa = String(a ?? '').trim();
  const sb = String(b ?? '').trim();
  const ma = sa.match(/^(\d+)\s*(.*)$/);
  const mb = sb.match(/^(\d+)\s*(.*)$/);
  if (ma && mb) {
    const diff = Number(ma[1]) - Number(mb[1]);
    if (diff !== 0) return diff;
    return (ma[2] || '').localeCompare(mb[2] || '');
  }
  if (ma) return -1;
  if (mb) return 1;
  return sa.localeCompare(sb);
}

export function unitNumberMicroSort(stops, adapters = {}) {
  const {
    idOf = (s) => s?.id,
    unitOf = (s) => s?.unitNumber,
    addressOf = (s) => s?.address,
    coordsOf = (s) => (Number.isFinite(Number(s?.lat)) && Number.isFinite(Number(s?.lng)) ? { lat: Number(s.lat), lng: Number(s.lng) } : null),
    puidOf = (s) => s?.puid,
    eligible = () => true,
  } = adapters;
  if (!Array.isArray(stops) || stops.length < 2) return stops;

  const roundGps = (v) => Number(Number(v).toFixed(UNIT_GPS_PRECISION));
  const processed = new Set();

  for (let i = 0; i < stops.length; i++) {
    if (processed.has(i) || !eligible(stops[i])) continue;
    const aCoords = coordsOf(stops[i]);
    const aLat = aCoords ? roundGps(aCoords.lat) : null;
    const aLng = aCoords ? roundGps(aCoords.lng) : null;
    const aAddr = normalizeAddressKey(addressOf(stops[i]));
    const groupIndices = [i];
    for (let j = i + 1; j < stops.length; j++) {
      if (processed.has(j) || !eligible(stops[j])) continue;
      const bCoords = coordsOf(stops[j]);
      const sameGps = aLat != null && !!bCoords && roundGps(bCoords.lat) === aLat && roundGps(bCoords.lng) === aLng;
      const sameAddr = !!aAddr && normalizeAddressKey(addressOf(stops[j])) === aAddr;
      if (sameGps || sameAddr) groupIndices.push(j);
    }
    if (groupIndices.length < 2) { processed.add(i); continue; }

    const byPuid = new Map();
    for (const idx of groupIndices) {
      const pk = String(puidOf(stops[idx]) || 'none');
      if (!byPuid.has(pk)) byPuid.set(pk, []);
      byPuid.get(pk).push(stops[idx]);
    }
    const partitions = [...byPuid.values()];
    partitions.forEach((part) => part.sort((x, y) => compareUnitNumbers(unitOf(x), unitOf(y))));

    const flat = [];
    const iters = partitions.map((part) => part[Symbol.iterator]());
    let more = true;
    while (more) {
      more = false;
      for (const it of iterators(iters)) {
        const next = it.next();
        if (!next.done) { flat.push(next.value); more = true; }
      }
    }
    groupIndices.forEach((idx, pos) => { stops[idx] = flat[pos]; processed.add(idx); });
  }
  return stops;
}

function* iterators(list) { for (const it of list) yield it; }

// ─────────────────────────────────────────────────────────────────────────────
// RULE 7 (OWNER SPEC Nov 3 2026): WHERE A TRANSFERRED STOP BELONGS
// ─────────────────────────────────────────────────────────────────────────────
// The pickups are the day's FIXED skeleton: home → P1 → P2 → … → Pn. They do not
// reorder before the driver goes on duty, so a stop moved to another date (or
// driver) has to be "fished into" that preset order. Only its START TIME is
// decided here; the 2-hour window band sort and the ETA ladder do the rest.
//
// The geometry: for every skeleton leg (A → B) measure how much a detour to the
// stop actually costs — costKm = (A→S) + (S→B) − (A→B). A leg only qualifies when
// the stop sits inside a corridor around it:
//   • near-end screen: the SMALLER of the angle A→S vs A→B and B→S vs B→A must be
//     within `halfAngleDeg` (30°). Taking the smaller angle is what makes a stop
//     sitting right next to one end of a long leg qualify; testing both ends at 30°
//     would reject it (owner case: a stop 0.8 km from home on an 11.8 km leg is 81°
//     off the home end but only 4° off the far end).
//   • lateral cap: perpendicular distance to the leg ≤ `maxPerpendicularKm`
//     (2.5 km). This, not the angle, is what keeps stops genuinely off-route out.
//   • projection: the stop must project onto the leg, allowing a small overshoot
//     (`minT` −0.1 … `maxT` 1.1), so a stop far past a pickup cannot join it.
//
// The cheapest qualifying leg wins:
//   • home leg (origin → P1) cheapest AND within the lead cap → START = '09:00',
//     i.e. deliver it on the way out before the first pickup (owner fallback:
//     "9am only if it works best on route to the first pickup without too much
//     deviation"). The cap is min(homeLeadMaxCostKm, 25% of the leg).
//   • a pickup leg (Pi → Pi+1) cheapest → START = Pi+1's window start + 5 min, so
//     it slots between those two pickups.
//   • nothing qualifies (or the home leg is over the cap and no pickup leg
//     qualifies) → START = the LAST pickup's window start + 5, i.e. the tail. Never
//     9am by default: an unrelated far stop would otherwise be dragged first.
export const TRANSFER_CORRIDOR = Object.freeze({
  halfAngleDeg: 30,
  maxPerpendicularKm: 2.5,
  minT: -0.1,
  maxT: 1.1,
  homeLeadMaxCostKm: 3,
  homeLeadMaxCostRatio: 0.25,
  leadTime: '09:00',
  pickupOffsetMinutes: 5,
});

const KM_PER_DEG = 111.32;

// Initial great-circle bearing A → B, degrees clockwise from north.
export function bearingBetween(a, b) {
  const la1 = Number(a?.lat) * Math.PI / 180;
  const la2 = Number(b?.lat) * Math.PI / 180;
  const dLon = (Number(b?.lng) - Number(a?.lng)) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  if (!Number.isFinite(y) || !Number.isFinite(x)) return NaN;
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Smallest angle between two bearings, 0…180°.
export function angularGapDeg(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  const v = Math.abs((a - b) % 360);
  return v > 180 ? 360 - v : v;
}

// Great-circle distance in km between two {lat,lng} points.
export function kmBetween(a, b) {
  const la1 = Number(a?.lat), lo1 = Number(a?.lng), la2 = Number(b?.lat), lo2 = Number(b?.lng);
  if (![la1, lo1, la2, lo2].every(Number.isFinite)) return NaN;
  const R = 6371.0088;
  const rla1 = la1 * Math.PI / 180, rla2 = la2 * Math.PI / 180;
  const dLat = rla2 - rla1, dLon = (lo2 - lo1) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rla1) * Math.cos(rla2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Local flat projection (km) around `from` — accurate at city scale.
const localKm = (from, p) => {
  const lat0 = Number(from.lat) * Math.PI / 180;
  return {
    x: (Number(p.lng) - Number(from.lng)) * KM_PER_DEG * Math.cos(lat0),
    y: (Number(p.lat) - Number(from.lat)) * KM_PER_DEG,
  };
};

/**
 * Measures one corridor leg against the candidate stop.
 * Returns null when the leg is degenerate or any input lacks coordinates.
 */
export function corridorCandidate({ from, to, point, options }) {
  const o = { ...TRANSFER_CORRIDOR, ...(options || {}) };
  const legKm = kmBetween(from, to);
  const dFrom = kmBetween(from, point);
  const dTo = kmBetween(to, point);
  if (!Number.isFinite(legKm) || !Number.isFinite(dFrom) || !Number.isFinite(dTo) || legKm < 0.05) return null;

  const a = localKm(from, to);
  const s = localKm(from, point);
  const L = Math.hypot(a.x, a.y);
  const t = L > 0 ? ((s.x * a.x) + (s.y * a.y)) / (L * L) : NaN;
  const perpendicularKm = L > 0 ? Math.abs((s.x * a.y) - (s.y * a.x)) / L : NaN;

  const angleFromDeg = angularGapDeg(bearingBetween(from, to), bearingBetween(from, point));
  const angleToDeg = angularGapDeg(bearingBetween(to, from), bearingBetween(to, point));
  const nearAngleDeg = Number.isFinite(angleFromDeg) && Number.isFinite(angleToDeg)
    ? Math.min(angleFromDeg, angleToDeg)
    : (Number.isFinite(angleFromDeg) ? angleFromDeg : angleToDeg);

  const costKm = dFrom + dTo - legKm;
  const inCorridor = Number.isFinite(t)
    && t >= o.minT && t <= o.maxT
    && perpendicularKm <= o.maxPerpendicularKm
    && Number.isFinite(nearAngleDeg) && nearAngleDeg <= o.halfAngleDeg;

  return { legKm, costKm, perpendicularKm, t, angleFromDeg, angleToDeg, nearAngleDeg, inCorridor };
}

/**
 * Decides the START TIME a transferred stop gets on its new route.
 *
 * @param {object}   args
 * @param {object}   args.point     {lat,lng} of the transferred stop
 * @param {object}   args.origin    {lat,lng} route origin — driver home for an
 *                                  unstarted date, live/last position for a
 *                                  running one (null → the home leg is skipped)
 * @param {Array}    args.skeleton  ordered pickups [{ stopId, start, lat, lng }]
 * @param {object}   [args.options] overrides for TRANSFER_CORRIDOR
 * @returns {{kind:'lead'|'pickup'|'tail'|'none', startTime:string|null,
 *            pickupStopId:string|null, corridorIndex:number,
 *            costKm:number|null, detail:object|null}}
 */
export function resolveTransferStart({ point, origin, skeleton, options }) {
  const o = { ...TRANSFER_CORRIDOR, ...(options || {}) };
  const pickups = (skeleton || []).filter((p) => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)));
  const none = { kind: 'none', startTime: null, pickupStopId: null, corridorIndex: -1, costKm: null, detail: null };
  if (!pickups.length || !point || !Number.isFinite(Number(point.lat)) || !Number.isFinite(Number(point.lng))) return none;

  const legs = [];
  if (origin && Number.isFinite(Number(origin.lat)) && Number.isFinite(Number(origin.lng))) {
    legs.push({ index: 0, from: origin, to: pickups[0], pickup: pickups[0] });
  }
  for (let i = 1; i < pickups.length; i++) {
    legs.push({ index: i, from: pickups[i - 1], to: pickups[i], pickup: pickups[i] });
  }

  const scored = legs.map((leg) => {
    const c = corridorCandidate({ from: leg.from, to: leg.to, point, options: o });
    return c ? { ...leg, ...c } : null;
  }).filter(Boolean);

  const qualifies = scored.filter((s) => s.inCorridor).sort((a, b) => a.costKm - b.costKm);
  const lastStart = parseTimeToMinutes(pickups[pickups.length - 1].start);
  const tail = () => ({
    kind: 'tail',
    startTime: Number.isFinite(lastStart) && lastStart > 0 ? formatMinutesToTime(lastStart + o.pickupOffsetMinutes) : null,
    pickupStopId: pickups[pickups.length - 1].stopId || null,
    corridorIndex: -1,
    costKm: null,
    detail: null,
  });

  // The 09:00 lead only wins when the HOME leg is the CHEAPEST qualifying leg —
  // a stop sitting on or beside a later pickup always joins that pickup instead
  // (cost 0 there beats any detour out of home).
  const cheapest = qualifies[0] || null;
  const homeLeg = cheapest && cheapest.index === 0 ? cheapest : null;
  if (homeLeg) {
    const cap = Math.min(o.homeLeadMaxCostKm, Math.max(0.5, o.homeLeadMaxCostRatio * homeLeg.legKm));
    if (homeLeg.costKm <= cap) {
      return {
        kind: 'lead',
        startTime: o.leadTime,
        pickupStopId: homeLeg.pickup.stopId || null,
        corridorIndex: 0,
        costKm: homeLeg.costKm,
        detail: homeLeg,
      };
    }
  }

  const pickupLeg = qualifies.find((q) => q.index >= 1) || null;
  if (pickupLeg) {
    const base = parseTimeToMinutes(pickupLeg.pickup.start);
    return {
      kind: 'pickup',
      startTime: Number.isFinite(base) && base > 0 ? formatMinutesToTime(base + o.pickupOffsetMinutes) : null,
      pickupStopId: pickupLeg.pickup.stopId || null,
      corridorIndex: pickupLeg.index,
      costKm: pickupLeg.costKm,
      detail: pickupLeg,
    };
  }

  return tail();
}
