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
    // Driver changed — clear the isNextDelivery flag
    baseUpdates.isNextDelivery = false;
  }

  // Date changed — clear the isNextDelivery flag
  if (values.delivery_date && values.delivery_date !== initialValues?.delivery_date) {
    baseUpdates.isNextDelivery = false;
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

export async function finalizeBulkEdit({ setSelectedBulkDeliveryIds, setBulkEditMode, affectedRoutes = [] }) {
  setSelectedBulkDeliveryIds([]);
  setBulkEditMode(false);

  Promise.resolve().then(async () => {
    const uniqueRoutes = Array.from(
      new Map(
        (affectedRoutes || [])
          .filter((route) => route?.driver_id && route?.delivery_date)
          .map((route) => [`${route.driver_id}::${route.delivery_date}`, route])
      ).values()
    );

    await Promise.all(uniqueRoutes.map(async ({ driver_id, delivery_date }) => {
      await base44.functions.invoke('optimizeRemainingStops', {
        driverId: driver_id,
        deliveryDate: delivery_date
      }).catch(() => null);

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

  return Promise.all(
    selectedBulkDeliveryIds.map(async (deliveryId) => {
      const selectedDelivery = (deliveries || []).find((delivery) => delivery.id === deliveryId);
      const nextUpdates = buildDeliveryBulkUpdates({
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

      const affectedRoutes = freshDeliveries
        .filter((delivery) => selectedBulkDeliveryIds.includes(delivery.id))
        .map((delivery) => ({
          driver_id: delivery.driver_id,
          delivery_date: delivery.delivery_date
        }));

      return finalizeBulkEdit({
        setSelectedBulkDeliveryIds,
        setBulkEditMode,
        affectedRoutes
      });
    })
    .finally(() => {
      setIsBulkUpdating(false);
    });
}