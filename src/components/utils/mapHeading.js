/**
 * Shared heading channel for the heads-up map view (owner request Nov 24 2026).
 *
 * The dashboard already knows the driver's approach heading (it computes the
 * turn preview every GPS tick), and the map lives several memoised layers down.
 * Rather than thread a new prop through DashboardView, the dashboard publishes
 * the heading here and DeliveryMap reads it in its own smoothing loop.
 *
 * OWNER REPORT (Nov 24 2026): the map kept turning as the driver moved through
 * the corner, which made the approach feel like it was sliding sideways. The
 * heading is now LATCHED to the turn: `key` identifies the corner being framed
 * (the turn vertex), and the map only rotates when that key changes. Between
 * the latch and the end of the preview the bearing is held, so the driver keeps
 * a steady heads-up view through the whole manoeuvre.
 *
 * `null` means "no turn preview right now" and the map eases back to north-up.
 */
let state = { heading: null, key: null };

export function setMapHeading(deg, key = null) {
  const heading = Number.isFinite(deg) ? deg : null;
  state = { heading, key: heading == null ? null : (key == null ? null : String(key)) };
}

export function getMapHeading() {
  return state;
}
