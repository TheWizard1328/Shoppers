import { invalidate } from "../utils/dataManager";
import { smartRefreshManager } from "../utils/smartRefreshManager";
import { offlineDB } from "../utils/offlineDatabase";
import { updateDeliveryLocal, batchDeleteDeliveriesLocal, setBatchDeleteInProgress } from "../utils/entityMutations";
import { getDriverNameForStorage } from "../utils/driverUtils";
import { getPickupStopIdForDelivery } from "../utils/ampmUtils";

export async function runBulkDeleteStops({
  selectedBulkDeliveryIds,
  setIsBulkUpdating,
  setSelectedBulkDeliveryIds,
  setBulkEditMode,
  setAllDeliveries,
  reloadFromOfflineDB,
  onAfterDelete
}) {
  if (!selectedBulkDeliveryIds.length) return;

  const confirmed = window.confirm(`Delete ${selectedBulkDeliveryIds.length} selected stop${selectedBulkDeliveryIds.length === 1 ? "" : "s"}?`);
  if (!confirmed) return;

  setIsBulkUpdating(true);
  setBatchDeleteInProgress(true);

  try {
    await batchDeleteDeliveriesLocal(selectedBulkDeliveryIds);
    window.dispatchEvent(new CustomEvent('clearDeliveriesSearch'));
    const freshOfflineDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
    setAllDeliveries?.(freshOfflineDeliveries || []);
    await reloadFromOfflineDB?.();
    window.dispatchEvent(new CustomEvent('forceDataRefresh'));
    setSelectedBulkDeliveryIds([]);
    setBulkEditMode(false);
    window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
    onAfterDelete?.(freshOfflineDeliveries || []);
  } finally {
    setBatchDeleteInProgress(false);
    setIsBulkUpdating(false);
  }
}

export function runBulkEditStops({
  values,
  currentUser,
  deliveries,
  selectedBulkDeliveryIds,
  bulkEditableDrivers,
  allDeliveries,
  setIsBulkUpdating,
  setSelectedBulkDeliveryIds,
  setBulkEditMode,
  loadData,
  userHasRole
}) {
  const baseUpdates = {};
  const isAdmin = userHasRole(currentUser, "admin");

  if (values.delivery_date) baseUpdates.delivery_date = values.delivery_date;
  if (values.delivery_time_start) baseUpdates.delivery_time_start = values.delivery_time_start;
  if (values.delivery_time_end) baseUpdates.delivery_time_end = values.delivery_time_end;
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

  if (!selectedBulkDeliveryIds.length) {
    return Promise.resolve();
  }

  const selectedStoreOption = values.storeChoice && values.storeChoice !== "unchanged"
    ? (() => {
        const [storeId, slot] = values.storeChoice.split("::");
        return { storeId, slot };
      })()
    : null;

  const hasMeaningfulChanges =
    Object.keys(baseUpdates).length > 0 ||
    values.statusChoice !== "unchanged" ||
    !!selectedStoreOption ||
    (isAdmin && !!values.puid);

  if (!hasMeaningfulChanges) {
    return Promise.resolve();
  }

  setIsBulkUpdating(true);

  return Promise.all(
    selectedBulkDeliveryIds.map((deliveryId) => {
      const selectedDelivery = (deliveries || []).find((delivery) => delivery.id === deliveryId);
      const nextUpdates = { ...baseUpdates };

      if (values.statusChoice !== "unchanged") {
        nextUpdates.status = values.statusChoice === "in_transit_or_en_route"
          ? selectedDelivery?.patient_id ? "in_transit" : "en_route"
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
      } else if (isAdmin && values.puid) {
        nextUpdates.puid = values.puid;
      }

      return updateDeliveryLocal(deliveryId, nextUpdates, { isBatchOperation: true });
    })
  )
    .then(async () => {
      smartRefreshManager.restart();
      invalidate("Delivery");
      await loadData(true);
      setSelectedBulkDeliveryIds([]);
      setBulkEditMode(false);
    })
    .finally(() => {
      setIsBulkUpdating(false);
    });
}