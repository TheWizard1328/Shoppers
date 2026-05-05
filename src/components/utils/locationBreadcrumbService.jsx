import { base44 } from '@/api/base44Client';
import { getLocalDateString } from './localTimeHelper';

export const collectBreadcrumbForTracker = async ({
  driverStatus,
  appUserId,
  currentUser,
  currentDeliveryDate,
  latitude,
  longitude,
  timestamp
}) => {
  if (driverStatus !== 'on_duty' || !appUserId || !currentUser?.id) {
    return null;
  }

  const { offlineDB } = await import('./offlineDatabase');
  const { buildPendingBreadcrumbKey } = await import('./pendingBreadcrumbsManager');

  const deliveryDate = currentDeliveryDate || getLocalDateString();
  const deliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, deliveryDate);
  const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
  const driverDeliveries = (deliveries || []).filter((delivery) => delivery?.driver_id === currentUser.id);
  const activeDelivery = driverDeliveries.find((delivery) => delivery?.isNextDelivery === true)
    || driverDeliveries
      .filter((delivery) => !finishedStatuses.includes(delivery?.status) && delivery?.status !== 'pending')
      .sort((a, b) => Number(a?.stop_order || 0) - Number(b?.stop_order || 0))[0];

  if (!activeDelivery?.id) {
    return null;
  }

  const stopOrder = Number(activeDelivery?.stop_order || activeDelivery?.display_stop_order || 0);
  const pendingKey = buildPendingBreadcrumbKey({
    appUserId,
    deliveryId: activeDelivery.id,
    stopOrder
  });

  const existingBreadcrumbs = await offlineDB.getById(offlineDB.STORES.PENDING_BREADCRUMBS, pendingKey);
  const breadcrumbPoint = [latitude, longitude, timestamp];

  let initialPoints = [];
  if (!existingBreadcrumbs?.breadcrumbs?.length) {
    const previousFinishedStop = driverDeliveries
      .filter((d) => finishedStatuses.includes(d?.status) && (d?.stop_order || 0) < stopOrder)
      .sort((a, b) => Number(b?.stop_order || 0) - Number(a?.stop_order || 0))[0];

    if (previousFinishedStop) {
      let prevLat = null;
      let prevLon = null;

      if (previousFinishedStop.patient_id) {
        const patients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
        const prevPatient = (patients || []).find((p) => p?.id === previousFinishedStop.patient_id);
        prevLat = prevPatient?.latitude;
        prevLon = prevPatient?.longitude;
      } else if (previousFinishedStop.store_id) {
        const stores = await offlineDB.getAll(offlineDB.STORES.STORES);
        const prevStore = (stores || []).find((s) => s?.id === previousFinishedStop.store_id);
        prevLat = prevStore?.latitude;
        prevLon = prevStore?.longitude;
      }

      if (prevLat && prevLon) {
        const originTimestamp = previousFinishedStop.actual_delivery_time
          ? new Date(previousFinishedStop.actual_delivery_time).getTime()
          : timestamp - 60000;
        initialPoints.push([prevLat, prevLon, originTimestamp]);
      }
    }
  }

  const breadcrumbData = {
    id: pendingKey,
    driver_id: currentUser.id,
    owner_driver_id: appUserId,
    driver_user_id: currentUser.id,
    delivery_id: activeDelivery.id,
    delivery_date: activeDelivery.delivery_date,
    delivery_start_time: activeDelivery.delivery_time_start,
    stop_order: stopOrder,
    stop_label: `Stop ${stopOrder || 0}`,
    timestamp,
    breadcrumbs: existingBreadcrumbs?.breadcrumbs?.length
      ? [...existingBreadcrumbs.breadcrumbs, breadcrumbPoint]
      : [...initialPoints, breadcrumbPoint]
  };

  await offlineDB.save(offlineDB.STORES.PENDING_BREADCRUMBS, breadcrumbData);

  try {
    const liveRecords = await base44.entities.PendingBreadcrumbLive.filter({ driver_id: currentUser.id });
    const liveRecord = (liveRecords || []).find((record) => Number(record?.stop_order) === Number(stopOrder));
    if (liveRecord?.id) {
      await base44.entities.PendingBreadcrumbLive.update(liveRecord.id, {
        delivery_id: activeDelivery.id,
        delivery_date: activeDelivery.delivery_date,
        delivery_start_time: activeDelivery.delivery_time_start,
        stop_order: stopOrder,
        breadcrumbs: breadcrumbData.breadcrumbs
      });
    } else {
      await base44.entities.PendingBreadcrumbLive.create({
        driver_id: currentUser.id,
        delivery_id: activeDelivery.id,
        delivery_date: activeDelivery.delivery_date,
        delivery_start_time: activeDelivery.delivery_time_start,
        stop_order: stopOrder,
        breadcrumbs: breadcrumbData.breadcrumbs
      });
    }
  } catch (error) {
    const isRateLimited = error?.response?.status === 429 || error?.status === 429 || error?.message?.includes('429') || error?.message?.toLowerCase?.().includes('rate limit');
    if (!isRateLimited) {
      console.warn(`⚠️ [LocationTracker] Live breadcrumb write skipped:`, error.message);
    } else {
      console.warn(`⚠️ [LocationTracker] Live breadcrumb rate-limited, skipping this point`);
    }
  }

  window.dispatchEvent(new CustomEvent('breadcrumbCollected', {
    detail: {
      driverId: currentUser?.id,
      appUserId,
      deliveryId: activeDelivery.id,
      deliveryDate: activeDelivery.delivery_date,
      stopOrder,
      point: { lat: latitude, lng: longitude, timestamp }
    }
  }));

  return { pendingKey, activeDelivery, stopOrder };
};