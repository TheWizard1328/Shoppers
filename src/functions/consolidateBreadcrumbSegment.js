import { base44 } from '@/api/base44Client';

/**
 * Invokes the server-side consolidateBreadcrumbSegment function which atomically
 * slices the master breadcrumb trail (stop_order = -1) into a per-stop segment.
 *
 * Unlike the old fire-and-forget queueConsolidateBreadcrumbs, this call is AWAITED
 * so the caller knows whether the segment was created successfully.
 *
 * @param {Object} params
 * @param {string} params.driver_id - AppUser user_id of the driver
 * @param {string} params.delivery_date - YYYY-MM-DD delivery date
 * @param {string} params.delivery_id - The completed delivery's ID
 * @param {number} params.stop_order - The stop_order of the completed delivery
 * @param {string} params.actual_delivery_time - ISO timestamp of completion
 * @param {string} [params.transport_mode] - Transport mode for the segment
 * @returns {Promise<Object>} Result with { success, segment, point_count, error? }
 */
export async function consolidateBreadcrumbSegment(payload) {
  return await base44.functions.invoke('consolidateBreadcrumbSegment', payload || {});
}

export default consolidateBreadcrumbSegment;
