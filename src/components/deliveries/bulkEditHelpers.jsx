import { smartRefreshManager } from "../utils/smartRefreshManager";
import { getDriverNameForStorage } from "../utils/driverUtils";
import { getPickupStopIdForDelivery } from "../utils/ampmUtils";
import { userHasRole } from "../utils/userRoles";
import { invalidate } from "../utils/dataManager";

export function buildBulkEditBaseUpdates({ values, currentUser, bulkEditableDrivers }) {
  const baseUpdates = {};

  if (values.delivery_date) baseUpdates.delivery_date = values.delivery_date;
  if (values.delivery_time_start) baseUpdates.delivery_time_start = values.delivery_time_start;
  if (values.delivery_time_end) {
    baseUpdates.delivery_time_end = values.delivery_time_end;
  } else if (values.delivery_time_end === "") {
    baseUpdates.delivery_time_end = null;
  }

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

  if (userHasRole(currentUser, "driver") && values.travelModeChoice) {
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

export async function finalizeBulkEdit({ setSelectedBulkDeliveryIds, setBulkEditMode }) {
  setSelectedBulkDeliveryIds([]);
  setBulkEditMode(false);

  Promise.resolve().then(async () => {
    smartRefreshManager.restart();
    invalidate("Delivery");
    window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
  });
}

export async function applyBulkEditStops({
  values,
  currentUser,
  deliveries,
  allDeliveries,
  bulkEditableDrivers,
  selectedBulkDeliveryIds,
  setSelectedBulkDeliveryIds,
  setBulkEditMode,
  setIsBulkUpdating
}) {
  const baseUpdates = buildBulkEditBaseUpdates({ values, currentUser, bulkEditableDrivers });

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
      return updateDeliveryLocal(deliveryId, nextUpdates, { isBatchOperation: true });
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

      return finalizeBulkEdit({
        setSelectedBulkDeliveryIds,
        setBulkEditMode
      });
    })
    .finally(() => {
      setIsBulkUpdating(false);
    });
}