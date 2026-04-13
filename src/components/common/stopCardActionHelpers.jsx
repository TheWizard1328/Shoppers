import { base44 } from "@/api/base44Client";
import { invalidate } from "../utils/dataManager";
import { encodeGooglePolyline, getHereEncodedPolyline } from "../utils/hereRouting";

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

function parseBreadcrumbPoints(deliveryRouteBreadcrumbs) {
  if (!deliveryRouteBreadcrumbs) return [];

  let parsed;
  try {
    parsed = typeof deliveryRouteBreadcrumbs === "string"
      ? JSON.parse(deliveryRouteBreadcrumbs)
      : deliveryRouteBreadcrumbs;
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((point) => {
      if (Array.isArray(point)) {
        return [Number(point[0]), Number(point[1])];
      }
      if (point && typeof point === "object") {
        return [Number(point.latitude ?? point.lat), Number(point.longitude ?? point.lng ?? point.lon)];
      }
      return null;
    })
    .filter((point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]));
}

function buildFinishedLegPoints(origin, breadcrumbPoints, destination) {
  const routePoints = [
    [Number(origin.latitude), Number(origin.longitude)],
    ...breadcrumbPoints,
    [Number(destination.latitude), Number(destination.longitude)]
  ];

  return routePoints.filter((point, index) => {
    if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return false;
    if (index === 0) return true;
    const previousPoint = routePoints[index - 1];
    return !previousPoint || previousPoint[0] !== point[0] || previousPoint[1] !== point[1];
  });
}

export async function getFinishedLegEncodedPolyline({
  delivery,
  allDeliveries,
  driver,
  patient,
  store,
  patients = [],
  stores = [],
  finishedStatuses = [],
  breadcrumbPayload = null
}) {
  const origin = getFinishedLegOrigin({ delivery, allDeliveries, driver, patients, stores, finishedStatuses });
  const destination = getStopCoordinates(delivery, patient, store);
  if (!origin || !destination) return null;

  const breadcrumbPoints = parseBreadcrumbPoints(breadcrumbPayload ?? delivery?.delivery_route_breadcrumbs);
  if (breadcrumbPoints.length > 0) {
    const finishedLegPoints = buildFinishedLegPoints(origin, breadcrumbPoints, destination);
    if (finishedLegPoints.length > 1) {
      return encodeGooglePolyline(finishedLegPoints);
    }
  }

  return await getHereEncodedPolyline(delivery.driver_id, origin, destination, delivery.delivery_date);
}

function parseTrackingNumberParts(trackingNumber) {
  const trackingString = String(trackingNumber || '');
  const match = trackingString.match(/^(.*?)(\d+)([^\d]*)$/);

  if (!match) {
    return {
      prefix: '',
      numericValue: 0,
      suffix: '',
      padLength: 0
    };
  }

  return {
    prefix: match[1] || '',
    numericValue: parseInt(match[2], 10) || 0,
    suffix: match[3] || '',
    padLength: match[2]?.length || 0
  };
}

export function incrementTrackingNumber(trackingNumber, increment = 1) {
  const { prefix, numericValue, suffix, padLength } = parseTrackingNumberParts(trackingNumber);
  const nextValue = numericValue + increment;
  const formattedValue = padLength > 0 ? String(nextValue).padStart(padLength, '0') : String(nextValue);
  return `${prefix}${formattedValue}${suffix}`;
}

export function getNextTrackingNumberInGroup(trackingNumber, allDeliveries, driverId, deliveryDate) {
  const { numericValue: originalTR } = parseTrackingNumberParts(trackingNumber);
  const groupStart = Math.floor(originalTR / 20) * 20;
  const groupEnd = groupStart + 19;
  const existingTRsInGroup = allDeliveries
    .filter((d) => d && d.driver_id === driverId && d.delivery_date === deliveryDate)
    .map((d) => parseTrackingNumberParts(d.tracking_number).numericValue)
    .filter((tr) => !isNaN(tr) && tr >= groupStart && tr <= groupEnd);

  return existingTRsInGroup.length > 0 ? Math.max(...existingTRsInGroup) + 1 : groupStart;
}

