import { offlineDB } from "./offlineDatabase";

const normalizePoint = (point) => {
  if (!Array.isArray(point) || point.length < 3) return null;

  const latitude = Number(point[0]);
  const longitude = Number(point[1]);
  const timestamp = Number(point[2]);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(timestamp)) {
    return null;
  }

  return [latitude, longitude, timestamp];
};

const normalizePoints = (points) => {
  if (!Array.isArray(points)) return [];
  return points.map(normalizePoint).filter(Boolean);
};

const toTimestamp = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
};

const parseStoredBreadcrumbs = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return normalizePoints(value);

  if (typeof value === "string") {
    const parsed = JSON.parse(value);
    return normalizePoints(parsed);
  }

  return [];
};

const pointKey = (point) => `${point[0]}|${point[1]}|${point[2]}`;

const mergeBreadcrumbs = (existingPoints, newPoints) => {
  const mergedMap = new Map();

  [...existingPoints, ...newPoints]
    .sort((a, b) => a[2] - b[2])
    .forEach((point) => {
      mergedMap.set(pointKey(point), point);
    });

  return Array.from(mergedMap.values()).sort((a, b) => a[2] - b[2]);
};

const removePoints = (sourcePoints, pointsToRemove) => {
  if (!pointsToRemove.length) return sourcePoints;

  const removalCounts = new Map();
  pointsToRemove.forEach((point) => {
    const key = pointKey(point);
    removalCounts.set(key, (removalCounts.get(key) || 0) + 1);
  });

  return sourcePoints.filter((point) => {
    const key = pointKey(point);
    const remaining = removalCounts.get(key) || 0;

    if (remaining < 1) return true;

    removalCounts.set(key, remaining - 1);
    return false;
  });
};

const resolveLegStart = (delivery, explicitStartTime) => {
  return toTimestamp(
    explicitStartTime ??
      delivery?.leg_start_time ??
      delivery?.started_at ??
      delivery?.start_time ??
      delivery?.en_route_at ??
      delivery?.arrival_time
  );
};

const resolveLegEnd = (delivery, explicitEndTime) => {
  return toTimestamp(
    explicitEndTime ??
      delivery?.actual_delivery_time ??
      delivery?.completed_at ??
      delivery?.failed_at ??
      delivery?.end_time ??
      delivery?.updated_date
  );
};

export async function extractAndSaveDeliveryLegBreadcrumbs({
  delivery,
  startTime,
  endTime,
  pendingDriverId = delivery?.driver_id,
}) {
  if (!delivery?.id) {
    throw new Error("Delivery id is required to save breadcrumbs.");
  }

  if (!pendingDriverId) {
    throw new Error("A pending breadcrumb driver id is required.");
  }

  const legStart = resolveLegStart(delivery, startTime);
  const legEnd = resolveLegEnd(delivery, endTime);

  if (!legStart || !legEnd) {
    throw new Error("A valid breadcrumb time window is required.");
  }

  if (legEnd < legStart) {
    throw new Error("Breadcrumb end time must be after start time.");
  }

  const pendingRecord = await offlineDB.getById(
    offlineDB.STORES.PENDING_BREADCRUMBS,
    pendingDriverId
  );

  const pendingPoints = normalizePoints(pendingRecord?.breadcrumbs);
  const matchingPoints = pendingPoints.filter((point) => point[2] >= legStart && point[2] <= legEnd);

  if (!matchingPoints.length) {
    return {
      success: true,
      delivery,
      appendedCount: 0,
      remainingPendingCount: pendingPoints.length,
      breadcrumbs: [],
    };
  }

  const storedDelivery = await offlineDB.getById(offlineDB.STORES.DELIVERIES, delivery.id);
  const baseDelivery = storedDelivery || delivery;
  const existingPoints = parseStoredBreadcrumbs(baseDelivery?.delivery_route_breadcrumbs);
  const mergedPoints = mergeBreadcrumbs(existingPoints, matchingPoints);

  const updatedDelivery = {
    ...baseDelivery,
    delivery_route_breadcrumbs: JSON.stringify(mergedPoints),
  };

  await offlineDB.save(offlineDB.STORES.DELIVERIES, updatedDelivery);

  const remainingPoints = removePoints(pendingPoints, matchingPoints);

  if (remainingPoints.length) {
    await offlineDB.save(offlineDB.STORES.PENDING_BREADCRUMBS, {
      ...pendingRecord,
      driver_id: pendingDriverId,
      timestamp: remainingPoints[remainingPoints.length - 1][2],
      breadcrumbs: remainingPoints,
    });
  } else {
    await offlineDB.deleteRecord(offlineDB.STORES.PENDING_BREADCRUMBS, pendingDriverId);
  }

  return {
    success: true,
    delivery: updatedDelivery,
    appendedCount: matchingPoints.length,
    remainingPendingCount: remainingPoints.length,
    breadcrumbs: matchingPoints,
    startTime: legStart,
    endTime: legEnd,
  };
}