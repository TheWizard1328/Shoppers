import React, { useCallback, useMemo, useState } from "react";
import { PencilLine, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import BulkEditStopsPanel from "@/components/deliveries/BulkEditStopsPanel";
import { updateDeliveryLocal } from "@/components/utils/offlineMutations";
import { invalidate } from "@/components/utils/dataManager";

export default function DashboardBulkEditControls({
  deliveriesWithStopOrder = [],
  drivers = [],
  stores = [],
  allDeliveries = [],
  currentUser,
  isMobile = false,
  stopCardsBaseHeight = 0,
  immersiveHidden = false,
  refreshData,
  selectedDeliveryIds = {},
  onSelectionChange,
}) {
  const [showBulkEditPanel, setShowBulkEditPanel] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const selectedDeliveries = useMemo(() => {
    const ids = Object.keys(selectedDeliveryIds).filter((id) => selectedDeliveryIds[id]);
    if (ids.length === 0) return [];
    const idSet = new Set(ids);
    return deliveriesWithStopOrder.filter((delivery) => delivery?.id && idSet.has(delivery.id));
  }, [deliveriesWithStopOrder, selectedDeliveryIds]);

  const selectedCount = selectedDeliveries.length;

  const clearSelection = useCallback(() => {
    Object.keys(selectedDeliveryIds).forEach((deliveryId) => {
      onSelectionChange?.(deliveryId, false);
    });
    setShowBulkEditPanel(false);
  }, [onSelectionChange, selectedDeliveryIds]);

  // initialValues is passed from BulkEditStopsPanel via onApply so we can diff against it
  const handleApply = useCallback(async (values, initialValues) => {
    if (selectedDeliveries.length === 0) return;
    setIsSaving(true);

    try {
      const sharedUpdates = {};

      // Only include a field if its value changed from the initial value
      if (values.driverChoice !== initialValues.driverChoice) {
        sharedUpdates.driver_id = values.driverChoice === "unassigned" ? "" : values.driverChoice;
      }
      if (values.delivery_date !== initialValues.delivery_date) {
        sharedUpdates.delivery_date = values.delivery_date;
      }
      if (values.travelModeChoice !== initialValues.travelModeChoice && values.travelModeChoice !== "mixed") {
        sharedUpdates.transport_mode = values.travelModeChoice;
      }
      if (values.delivery_time_start !== initialValues.delivery_time_start) {
        sharedUpdates.delivery_time_start = values.delivery_time_start;
      }
      if (values.delivery_time_end !== initialValues.delivery_time_end) {
        sharedUpdates.delivery_time_end = values.delivery_time_end;
      }
      if (values.ampmChoice !== initialValues.ampmChoice && values.ampmChoice !== "unchanged") {
        sharedUpdates.ampm_deliveries = values.ampmChoice;
      }
      if (values.puid !== initialValues.puid) {
        sharedUpdates.puid = values.puid;
      }
      if (values.storeChoice !== initialValues.storeChoice && values.storeChoice !== "unchanged") {
        const [storeId] = String(values.storeChoice).split("::");
        sharedUpdates.store_id = storeId;
      }

      await Promise.all(selectedDeliveries.map((delivery) => {
        const payload = { ...sharedUpdates };
        if (values.statusChoice !== "unchanged" && values.statusChoice !== initialValues.statusChoice) {
          payload.status = values.statusChoice === "in_transit_or_en_route"
            ? (!delivery?.patient_id ? "en_route" : "in_transit")
            : values.statusChoice;
        }
        return updateDeliveryLocal(delivery.id, payload, { skipSmartRefresh: true });
      }));

      invalidate("Delivery");
      await refreshData?.();
      clearSelection();
    } finally {
      setIsSaving(false);
    }
  }, [selectedDeliveries, refreshData, clearSelection]);

  if (immersiveHidden && selectedCount === 0) {
    return null;
  }

  return (
    <>
      {!immersiveHidden && selectedCount > 0 && (
        <div
          className="absolute left-1/2 z-[240] flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-card/95 px-3 py-2 shadow-xl backdrop-blur-sm"
          style={{ bottom: `${(stopCardsBaseHeight || 0) + 16}px` }}
        >
          <span className="text-sm font-medium text-foreground">{selectedCount} selected</span>
          <Button size="sm" onClick={() => setShowBulkEditPanel(true)} className="gap-2">
            <PencilLine className="h-4 w-4" />
            Edit
          </Button>
          <Button size="icon" variant="ghost" onClick={clearSelection}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}

      <div className="hidden">
        {selectedDeliveries.length}
      </div>
      <BulkEditStopsPanel
        open={showBulkEditPanel}
        onOpenChange={setShowBulkEditPanel}
        isMobile={isMobile}
        selectedCount={selectedCount}
        selectedDeliveries={selectedDeliveries}
        drivers={drivers}
        stores={stores}
        allDeliveries={allDeliveries}
        currentUser={currentUser}
        onApply={handleApply}
        isSaving={isSaving}
      />
    </>
  );
}