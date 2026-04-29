import { base44 } from '@/api/base44Client';
import { offlineDB } from "./offlineDatabase";

const hasPendingBreadcrumbLiveEntity = () => !!base44.entities?.PendingBreadcrumbLive;

function getDriverAppUser(driverUserId, appUsers = []) {
  return (appUsers || []).find((user) => user?.user_id === driverUserId) || null;
}

export function getEdmontonDateString(value = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Edmonton',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(value));
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

export function buildPendingBreadcrumbKey({ appUserId, driverUserId, stopOrder }) {
  return `${driverUserId || appUserId || 'unknown'}__stop_${String(stopOrder ?? 'x')}`;
}

function getFirstBreadcrumbTimestamp(record) {
  const firstPoint = Array.isArray(record?.breadcrumbs) ? record.breadcrumbs[0] : null;
  return Array.isArray(firstPoint) && firstPoint[2] ? Number(firstPoint[2]) : null;
}

function hasBreadcrumbForDate(record, targetDateStr) {
  if (!targetDateStr || !Array.isArray(record?.breadcrumbs)) return false;
  return record.breadcrumbs.some((point) => Array.isArray(point) && Number.isFinite(Number(point?.[2])) && getEdmontonDateString(Number(point[2])) === targetDateStr);
}

function isLegacyRecord(record, appUserId) {
  return !!record && !record?.owner_driver_id && record?.driver_id === appUserId;
}

export async function listPendingBreadcrumbRecordsForDriver({ driverUserId, appUsers = [] }) {
  if (!driverUserId) return [];

  const driverAppUser = getDriverAppUser(driverUserId, appUsers);
  if (!driverAppUser?.id) return [];

  const allRecords = await offlineDB.getAll(offlineDB.STORES.PENDING_BREADCRUMBS);

  return (allRecords || [])
    .filter((record) => {
      if (!Array.isArray(record?.breadcrumbs) || record.breadcrumbs.length === 0) return false;
      return record?.owner_driver_id === driverAppUser.id || isLegacyRecord(record, driverAppUser.id);
    })
    .sort((a, b) => {
      const stopA = Number(a?.stop_order || 0);
      const stopB = Number(b?.stop_order || 0);
      if (stopA !== stopB) return stopA - stopB;
      return (getFirstBreadcrumbTimestamp(a) || 0) - (getFirstBreadcrumbTimestamp(b) || 0);
    });
}

export async function getPendingBreadcrumbsForDriver({ driverUserId, appUsers = [], selectedDateStr = null }) {
  if (!driverUserId) return null;
  const records = await listPendingBreadcrumbRecordsForDriver({ driverUserId, appUsers });
  const scopedRecords = selectedDateStr ? records.filter((record) => hasBreadcrumbForDate(record, selectedDateStr)) : records;
  const latestRecord = scopedRecords[scopedRecords.length - 1];
  if (!latestRecord?.breadcrumbs?.length) return null;
  return JSON.stringify(latestRecord.breadcrumbs);
}

export async function getPendingBreadcrumbsForDelivery({ driverUserId, deliveryId, stopOrder, appUsers = [], selectedDateStr = null }) {
  const records = await listPendingBreadcrumbRecordsForDriver({ driverUserId, appUsers });
  const scopedRecords = selectedDateStr ? records.filter((record) => hasBreadcrumbForDate(record, selectedDateStr)) : records;
  const matchingRecord = scopedRecords.find((record) => Number(record?.stop_order) === Number(stopOrder))
    || scopedRecords.find((record) => record?.delivery_id === deliveryId);

  if (!matchingRecord?.breadcrumbs?.length) return null;
  return JSON.stringify(matchingRecord.breadcrumbs);
}

export async function clearPendingBreadcrumbsForDriver({ driverUserId, appUsers = [], force = false }) {
  if (!force) return;
  try {
    if (driverUserId) {
      if (!hasPendingBreadcrumbLiveEntity()) throw new Error('PendingBreadcrumbLive unavailable');
      const liveRecords = await base44.entities.PendingBreadcrumbLive.filter({ driver_id: driverUserId });
      await Promise.all((liveRecords || []).map((record) => base44.entities.PendingBreadcrumbLive.delete(record.id)));
    }
  } catch (_) {}
  const records = await listPendingBreadcrumbRecordsForDriver({ driverUserId, appUsers });
  await Promise.all(records.map((record) => offlineDB.deleteRecord(offlineDB.STORES.PENDING_BREADCRUMBS, record.id)));
}

export async function clearPendingBreadcrumbsForDelivery({ driverUserId, deliveryId, stopOrder, appUsers = [], force = false }) {
  if (!force || !driverUserId) return;
  try {
    if (!hasPendingBreadcrumbLiveEntity()) throw new Error('PendingBreadcrumbLive unavailable');
    const liveRecords = await base44.entities.PendingBreadcrumbLive.filter({ driver_id: driverUserId });
    const matchingLiveRecords = (liveRecords || []).filter((record) => Number(record?.stop_order) === Number(stopOrder));
    if (matchingLiveRecords.length) {
      await Promise.all(matchingLiveRecords.map((record) => base44.entities.PendingBreadcrumbLive.delete(record.id)));
    }
  } catch (_) {}

  const records = await listPendingBreadcrumbRecordsForDriver({ driverUserId, appUsers });
  const matchingRecords = (records || []).filter((record) => Number(record?.stop_order) === Number(stopOrder));
  await Promise.all(matchingRecords.map((record) => offlineDB.deleteRecord(offlineDB.STORES.PENDING_BREADCRUMBS, record.id)));
}

export async function clearLegacyPendingBreadcrumbsForDriver({ driverUserId, appUsers = [], currentDateStr }) {
  if (!driverUserId) return 0;

  const driverAppUser = getDriverAppUser(driverUserId, appUsers);
  if (!driverAppUser?.id) return 0;

  const allRecords = await offlineDB.getAll(offlineDB.STORES.PENDING_BREADCRUMBS);
  const legacyRecords = (allRecords || []).filter((record) => isLegacyRecord(record, driverAppUser.id));
  const staleLegacyRecords = legacyRecords.filter((record) => {
    const firstTimestamp = getFirstBreadcrumbTimestamp(record);
    if (!firstTimestamp || !currentDateStr) return true;
    return getEdmontonDateString(firstTimestamp) < currentDateStr;
  });

  await Promise.all(staleLegacyRecords.map((record) => offlineDB.deleteRecord(offlineDB.STORES.PENDING_BREADCRUMBS, record.driver_id)));
  return staleLegacyRecords.length;
}