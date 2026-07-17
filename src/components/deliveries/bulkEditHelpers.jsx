import { base44 } from "@/api/base44Client";
import { smartRefreshManager } from "../utils/smartRefreshManager";
import { getDriverNameForStorage } from "../utils/driverUtils";
import { getPickupStopIdForDelivery } from "../utils/ampmUtils";
import { userHasRole } from "../utils/userRoles";
import { invalidate } from "../utils/dataManager";

export function buildBulkEditBaseUpdates({ values, initialValues, currentUser, bulkEditableDrivers }) {
  const baseUpdates = {};

  // Only apply delivery_date if it was changed and is non-empty
  if (values.delivery_date && values.delivery_date !== initialValues?.delivery_date) {
    baseUpdates.delivery_date = values.delivery_date;
  }

  // Only apply time window start if it was changed
  if (values.delivery_time_start !== initialValues?.delivery_time_start) {
    baseUpdates.delivery_time_start = values.delivery_time_start || null;
  }

  // Only apply time window end if it was changed
  if (values.delivery_time_end !== initialValues?.delivery_time_end) {
    baseUpdates.delivery_time_end = values.delivery_time_end || null;
  }

  // Only apply driver if it was changed
  if (values.driverChoice !== initialValues?.driverChoice) {
    if (values.driverChoice === "unassigned") {
      baseUpdates.driver_id = null;
      baseUpdates.driver_name = "";
    } else if (values.driverChoice !== "unchanged") {
      const selectedDriver = bulkEditableDrivers.find((driver) => driver.id === values.driverChoice);
      if (selectedDriver) {
        baseUpdates.driver_id = selectedDriver.id;
        baseUpdates.driver_name = getDriverNameForStorage(selectedDriver);
      }
    }
    // Driver changed — reset routing flags and clear polyline
    baseUpdates.isNextDelivery = false;
    baseUpdates.PolylineUpdated = false;
    baseUpdates.encoded_polyline = null;
  }

  // Date changed — reset routing flags and clear polyline
  if (values.delivery_date && values.delivery_date !== initialValues?.delivery_date) {
    baseUpdates.isNextDelivery = false;
    baseUpdates.PolylineUpdated = false;
    baseUpdates.encoded_polyline = null;
  }

  // Only apply travel mode if it was changed and is not "mixed"
  if (
    userHasRole(currentUser, "driver") &&
    values.travelModeChoice &&
    values.travelModeChoice !== "mixed" &&
    values.travelModeChoice !== initialValues?.travelModeChoice
  ) {
    baseUpdates.transport_mode = values.travelModeChoice;
    baseUpdates.finished_leg_transport_mode = values.travelModeChoice;
  }

  return baseUpdates;
}

export function getSelectedStoreOption(storeChoice) {
  if (!storeChoice || storeChoice === "unchanged") return null;
  const [storeId, slot] = storeChoice.split("::");
  return { storeId, slot };
}

export function hasBulkEditChanges({ baseUpdates, values, currentUser, selectedStoreOption }) {
  const isAdmin = userHasRole(currentUser, "admin");
  return (
    Object.keys(baseUpdates).length > 0 ||
    values.statusChoice !== "unchanged" ||
    values.ampmChoice !== "unchanged" ||
    !!selectedStoreOption ||
    (isAdmin && !!values.puid)
  );
}

export function buildDeliveryBulkUpdates({
  values,
  currentUser,
  selectedDelivery,
  baseUpdates,
  selectedStoreOption,
  allDeliveries
}) {
  const isAdmin = userHasRole(currentUser, "admin");
  const nextUpdates = { ...baseUpdates };

  if (values.statusChoice !== "unchanged") {
    nextUpdates.status = values.statusChoice === "in_transit_or_en_route"
      ? (selectedDelivery?.patient_id ? "in_transit" : "en_route")
      : values.statusChoice;
  }

  if (selectedStoreOption) {
    const puidDate = nextUpdates.delivery_date || selectedDelivery?.delivery_date;
    const nextPuid = getPickupStopIdForDelivery(
      selectedStoreOption.storeId,
      puidDate,
      selectedStoreOption.slot,
      allDeliveries || []
    ) || "";

    nextUpdates.store_id = selectedStoreOption.storeId;
    nextUpdates.ampm_deliveries = selectedStoreOption.slot;
    nextUpdates.puid = isAdmin ? values.puid || nextPuid : nextPuid;
  } else {
    if (values.ampmChoice !== "unchanged") {
      nextUpdates.ampm_deliveries = values.ampmChoice;
    }
    if (isAdmin && !!values.puid) {
      nextUpdates.puid = values.puid;
    }
  }

  return nextUpdates;
}

