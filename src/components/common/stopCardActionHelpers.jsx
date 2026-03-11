import { base44 } from "@/api/base44Client";
import { invalidate } from "../utils/dataManager";
import { getHereEncodedPolyline } from "../utils/hereRouting";

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

export function getStopCoordinates(delivery, patient, store) {
  if (!delivery) return null;
  const latitude = Number(delivery.patient_id ? patient?.latitude : store?.latitude);
  const longitude = Number(delivery.patient_id ? patient?.longitude : store?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

export function getFinishedLegOrigin({ delivery, allDeliveries, driver, patients = [], stores = [], finishedStatuses = [] }) {
  const previousStop = (allDeliveries || [])
    .filter((item) =>
      item &&
      item.id !== delivery.id &&
      item.driver_id === delivery.driver_id &&
      item.delivery_date === delivery.delivery_date &&
      finishedStatuses.includes(item.status) &&
      Number(item.stop_order) < Number(delivery.stop_order)
    )
    .sort((a, b) => Number(b.stop_order || 0) - Number(a.stop_order || 0))[0];

  if (previousStop) {
    const previousPatient = previousStop.patient_id
      ? (patients || []).find((item) => item && (item.id === previousStop.patient_id || item.patient_id === previousStop.patient_id))
      : null;
    const previousStore = (stores || []).find((item) => item && item.id === previousStop.store_id) || null;
    return getStopCoordinates(previousStop, previousPatient, previousStore);
  }

  const homeLatitude = Number(driver?.home_latitude);
  const homeLongitude = Number(driver?.home_longitude);
  if (!Number.isFinite(homeLatitude) || !Number.isFinite(homeLongitude)) return null;
  return { latitude: homeLatitude, longitude: homeLongitude };
}

export async function getFinishedLegEncodedPolyline({
  delivery,
  allDeliveries,
  driver,
  patient,
  store,
  patients = [],
  stores = [],
  finishedStatuses = []
}) {
  const origin = getFinishedLegOrigin({ delivery, allDeliveries, driver, patients, stores, finishedStatuses });
  const destination = getStopCoordinates(delivery, patient, store);
  if (!origin || !destination) return null;
  return await getHereEncodedPolyline(delivery.driver_id, origin, destination, delivery.delivery_date);
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
    cod_payments: [],
    finished_leg_encoded_polyline: null
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