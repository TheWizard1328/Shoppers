/**
 * Shared heading channel for the heads-up map test (owner request Nov 24 2026).
 *
 * The dashboard already knows the driver's approach heading (it computes the
 * turn preview every GPS tick), and the map lives several memoised layers down.
 * Rather than thread a new prop through DashboardView, the dashboard publishes
 * the heading here and DeliveryMap reads it in its own smoothing loop.
 *
 * `null` means "no turn preview right now" and the map eases back to north-up.
 */
let headingDeg = null;

export function setMapHeading(deg) {
  headingDeg = Number.isFinite(deg) ? deg : null;
}

export function getMapHeading() {
  return headingDeg;
}
