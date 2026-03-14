import { base44 } from "@/api/base44Client";
import { deleteDeliveryLocal } from "../utils/entityMutations";
import { invalidate } from "../utils/dataManager";

export async function deleteDeliveryWithPolylineRefresh({ deliveryId, deliveries, setAllDeliveries }) {
  const deletedDelivery = (deliveries || []).find((delivery) => delivery?.id === deliveryId) || null;

  setAllDeliveries((prev) => prev.filter((delivery) => delivery.id !== deliveryId));
  await deleteDeliveryLocal(deliveryId);

  if (deletedDelivery?.driver_id && deletedDelivery?.delivery_date) {
    await base44.functions.invoke("purgeAndRegeneratePolylines", {
      driverId: deletedDelivery.driver_id,
      deliveryDate: deletedDelivery.delivery_date,
    });
  }

  invalidate("Delivery");
}