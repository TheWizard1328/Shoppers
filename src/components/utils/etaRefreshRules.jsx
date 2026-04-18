export const ETA_REFRESH_INTERVAL_MS = 60 * 1000;
export const ETA_COMPLETION_DRIFT_THRESHOLD_MS = 5 * 60 * 1000; // refresh only when completion is more than ±5 minutes off

const etaRefreshState = new Map();
const routeDeviationState = new Map();

const buildKey = (driverId, deliveryDate) => `${driverId || 'unknown'}:${deliveryDate || 'unknown'}`;

const parseLocalDateTime = (value) => {
  if (!value || typeof value !== 'string') return null;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
};

const parseEtaForDate = (deliveryDate, etaValue) => {
  if (!deliveryDate || !etaValue) return null;
  const date = new Date(`${deliveryDate}T${etaValue}:00`);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const shouldRunRouteDeviationCheck = ({ driverId, deliveryDate, now = Date.now() }) => {
  const key = buildKey(driverId, deliveryDate);
  const lastRun = routeDeviationState.get(key) || 0;
  if (now - lastRun < ETA_REFRESH_INTERVAL_MS) return false;
  routeDeviationState.set(key, now);
  return true;
};

export const shouldRefreshEtasForLateNextStop = ({ driverId, deliveryDate, nextStopEta, now = new Date() }) => {
  const etaDate = parseEtaForDate(deliveryDate, nextStopEta);
  if (!etaDate) return false;

  const key = buildKey(driverId, deliveryDate);
  const lastRun = etaRefreshState.get(key) || 0;
  const nowMs = now instanceof Date ? now.getTime() : now;

  if (nowMs - lastRun < ETA_REFRESH_INTERVAL_MS) return false;
  if (nowMs <= etaDate.getTime()) return false;

  etaRefreshState.set(key, nowMs);
  return true;
};

export const shouldRefreshEtasForCompletionDrift = ({ driverId, deliveryDate, actualDeliveryTime, now = new Date() }) => {
  const actualDate = parseLocalDateTime(actualDeliveryTime);
  if (!actualDate) return false;

  const key = buildKey(driverId, deliveryDate);
  const lastRun = etaRefreshState.get(key) || 0;
  const nowMs = now instanceof Date ? now.getTime() : now;

  if (nowMs - lastRun < ETA_REFRESH_INTERVAL_MS) return false;
  if (Math.abs(nowMs - actualDate.getTime()) <= ETA_COMPLETION_DRIFT_THRESHOLD_MS) return false;

  etaRefreshState.set(key, nowMs);
  return true;
};

export const markEtaRefreshRun = ({ driverId, deliveryDate, now = Date.now() }) => {
  etaRefreshState.set(buildKey(driverId, deliveryDate), now);
};

export const shouldRefreshEtasForNextStopCheck = ({ driverId, deliveryDate, deliveries = [], now = new Date() }) => {
  const key = buildKey(driverId, deliveryDate);
  const lastRun = etaRefreshState.get(key) || 0;
  const nowMs = now instanceof Date ? now.getTime() : now;

  if (nowMs - lastRun < ETA_REFRESH_INTERVAL_MS) return false;

  const nextStop = (deliveries || [])
    .filter((delivery) => delivery && delivery.driver_id === driverId && !['completed', 'failed', 'cancelled', 'returned', 'pending'].includes(delivery.status))
    .sort((a, b) => Number(a.stop_order || 9999) - Number(b.stop_order || 9999))[0];

  if (!nextStop?.delivery_time_eta) return false;

  const etaDate = parseEtaForDate(deliveryDate, nextStop.delivery_time_eta);
  if (!etaDate) return false;
  if (nowMs <= etaDate.getTime()) return false;

  etaRefreshState.set(key, nowMs);
  return true;
};