const getTodayEdmonton = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// routeOptimizationMap: Map of "driverId::date" -> { driver_id, delivery_date, shouldOptimize }
export async function finalizeBulkEdit({ setSelectedBulkDeliveryIds, setBulkEditMode, affectedRoutes = [], routeOptimizationMap = null }) {
  setSelectedBulkDeliveryIds([]);
  setBulkEditMode(false);

  Promise.resolve().then(async () => {
    const todayStr = getTodayEdmonton();

    const uniqueRoutes = Array.from(
      new Map(
        (affectedRoutes || [])
          .filter((route) => route?.driver_id && route?.delivery_date)
          .map((route) => [`${route.driver_id}::${route.delivery_date}`, route])
      ).values()
    );

    await Promise.all(uniqueRoutes.map(async ({ driver_id, delivery_date }) => {
      const isFuture = String(delivery_date) > todayStr;
      const routeKey = `${driver_id}::${delivery_date}`;

      // Determine if this route should be optimized
      let shouldOptimize = false;
      if (routeOptimizationMap && routeOptimizationMap.has(routeKey)) {
        shouldOptimize = routeOptimizationMap.get(routeKey);
      }

      if (shouldOptimize) {
        const { performRouteOptimization } = await import('@/components/utils/routeOptimizationCoordinator');
        await performRouteOptimization({
          driverId: driver_id,
          deliveryDate: delivery_date,
          bypassDriverStatus: isFuture,
          source: 'bulk_edit',
        }).catch(() => null);
      }

      await base44.functions.invoke('purgeAndRegeneratePolylines', {
        driverId: driver_id,
        deliveryDate: delivery_date,
        scope: 'active_only',
        reason: 'route_reordered'
      }).catch(() => null);
    }));

    smartRefreshManager.restart();
    invalidate("Delivery");
    window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
  });
}

