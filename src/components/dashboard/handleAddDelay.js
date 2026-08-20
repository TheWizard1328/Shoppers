import { format } from 'date-fns';
import { base44 } from '@/api/base44Client';

/**
 * Add `delayMinutes` to a stop and every subsequent active stop on the same
 * driver/date route by bumping their `delivery_time_eta`. Extracted from
 * Dashboard.jsx to keep that file manageable.
 *
 * @param {{ deliveryId: string, delayMinutes: number, selectedDate: Date, currentUser: object, setIsEntityUpdating: (v:boolean)=>void, isLoadingDeliveriesRef?: any, refreshData: ()=>Promise<void>, invalidate: (name:string)=>void }} args
 */
export async function runAddDelay({
  deliveryId, delayMinutes, selectedDate, currentUser, setIsEntityUpdating, refreshData, invalidate,
  deliveriesWithStopOrder,
}) {
  try {
    setIsEntityUpdating(true);

    const delivery = deliveriesWithStopOrder.find((d) => d && d.id === deliveryId);
    if (!delivery) return;

    const deliveryDate = format(selectedDate, 'yyyy-MM-dd');
    const allDriverDeliveries = await base44.entities.Delivery.filter({
      driver_id: currentUser.id,
      delivery_date: deliveryDate,
    }, 'stop_order');

    const targetStopOrder = delivery.stop_order;
    const finishedStatuses = ['completed', 'failed', 'cancelled', 'pending'];

    for (const d of allDriverDeliveries) {
      if (!d || finishedStatuses.includes(d.status)) continue;
      if ((d.stop_order || 0) < targetStopOrder) continue;

      const currentETA = d.delivery_time_eta || d.delivery_time_start;
      if (currentETA) {
        const [hours, mins] = currentETA.split(':').map(Number);
        const totalMinutes = hours * 60 + mins + delayMinutes;
        const newETA = `${String(Math.floor(totalMinutes / 60) % 24).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
        await base44.entities.Delivery.update(d.id, { delivery_time_eta: newETA });
      }
    }

    invalidate('Delivery');
    await refreshData();
  } catch (error) {
    console.error('❌ [Add Delay] Error:', error);
    alert('Failed to add delay. Please try again.');
  } finally {
    setIsEntityUpdating(false);
  }
}