import { base44 } from "@/api/base44Client";
import { deleteDeliveryLocal } from "../utils/entityMutations";
import { invalidate } from "../utils/dataManager";

export async function deleteDeliveryWithPolylineRefresh({ deliveryId, deliveries, setAllDeliveries }) {
  const deletedDelivery = (deliveries || []).find((delivery) => delivery?.id === deliveryId) || null;

  setAllDeliveries((prev) => prev.filter((delivery) => delivery.id !== deliveryId));
  await deleteDeliveryLocal(deliveryId);

  const shouldSkipPolylineRefresh = ['pending', 'Staged'].includes(String(deletedDelivery?.status || ''));

  if (!shouldSkipPolylineRefresh && deletedDelivery?.driver_id && deletedDelivery?.delivery_date) {
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
    // Purge stale polylines and regenerate with updated stop order
    base44.functions.invoke("purgeAndRegeneratePolylines", {
      driverId: deletedDelivery.driver_id,
      deliveryDate: deletedDelivery.delivery_date,
      scope: 'active_only',
    }).catch((error) => console.warn("[deleteDeliveryWithPolylineRefresh] Polyline regen failed:", error?.message || error));
  }

  invalidate("Delivery");
}