export async function applyBulkEditStops({
  values,
  initialValues,
  currentUser,
  deliveries,
  allDeliveries,
  bulkEditableDrivers,
  selectedBulkDeliveryIds,
  setSelectedBulkDeliveryIds,
  setBulkEditMode,
  setIsBulkUpdating
}) {
  const baseUpdates = buildBulkEditBaseUpdates({ values, initialValues, currentUser, bulkEditableDrivers });

  if (!selectedBulkDeliveryIds.length) {
    return Promise.resolve();
  }

  const selectedStoreOption = getSelectedStoreOption(values.storeChoice);
  const hasMeaningfulChanges = hasBulkEditChanges({
    baseUpdates,
    values,
    currentUser,
    selectedStoreOption
  });

  if (!hasMeaningfulChanges) {
    return Promise.resolve();
  }

  setIsBulkUpdating(true);

  // Collect IDs of pending deliveries attached to any selected pickups that have date/driver changes
  // A pickup is identified by having no patient_id (or empty patient_id)
  const dateChanged = values.delivery_date && values.delivery_date !== initialValues?.delivery_date;
  const driverChanged = values.driverChoice !== "unchanged" && values.driverChoice !== initialValues?.driverChoice;
  const pickupRelatedChange = dateChanged || driverChanged;

  const linkedPendingDeliveryIds = new Set();
  if (pickupRelatedChange) {
    for (const deliveryId of selectedBulkDeliveryIds) {
      const delivery = (deliveries || []).find((d) => d.id === deliveryId);
      // Is this a pickup stop?
      if (!delivery || delivery.patient_id) continue;
      const pickupStopId = delivery.stop_id;
      if (!pickupStopId) continue;
      // Find pending deliveries attached to this pickup via puid
      (allDeliveries || []).forEach((d) => {
        if (
          d &&
          d.puid === pickupStopId &&
          d.status === 'pending' &&
          !selectedBulkDeliveryIds.includes(d.id)
        ) {
          linkedPendingDeliveryIds.add(d.id);
        }
      });
    }
  }

  const allIdsToUpdate = [...selectedBulkDeliveryIds, ...linkedPendingDeliveryIds];

  return Promise.all(
    allIdsToUpdate.map(async (deliveryId) => {
      const selectedDelivery = (deliveries || allDeliveries || []).find((delivery) => delivery.id === deliveryId);
      // For linked pending deliveries, only apply date/driver changes (not status/store/puid overrides)
      const isLinked = linkedPendingDeliveryIds.has(deliveryId);
      const nextUpdates = isLinked
        ? { ...baseUpdates }
        : buildDeliveryBulkUpdates({
            values,
            currentUser,
            selectedDelivery,
            baseUpdates,
            selectedStoreOption,
            allDeliveries
          });

      const { updateDeliveryLocal } = await import("../utils/entityMutations");
      return updateDeliveryLocal(deliveryId, nextUpdates, {
        isBatchOperation: true,
        deferPolylineRefresh: true
      });
    })
  )
    .then(() => {
      const freshDeliveries = (deliveries || []).map((delivery) => {
        if (linkedPendingDeliveryIds.has(delivery.id)) {
          return { ...delivery, ...baseUpdates };
        }
        if (!selectedBulkDeliveryIds.includes(delivery.id)) return delivery;
        return {
          ...delivery,
          ...buildDeliveryBulkUpdates({
            values,
            currentUser,
            selectedDelivery: delivery,
            baseUpdates,
            selectedStoreOption,
            allDeliveries
          })
        };
      });

      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: {
          immediate: true,
          preserveLocalState: true,
          freshDeliveries,
          triggeredBy: 'bulkEditImmediate'
        }
      }));

      // Include original routes of linked pending deliveries so their old routes get reoptimized too
      const linkedOriginalRoutes = [...linkedPendingDeliveryIds].map((id) => {
        const orig = (allDeliveries || []).find((d) => d.id === id);
        return orig ? { driver_id: orig.driver_id, delivery_date: orig.delivery_date } : null;
      }).filter(Boolean);

      const affectedRoutes = [
        ...freshDeliveries
          .filter((delivery) => allIdsToUpdate.includes(delivery.id))
          .map((delivery) => ({ driver_id: delivery.driver_id, delivery_date: delivery.delivery_date })),
        ...linkedOriginalRoutes
      ];

      // Build route optimization map
      // Rules:
      // - status/time window changed: always optimize affected routes
      // - date changed: optimize original date's route if it still has active stops;
      //                 optimize new date's route if it has at least 1 stop before the moved stop
      // - driver changed: same rules applied per-driver
      const statusChanged = values.statusChoice !== "unchanged" && values.statusChoice !== initialValues?.statusChoice;
      const timeStartChanged = values.delivery_time_start !== initialValues?.delivery_time_start;
      const timeEndChanged = values.delivery_time_end !== initialValues?.delivery_time_end;
      const dateChanged = values.delivery_date && values.delivery_date !== initialValues?.delivery_date;
      const driverChanged = values.driverChoice !== "unchanged" && values.driverChoice !== initialValues?.driverChoice;

      const routeOptimizationMap = new Map();

      const setOptimize = (driverId, date, value) => {
        if (!driverId || !date) return;
        const key = `${driverId}::${date}`;
        // Once true, don't downgrade to false
        if (!routeOptimizationMap.get(key)) routeOptimizationMap.set(key, value);
      };

      const activeStatuses = new Set(['pending', 'in_transit', 'en_route']);

      if (statusChanged || timeStartChanged || timeEndChanged) {
        // Optimize all affected routes
        for (const route of affectedRoutes) {
          setOptimize(route.driver_id, route.delivery_date, true);
        }
      }

      if (dateChanged || driverChanged) {
        for (const deliveryId of allIdsToUpdate) {
          const original = (allDeliveries || []).find((d) => d.id === deliveryId);
          const updated = freshDeliveries.find((d) => d.id === deliveryId);
          if (!original || !updated) continue;

          const origDriverId = original.driver_id;
          const origDate = original.delivery_date;
          const newDriverId = updated.driver_id;
          const newDate = updated.delivery_date;

          // Original route: optimize if it still has active stops after the move
          const origRouteStillActive = (allDeliveries || []).some(
            (d) => d && d.id !== deliveryId &&
              d.driver_id === origDriverId &&
              d.delivery_date === origDate &&
              activeStatuses.has(d.status)
          );
          setOptimize(origDriverId, origDate, origRouteStillActive);

          // New route: optimize if there's at least 1 stop already on that route before this stop
          const movedStopOrder = original.stop_order ?? Infinity;
          const newRouteHasStopsBefore = (allDeliveries || []).some(
            (d) => d && d.id !== deliveryId &&
              d.driver_id === newDriverId &&
              d.delivery_date === newDate &&
              (d.stop_order ?? Infinity) < movedStopOrder
          );
          setOptimize(newDriverId, newDate, newRouteHasStopsBefore);
        }
      }

      // Ensure all affectedRoutes are in the map (default false = polylines only, no optimize)
      for (const route of affectedRoutes) {
        const key = `${route.driver_id}::${route.delivery_date}`;
        if (!routeOptimizationMap.has(key)) routeOptimizationMap.set(key, false);
      }

      return finalizeBulkEdit({
        setSelectedBulkDeliveryIds,
        setBulkEditMode,
        affectedRoutes,
        routeOptimizationMap,
      });
    })
    .finally(() => {
      setIsBulkUpdating(false);
    });
}