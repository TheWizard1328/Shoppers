import { base44 } from '@/api/base44Client';

/**
 * Invokes the server-side consolidateBreadcrumbSegment function which uses
 * proximity matching to slice the master breadcrumb trail (stop_order = -1)
 * into per-stop segments.
 *
 * The algorithm decodes the master trail into GPS points, then walks it
 * sequentially — for each stop (sorted by stop_order), it finds the closest
 * point in the trail by physical distance. Segments are the trail points
 * between consecutive closest-point matches.
 *
 * This approach is immune to timestamp rounding, stop re-sequencing, and
 * master trail edits. It does NOT use actual_delivery_time for slicing.
 *
 * All stop types are handled: patient deliveries, store pickups, ISD/ISP
 * (via InterStoreLocation phone lookup), and cycling markers (embedded coords).
 *
 * @param {Object} params
 * @param {string} params.driver_id - AppUser user_id of the driver
 * @param {string} params.delivery_date - YYYY-MM-DD delivery date
 * @param {string} [params.delivery_id] - The triggering delivery's ID (for logging)
 * @returns {Promise<Object>} Result with { success, segments, total_segments, master_point_count }
 */
export async function consolidateBreadcrumbSegment(payload) {
  return await base44.functions.invoke('consolidateBreadcrumbSegment', payload || {});
}

export default consolidateBreadcrumbSegment;
