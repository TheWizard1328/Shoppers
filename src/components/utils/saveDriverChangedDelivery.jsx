export async function saveDriverChangedDelivery({
  base44,
  deliveries,
  editingDelivery,
  deliveryData,
  deliveryDate,
  driverId,
  driver
}) {
  await base44.entities.Delivery.update(editingDelivery.id, deliveryData);

  const finishedStatuses = new Set(['completed', 'failed', 'cancelled', 'returned']);
  const pickupStopId = editingDelivery.stop_id || deliveryData.stop_id;
  const isIncompletePickup = !editingDelivery.patient_id && !finishedStatuses.has(editingDelivery.status);

  if (!isIncompletePickup || !pickupStopId) return;

  const pendingDeliveriesForPickup = (deliveries || []).filter((delivery) =>
    delivery &&
    delivery.delivery_date === deliveryDate &&
    delivery.puid === pickupStopId &&
    delivery.status === 'pending' &&
    delivery.patient_id
  );

  await Promise.all(
    pendingDeliveriesForPickup.map((pendingDelivery) =>
      base44.entities.Delivery.update(pendingDelivery.id, {
        driver_id: driverId,
        driver_name: driver.user_name || driver.full_name
      })
    )
  );
}