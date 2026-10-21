// ─────────────────────────────────────────────────────────────────────────────
// Live Distance Tracker — RETIRED (owner directive, Oct 21 2026)
//
// travel_dist now changes ONLY when a leg polyline is (re)generated — the
// optimizer writeBatch (clientRouteEngine), the current-leg regenerator
// (route deviation) and the Start fast-path all stamp the leg's road distance
// into travel_dist atomically with encoded_polyline, for pending, in_transit
// AND finished stops. Whatever the status, the polyline is the single writer.
//
// Why this class used to be a problem: it sampled GPS every 20s and wrote
// travel_dist straight into the next delivery on the server (a user-scoped
// Delivery.update + WebSocket broadcast to every device each flush) while the
// driver moved. It raced the polyline writes — one field, two meanings
// (km-driven vs km-remaining) — which is why the mileage card could DROP while
// driving. It also burned API quota and main-thread time on primary phones.
//
// This shim remains ONLY to keep the existing call-site contract intact
// (locationTracker, DriverStatusToggle, duty toggles, handleStatusUpdate):
// isTracking state + the internal driver_status mirror. No intervals, no
// server reads, no writes, no events.
// ─────────────────────────────────────────────────────────────────────────────

class LiveDistanceTracker {
  constructor() {
    this.isTracking = false;
    this.currentUser = null;
  }

  /** Start "tracking" — now purely a state flag for the call sites above. */
  async start(user) {
    if (!user) return;
    if (this.isTracking) return;
    this.currentUser = user;
    this.isTracking = true;
    console.log('🚀 [LiveDistanceTracker] Distance tracking retired (Oct 21) — status mirror only, for', user.user_name || user.full_name || user.id);
  }

  stop() {
    this.isTracking = false;
    this.currentUser = null;
  }

  /**
   * Internal driver-status mirror. Segments are recorded exclusively by the
   * backend setDriverStatus — this only keeps local state coherent.
   */
  async updateDriverStatus(newStatus) {
    if (!this.currentUser) return;
    this.currentUser.driver_status = newStatus;
  }
}

export const liveDistanceTracker = new LiveDistanceTracker();
