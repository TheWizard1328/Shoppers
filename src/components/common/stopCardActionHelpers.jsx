import { base44 } from "@/api/base44Client";
import { invalidate } from "../utils/dataManager";

export function getCurrentLocalTimeString(date = new Date()) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export async function withPausedDriverLocationPoller(callback) {
  const { driverLocationPoller } = await import("../utils/driverLocationPoller");
  driverLocationPoller.pause();
  try {
    return await callback();
  } finally {
    driverLocationPoller.resume();
  }
}

export async function verifyDeliveryStillExists(deliveryId) {
  const deliveryExists = await base44.entities.Delivery.filter({ id: deliveryId });
  if (!deliveryExists || deliveryExists.length === 0) {
    throw new Error("This delivery has been deleted. Please refresh the page.");
  }
  return deliveryExists[0];
}

export function getNextTrackingNumberInGroup(trackingNumber, allDeliveries, driverId, deliveryDate) {
  const originalTR = parseInt(trackingNumber, 10);
  const groupStart = Math.floor(originalTR / 20) * 20;
  const groupEnd = groupStart + 19;
  const existingTRsInGroup = allDeliveries
    .filter((d) => d && d.driver_id === driverId && d.delivery_date === deliveryDate)
    .map((d) => parseInt(d.tracking_number, 10))
    .filter((tr) => !isNaN(tr) && tr >= groupStart && tr <= groupEnd);

  return existingTRsInGroup.length > 0 ? Math.max(...existingTRsInGroup) + 1 : groupStart;
}

export function buildRetryDelivery(delivery, nextTrackingNumber) {
  const retryDelivery = {
    ...delivery,
    status: "in_transit",
    tracking_number: String(nextTrackingNumber),
    delivery_notes: "[Redelivered]",
    actual_delivery_time: null,
    isNextDelivery: false,
    signature_image_url: null,
    proof_photo_urls: [],
    cod_payments: []
  };

  delete retryDelivery.id;
  delete retryDelivery.created_date;
  delete retryDelivery.updated_date;
  delete retryDelivery.created_by;

  return retryDelivery;
}

export async function clearNextDeliveryFlags({ driverDeliveries, currentDeliveryId, updateDeliveryLocal }) {
  const activeNextStops = driverDeliveries.filter((d) => d.isNextDelivery && d.id !== currentDeliveryId);
  await Promise.all(
    activeNextStops.map((d) => updateDeliveryLocal(d.id, { isNextDelivery: false }, { skipSmartRefresh: true }))
  );
}

export async function refreshDriverRoute({ driverId, deliveryDate, forceRefreshDriverDeliveries, triggeredBy }) {
  invalidate("Delivery");
  await forceRefreshDriverDeliveries(driverId, deliveryDate);
  if (triggeredBy) {
    window.dispatchEvent(new CustomEvent("deliveriesUpdated", {
      detail: { triggeredBy, driverId, deliveryDate }
    }));
  }
}