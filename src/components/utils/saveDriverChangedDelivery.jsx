export async function saveDriverChangedDelivery({
  base44,
  deliveries,
  editingDelivery,
  deliveryData,
  deliveryDate,
  driverId,
  driver,
  originalDriverId
}) {
  await base44.entities.Delivery.update(editingDelivery.id, deliveryData);

  const finishedStatuses = new Set(['completed', 'failed', 'cancelled', 'returned']);
  const pickupLinkId = editingDelivery.puid || editingDelivery.stop_id || deliveryData.puid || deliveryData.stop_id;
  const isIncompletePickup = !editingDelivery.patient_id && !finishedStatuses.has(editingDelivery.status);

  if (!isIncompletePickup || !pickupLinkId) return;

  const pendingDeliveriesForPickup = (deliveries || []).filter((delivery) =>
    delivery &&
    delivery.driver_id === originalDriverId &&
    delivery.puid === pickupLinkId &&
    delivery.status === 'pending' &&
    delivery.patient_id
  );

  await Promise.all(
    pendingDeliveriesForPickup.map((pendingDelivery) =>
      base44.entities.Delivery.update(pendingDelivery.id, {
        driver_id: driverId,
        driver_name: driver.user_name || driver.full_name,
        delivery_date: deliveryDate
      })
    )
  );
}