export function buildRetryDelivery(delivery, nextTrackingNumber, deliveryDate = delivery?.delivery_date) {
  const todayDate = new Date().toISOString().slice(0, 10);
  const effectiveDeliveryDate = delivery?.delivery_date && todayDate > delivery.delivery_date ? todayDate : deliveryDate;

  const retryDelivery = {
    ...delivery,
    delivery_date: effectiveDeliveryDate,
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

export async function clearNextDeliveryFlags({ driverDeliveries, currentDelivery, currentDeliveryId, updateDeliveryLocal }) {
  const activeNextStops = driverDeliveries.filter((d) =>
    d?.isNextDelivery &&
    d.id !== currentDeliveryId &&
    (!currentDelivery || (
      d.driver_id === currentDelivery.driver_id &&
      d.delivery_date === currentDelivery.delivery_date
    ))
  );
  await Promise.all(
    activeNextStops.map((d) => updateDeliveryLocal(d.id, { isNextDelivery: false }, { skipSmartRefresh: true }))
  );
}

export function getDriverRouteDeliveries(allDeliveries = [], delivery) {
  if (!delivery) return [];
  return (allDeliveries || []).filter((item) =>
    item &&
    item.driver_id === delivery.driver_id &&
    item.delivery_date === delivery.delivery_date
  );
}

export function getNextActiveDelivery(driverDeliveries = [], currentDeliveryId = null, finishedStatuses = []) {
  return (driverDeliveries || [])
    .filter((item) =>
      item &&
      item.id !== currentDeliveryId &&
      !finishedStatuses.includes(item.status) &&
      item.status !== 'pending'
    )
    .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0))[0] || null;
}

export function reorderActiveRouteLocally(driverDeliveries = [], nextDeliveryId = null) {
  const scopedDeliveries = (driverDeliveries || []).filter(Boolean);
  const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
  const finished = scopedDeliveries
    .filter((item) => finishedStatuses.includes(item.status))
    .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
  const pending = scopedDeliveries
    .filter((item) => item.status === 'pending')
    .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
  const active = scopedDeliveries
    .filter((item) => !finishedStatuses.includes(item.status) && item.status !== 'pending')
    .sort((a, b) => {
      if (nextDeliveryId) {
        if (a.id === nextDeliveryId) return -1;
        if (b.id === nextDeliveryId) return 1;
      }
      return (a.stop_order || 0) - (b.stop_order || 0);
    });

  return [...finished, ...active, ...pending].map((item, index) => ({
    ...item,
    stop_order: index + 1,
    isNextDelivery: !!nextDeliveryId && item.id === nextDeliveryId
  }));
}

export function collapseAllStopCards(detail = {}) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('collapseAllStopCards', { detail }));
}

