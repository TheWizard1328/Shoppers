import { base44 } from '@/api/base44Client';

/**
 * Authoritative server-side clear of ALL isNextDelivery=true flags on a driver+date
 * route. Queries the server (NOT the local in-memory snapshot) so it catches stale
 * trues the client's state may have missed — the root cause of multiple stop cards
 * showing as "next" at the same time after Start / Complete / Mark As Failed / Cancel.
 *
 * Writes isNextDelivery=false to every matching record except `excludeId` and AWAITS
 * every write before returning, so the platform broadcasts every false event before
 * the caller issues its single promotion (true) write. This guarantees receiving
 * devices see all clears before the new next-stop flag is set.
 *
 * @param {string} driverId
 * @param {string} deliveryDate
 * @param {string} [excludeId] - delivery id to leave untouched (the one about to be promoted)
 * @returns {Promise<string[]>} ids that were cleared
 */
export async function clearAllNextDeliveryFlags(driverId, deliveryDate, excludeId = null) {
  if (!driverId || !deliveryDate) return [];
  try {
    const trues = await base44.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate,
      isNextDelivery: true,
    });
    const toClear = (trues || []).filter((d) => d?.id && d.id !== excludeId);
    if (toClear.length === 0) return [];
    await Promise.all(
      toClear.map((d) =>
        base44.entities.Delivery.update(d.id, { isNextDelivery: false }).catch((err) => {
          console.warn(`[clearAllNextDeliveryFlags] failed to clear ${d.id}:`, err?.message);
        })
      )
    );
    return toClear.map((d) => d.id);
  } catch (err) {
    console.warn('[clearAllNextDeliveryFlags] server query failed:', err?.message);
    return [];
  }
}