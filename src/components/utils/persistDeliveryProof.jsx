import { base44 } from "@/api/base44Client";
import { offlineDB } from "./offlineDatabase";

export async function persistDeliveryProof(deliveryId, updates) {
  const backendDelivery = await base44.entities.Delivery.update(deliveryId, updates);
  const existingDelivery = await offlineDB.getById(offlineDB.STORES.DELIVERIES, deliveryId);

  const mergedDelivery = {
    ...existingDelivery,
    ...backendDelivery,
    id: deliveryId,
    updated_date: backendDelivery?.updated_date || new Date().toISOString()
  };

  await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [mergedDelivery]);

  window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
    detail: { deliveryId, triggeredBy: 'proofOfDeliverySave' }
  }));
  window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));

  return mergedDelivery;
}