export async function collapseExpandedStopCardsForDriver(driverId) {
  if (typeof window === 'undefined' || !driverId) return;
  collapseAllStopCards({ driverId });
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

export function centerDeliveryCard(deliveryId) {
  if (!deliveryId || typeof window === 'undefined') return;

  const scrollToCard = () => {
    const nextCardElement = document.getElementById(`stop-card-${deliveryId}`);
    if (nextCardElement) {
      nextCardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  };

  scrollToCard();
  requestAnimationFrame(scrollToCard);
  setTimeout(scrollToCard, 0);
}

export async function setAndCenterNextDelivery({
  driverDeliveries = [],
  targetDeliveryId = null,
  updateDeliveryLocal,
  updateDeliveriesLocally,
  driverId,
  deliveryDate,
  collapseCards = true,
  skipBackgroundSync = false
}) {
  const scopedDeliveries = (driverDeliveries || []).filter(Boolean);

  if (collapseCards) {
    await collapseExpandedStopCardsForDriver(driverId);
  }

  const changedDeliveries = await syncNextDeliveryFlagsLocally({
    driverDeliveries: scopedDeliveries,
    nextDeliveryId: targetDeliveryId,
    updateDeliveriesLocally
  });

  if (targetDeliveryId) {
    centerDeliveryCard(targetDeliveryId);
  }

  if (!skipBackgroundSync && driverId && deliveryDate) {
    Promise.resolve().then(() =>
      base44.functions.invoke('setNextDeliveryFlag', {
        driverId,
        deliveryDate,
        targetDeliveryId
      }).catch((error) => {
        console.warn('[stopCardActionHelpers] Background next-delivery sync failed:', error?.message || error);
      })
    );
  }

  return { targetDeliveryId, changedDeliveries };
}

export async function syncNextDeliveryFlagsLocally({ driverDeliveries = [], nextDeliveryId = null, updateDeliveriesLocally }) {
  const scopedDeliveries = (driverDeliveries || []).filter(Boolean);
  if (scopedDeliveries.length === 0) return [];

  const currentNextDelivery = scopedDeliveries.find((item) => item?.isNextDelivery);
  const transferredDistance = currentNextDelivery && currentNextDelivery.id !== nextDeliveryId
    ? Number(currentNextDelivery.travel_dist || 0)
    : 0;

  const updatedDeliveries = scopedDeliveries.map((item) => ({
    ...item,
    isNextDelivery: !!nextDeliveryId && item.id === nextDeliveryId,
    travel_dist: item.id === nextDeliveryId
      ? transferredDistance
      : (currentNextDelivery && item.id === currentNextDelivery.id && item.id !== nextDeliveryId ? 0 : item.travel_dist)
  }));
  const changedDeliveries = updatedDeliveries.filter((item, index) => {
    const original = scopedDeliveries[index] || {};
    return item.isNextDelivery !== original.isNextDelivery || Number(item.travel_dist || 0) !== Number(original.travel_dist || 0);
  });

  if (changedDeliveries.length === 0) return [];

  try {
    const { offlineDB } = await import('../utils/offlineDatabase');
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, changedDeliveries);
  } catch (error) {
    console.warn('[stopCardActionHelpers] Failed to sync next-delivery flags to offline DB:', error?.message || error);
  }

  if (updateDeliveriesLocally) {
    updateDeliveriesLocally(changedDeliveries, false);
  }

  return changedDeliveries;
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

export async function rehydrateLiveBreadcrumbsForRestart(delivery) {
  if (!delivery?.driver_id || !delivery?.id || !delivery?.delivery_route_breadcrumbs) return;

  let parsedBreadcrumbs = null;
  try {
    parsedBreadcrumbs = typeof delivery.delivery_route_breadcrumbs === 'string'
      ? JSON.parse(delivery.delivery_route_breadcrumbs)
      : delivery.delivery_route_breadcrumbs;
  } catch {
    return;
  }

  if (!Array.isArray(parsedBreadcrumbs) || parsedBreadcrumbs.length === 0) return;

  try {
    const existing = await base44.entities.PendingBreadcrumbLive.filter({
      driver_id: delivery.driver_id,
      delivery_id: delivery.id
    });

    if (existing && existing[0]?.id) {
      await base44.entities.PendingBreadcrumbLive.update(existing[0].id, {
        stop_order: Number(delivery.stop_order || 0),
        breadcrumbs: parsedBreadcrumbs
      });
    } else {
      await base44.entities.PendingBreadcrumbLive.create({
        driver_id: delivery.driver_id,
        delivery_id: delivery.id,
        stop_order: Number(delivery.stop_order || 0),
        breadcrumbs: parsedBreadcrumbs
      });
    }
  } catch (error) {
    console.warn('[stopCardActionHelpers] Could not rehydrate live breadcrumbs:', error?.message || error);
  }
}

const routeOptimizationInflight = new Map();

export async function optimizeRouteAndApplyNextDelivery({
  driverId,
  deliveryDate,
  currentLocalTime,
  updateDeliveryLocal,
  updateDeliveriesLocally,
  forceRefreshDriverDeliveries,
  generatePolyline = false
}) {
  const optimizationKey = `${driverId || 'unknown'}:${deliveryDate || 'unknown'}`;
  if (routeOptimizationInflight.has(optimizationKey)) {
    return routeOptimizationInflight.get(optimizationKey);
  }

  const optimizationPromise = (async () => {
    const optimizeResponse = await base44.functions.invoke('optimizeRouteRealTime', {
      driverId,
      deliveryDate,
      currentLocalTime,
      generatePolyline
    });
    const optimizeData = optimizeResponse?.data || optimizeResponse;
    const optimizedRoute = Array.isArray(optimizeData?.optimizedRoute) ? optimizeData.optimizedRoute : [];
    const nextOptimizedStopId = optimizedRoute[0]?.deliveryId || optimizeData?.nextDeliveryId || optimizedRoute[0]?.delivery_id || null;

    await refreshDriverRoute({ driverId, deliveryDate, forceRefreshDriverDeliveries, triggeredBy: 'optimizedNextDeliverySync' });

    const refreshedDriverDeliveries = await base44.entities.Delivery.filter({ driver_id: driverId, delivery_date: deliveryDate });
    await setAndCenterNextDelivery({
      driverDeliveries: refreshedDriverDeliveries,
      targetDeliveryId: nextOptimizedStopId,
      updateDeliveryLocal,
      updateDeliveriesLocally,
      driverId,
      deliveryDate
    });

    return {
      optimizeData,
      optimizedRoute,
      nextOptimizedStopId,
      refreshedDriverDeliveries
    };
  })();

  routeOptimizationInflight.set(optimizationKey, optimizationPromise);

  try {
    return await optimizationPromise;
  } finally {
    routeOptimizationInflight.delete(optimizationKey);
  }
}