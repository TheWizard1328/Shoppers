import { offlineDB } from "./offlineDatabase";

function getDriverAppUser(driverUserId, appUsers = []) {
  return (appUsers || []).find((user) => user?.user_id === driverUserId) || null;
}

export async function getPendingBreadcrumbsForDriver({ driverUserId, appUsers = [] }) {
  if (!driverUserId) return null;

  const driverAppUser = getDriverAppUser(driverUserId, appUsers);
  if (!driverAppUser?.id) return null;

  const record = await offlineDB.getById(offlineDB.STORES.PENDING_BREADCRUMBS, driverAppUser.id);
  if (!Array.isArray(record?.breadcrumbs) || record.breadcrumbs.length === 0) return null;

  return JSON.stringify(record.breadcrumbs);
}

export async function clearPendingBreadcrumbsForDriver({ driverUserId, appUsers = [] }) {
  if (!driverUserId) return;

  const driverAppUser = getDriverAppUser(driverUserId, appUsers);
  if (!driverAppUser?.id) return;

  await offlineDB.deleteRecord(offlineDB.STORES.PENDING_BREADCRUMBS, driverAppUser.id);
}