import { base44 } from '@/api/base44Client';
import {
  clearLegacyPendingBreadcrumbsForDriver,
  clearPendingBreadcrumbsForDriver,
  getEdmontonDateString,
  listPendingBreadcrumbRecordsForDriver
} from './pendingBreadcrumbsManager';

function getFirstBreadcrumbTimestamp(record) {
  const firstPoint = Array.isArray(record?.breadcrumbs) ? record.breadcrumbs[0] : null;
  return Array.isArray(firstPoint) && firstPoint[2] ? Number(firstPoint[2]) : null;
}

function getRecordDate(record) {
  const ts = getFirstBreadcrumbTimestamp(record);
  return ts ? getEdmontonDateString(ts) : null;
}

export async function reconcilePendingBreadcrumbsOnDuty({ driverUserId, appUsers = [], currentDateStr = getEdmontonDateString() }) {
  if (!driverUserId) {
    return { synced: 0, skipped: 0, failed: 0, deletedLegacy: 0, cleared: 0, reconciliationDate: null };
  }

  const deletedLegacy = await clearLegacyPendingBreadcrumbsForDriver({
    driverUserId,
    appUsers,
    currentDateStr
  });

  const allRecords = await listPendingBreadcrumbRecordsForDriver({ driverUserId, appUsers });
  const stopRecords = allRecords.filter((record) => record?.owner_driver_id && Array.isArray(record?.breadcrumbs) && record.breadcrumbs.length > 0);

  if (stopRecords.length === 0) {
    return { synced: 0, skipped: 0, failed: 0, deletedLegacy, cleared: 0, reconciliationDate: null };
  }

  const datedRecords = stopRecords
    .map((record) => ({ record, breadcrumbDate: getRecordDate(record) }))
    .filter((item) => item.breadcrumbDate);

  if (datedRecords.length === 0) {
    const cleared = allRecords.length;
    await clearPendingBreadcrumbsForDriver({ driverUserId, appUsers });
    return { synced: 0, skipped: 0, failed: 0, deletedLegacy, cleared, reconciliationDate: null };
  }

  const reconciliationDate = datedRecords
    .map((item) => item.breadcrumbDate)
    .sort()[0];

  const recordsForDate = datedRecords.filter((item) => item.breadcrumbDate === reconciliationDate);

  const results = await Promise.all(recordsForDate.map(async ({ record, breadcrumbDate }) => {
    if (!record?.delivery_id || !Array.isArray(record?.breadcrumbs) || record.breadcrumbs.length === 0) {
      return 'skipped';
    }

    try {
      const response = await base44.functions.invoke('syncPendingBreadcrumbs', {
        deliveryId: record.delivery_id,
        breadcrumbPayload: JSON.stringify(record.breadcrumbs),
        sourcePendingKey: record.driver_id,
        stopOrder: record.stop_order,
        breadcrumbDate
      });
      const data = response?.data || response;
      return data?.status || 'skipped';
    } catch (error) {
      console.warn('⚠️ [PendingBreadcrumbReconciliation] Failed to sync record:', record?.driver_id, error?.message || error);
      return 'failed';
    }
  }));

  const synced = results.filter((status) => status === 'synced').length;
  const skipped = results.filter((status) => status === 'skipped').length;
  const failed = results.filter((status) => status === 'failed').length;
  const cleared = allRecords.length;

  await clearPendingBreadcrumbsForDriver({ driverUserId, appUsers });

  return {
    synced,
    skipped,
    failed,
    deletedLegacy,
    cleared,
    reconciliationDate
  };
}