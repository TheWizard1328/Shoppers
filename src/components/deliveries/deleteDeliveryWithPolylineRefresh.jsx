import { base44 } from "@/api/base44Client";
import { deleteDeliveryLocal } from "../utils/entityMutations";
import { invalidate } from "../utils/dataManager";

export async function deleteDeliveryWithPolylineRefresh({ deliveryId, deliveries, setAllDeliveries }) {
  const deletedDelivery = (deliveries || []).find((delivery) => delivery?.id === deliveryId) || null;

  setAllDeliveries((prev) => prev.filter((delivery) => delivery.id !== deliveryId));
  await deleteDeliveryLocal(deliveryId);

  const shouldSkipPolylineRefresh = ['pending', 'Staged'].includes(String(deletedDelivery?.status || ''));

  if (!shouldSkipPolylineRefresh && deletedDelivery?.driver_id && deletedDelivery?.delivery_date) {
    // Check if any active stops remain for this driver/date after deletion.
    // Terminal statuses don't count as "active" for routing purposes.
    const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];
    const remainingActiveStops = (deliveries || []).filter(
      (d) => d && d.id !== deliveryId
        && d.driver_id === deletedDelivery.driver_id
        && d.delivery_date === deletedDelivery.delivery_date
        && !TERMINAL_STATUSES.includes(String(d.status || ''))
    );

    if (remainingActiveStops.length > 0) {
      try {
        // Deleting an active stop changes the route — run full optimization then regenerate polylines
        const { performRouteOptimization } = await import('@/components/utils/routeOptimizationCoordinator');
        await performRouteOptimization({
          driverId: deletedDelivery.driver_id,
          deliveryDate: deletedDelivery.delivery_date,
          bypassDriverStatus: true,
          source: 'delete_delivery',
        });
      } catch (error) {
        console.warn("[deleteDeliveryWithPolylineRefresh] Route optimization failed:", error?.message || error);
      }
    } else {
      console.log('[deleteDeliveryWithPolylineRefresh] No active stops remaining after delete — skipping optimization & polyline regen');
    }
  }

  invalidate("Delivery");
}