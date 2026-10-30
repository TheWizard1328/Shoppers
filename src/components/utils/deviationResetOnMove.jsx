/**
 * Deviation waypoint hygiene (owner rule Oct 30 2026).
 *
 * `deviation_waypoints` are the GPS points recorded while the driver was
 * actually driving to ONE specific stop, on ONE specific date, for ONE
 * specific driver. They are NOT transferable state:
 *
 *   Owner report — Sharuk's stop 1 today carried a deviation point recorded
 *   yesterday (the stop was moved from yesterday to today). Every regenerate
 *   then painted the current leg through that stale point (a spur to the old
 *   location), and Quick Route Adjustments drew "deleted stop -> first stop".
 *
 * Rule: whenever a delivery's delivery_date or driver_id CHANGES, its deviation
 * waypoints are dropped. The leg will be re-recorded from scratch if the driver
 * deviates again on the new date/driver.
 *
 * Pure functions only — no imports, safe for every write path.
 */

const dayOf = (value) => String(value || '').slice(0, 10);

/**
 * True when this update moves the stop to a different date or driver.
 * A driver_id of null/'' means "unassigned", which still counts as a change.
 */
export const isStopMoved = (existing, updates) => {
  if (!existing || !updates) return false;
  const nextDate = updates.delivery_date;
  if (nextDate && dayOf(nextDate) !== dayOf(existing.delivery_date)) return true;
  if (Object.prototype.hasOwnProperty.call(updates, 'driver_id')
    && String(updates.driver_id || '') !== String(existing.driver_id || '')) {
    return true;
  }
  return false;
};

/**
 * Returns the update payload with deviation waypoints cleared when the stop is
 * being moved to another date or driver. Any explicit deviation_waypoints in the
 * payload wins (a caller that knows better is never overridden).
 */
export const applyDeviationReset = (existing, updates) => {
  if (!updates) return updates;
  if (Object.prototype.hasOwnProperty.call(updates, 'deviation_waypoints')) return updates;
  if (!isStopMoved(existing, updates)) return updates;
  return { ...updates, deviation_waypoints: [] };
};

export default applyDeviationReset;
