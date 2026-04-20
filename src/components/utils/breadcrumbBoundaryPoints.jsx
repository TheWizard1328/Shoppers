import { offlineDB } from '@/components/utils/offlineDatabase';
import { base44 } from '@/api/base44Client';
import { buildPendingBreadcrumbKey } from '@/components/utils/pendingBreadcrumbsManager';

const FINISHED_STATUSES = new Set(['completed', 'failed', 'cancelled', 'returned']);

const parseTimestamp = (value) => {
  if (!value) return Date.now();
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : Date.now();
};

const getStopCoords = async ({ delivery, patients, stores }) => {
  if (delivery?.patient_id) {
    const patient = (patients || []).find((p) => p?.id === delivery.patient_id);
    if (Number.isFinite(Number(patient?.latitude)) && Number.isFinite(Number(patient?.longitude))) {
      return [Number(patient.latitude), Number(patient.longitude)];
    }
  }

  const store = (stores || []).find((s) => s?.id === delivery?.store_id);
  if (Number.isFinite(Number(store?.latitude)) && Number.isFinite(Number(store?.longitude))) {
    return [Number(store.latitude), Number(store.longitude)];
  }

  return null;
};

export async function appendBoundaryBreadcrumbPoints({
  driverId,
  delivery,
  allDeliveries,
  patients,
  stores,
  appUsers,
  terminalStatus,
  completedAt
}) {
  if (!driverId || !delivery?.id || !delivery?.delivery_date) return;
  if (!FINISHED_STATUSES.has(terminalStatus)) return;

  const currentStopCoords = await getStopCoords({ delivery, patients, stores });
  if (!currentStopCoords) return;

  const boundaryTimestamp = parseTimestamp(completedAt);
  const boundaryPoint = [currentStopCoords[0], currentStopCoords[1], boundaryTimestamp];

  const currentStopOrder = Number(delivery?.stop_order || 0);
  const sameRouteDeliveries = (allDeliveries || [])
    .filter((item) => item?.driver_id === driverId && item?.delivery_date === delivery.delivery_date);

  const nextDelivery = sameRouteDeliveries
    .filter((item) => item && item.id !== delivery.id && !FINISHED_STATUSES.has(item.status) && item.status !== 'pending' && Number(item?.stop_order || 0) > currentStopOrder)
    .sort((a, b) => Number(a?.stop_order || 0) - Number(b?.stop_order || 0))[0];

  const currentRecordId = buildPendingBreadcrumbKey({
    appUserId: appUsers?.find((user) => user?.user_id === driverId)?.id,
    driverUserId: driverId,
    stopOrder: currentStopOrder
  });

  const currentRecord = await offlineDB.getById(offlineDB.STORES.PENDING_BREADCRUMBS, currentRecordId);
  if (currentRecord?.breadcrumbs?.length) {
    const updatedCurrentRecord = {
      ...currentRecord,
      timestamp: boundaryTimestamp,
      breadcrumbs: [...currentRecord.breadcrumbs, boundaryPoint]
    };
    await offlineDB.save(offlineDB.STORES.PENDING_BREADCRUMBS, updatedCurrentRecord);

    try {
      const liveRecords = await base44.entities.PendingBreadcrumbLive.filter({ driver_id: driverId });
      const liveRecord = (liveRecords || []).find((record) => Number(record?.stop_order) === currentStopOrder);
      if (liveRecord?.id) {
        await base44.entities.PendingBreadcrumbLive.update(liveRecord.id, {
          breadcrumbs: updatedCurrentRecord.breadcrumbs
        });
      }
    } catch (_) {}
  }

  if (!nextDelivery?.id) return;

  const nextStopOrder = Number(nextDelivery?.stop_order || 0);
  const nextRecordId = buildPendingBreadcrumbKey({
    appUserId: appUsers?.find((user) => user?.user_id === driverId)?.id,
    driverUserId: driverId,
    stopOrder: nextStopOrder
  });

  const nextRecord = await offlineDB.getById(offlineDB.STORES.PENDING_BREADCRUMBS, nextRecordId);
  if (nextRecord?.breadcrumbs?.length) return;

  const nextRecordData = {
    id: nextRecordId,
    driver_id: driverId,
    owner_driver_id: appUsers?.find((user) => user?.user_id === driverId)?.id || null,
    driver_user_id: driverId,
    delivery_id: nextDelivery.id,
    delivery_date: nextDelivery.delivery_date,
    stop_order: nextStopOrder,
    stop_label: `Stop ${nextStopOrder || 0}`,
    timestamp: boundaryTimestamp,
    breadcrumbs: [boundaryPoint]
  };

  await offlineDB.save(offlineDB.STORES.PENDING_BREADCRUMBS, nextRecordData);

  try {
    const liveRecords = await base44.entities.PendingBreadcrumbLive.filter({ driver_id: driverId });
    const existingLiveRecord = (liveRecords || []).find((record) => Number(record?.stop_order) === nextStopOrder);
    if (existingLiveRecord?.id) {
      await base44.entities.PendingBreadcrumbLive.update(existingLiveRecord.id, {
        delivery_id: nextDelivery.id,
        breadcrumbs: nextRecordData.breadcrumbs
      });
    } else {
      await base44.entities.PendingBreadcrumbLive.create({
        driver_id: driverId,
        delivery_id: nextDelivery.id,
        stop_order: nextStopOrder,
        breadcrumbs: nextRecordData.breadcrumbs
      });
    }
  } catch (_) {}
}