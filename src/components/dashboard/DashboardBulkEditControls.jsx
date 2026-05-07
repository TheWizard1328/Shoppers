import React, { useCallback, useMemo, useState } from "react";
import { PencilLine, Trash2, X, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import BulkEditStopsPanel from "@/components/deliveries/BulkEditStopsPanel";
import { updateDeliveryLocal, deleteDeliveryLocal } from "@/components/utils/offlineMutations";
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
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const selectedDeliveries = useMemo(() => {
    const ids = Object.keys(selectedDeliveryIds).filter((id) => selectedDeliveryIds[id]);
    if (ids.length === 0) return [];
    const idSet = new Set(ids);
    return deliveriesWithStopOrder.filter((delivery) => delivery?.id && idSet.has(delivery.id));
  }, [deliveriesWithStopOrder, selectedDeliveryIds]);

  const selectedCount = selectedDeliveries.length;

  const pickupCount = useMemo(() => selectedDeliveries.filter((d) => !d?.patient_id).length, [selectedDeliveries]);
  const deliveryCount = useMemo(() => selectedDeliveries.filter((d) => !!d?.patient_id).length, [selectedDeliveries]);

  // Pending deliveries directly selected
  const pendingDeliveryCount = useMemo(() => selectedDeliveries.filter((d) => d?.patient_id && d?.status === "pending").length, [selectedDeliveries]);

  // Pending deliveries in the full route that are linked to one of the pickups being deleted (but not themselves selected)
  const linkedPendingCount = useMemo(() => {
    const deletedPickupStopIds = new Set(
      selectedDeliveries.filter((d) => !d?.patient_id && d?.stop_id).map((d) => d.stop_id)
    );
    if (deletedPickupStopIds.size === 0) return 0;
    return allDeliveries.filter((d) =>
      d?.patient_id &&
      d?.status === "pending" &&
      d?.puid && deletedPickupStopIds.has(d.puid) &&
      !selectedDeliveryIds[d.id]
    ).length;
  }, [selectedDeliveries, allDeliveries, selectedDeliveryIds]);

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

  const handleDeleteConfirmed = useCallback(async () => {
    setShowDeleteDialog(false);
    setIsDeleting(true);
    try {
      await Promise.all(selectedDeliveries.map((delivery) => deleteDeliveryLocal(delivery.id)));
      invalidate("Delivery");
      await refreshData?.();
      clearSelection();
    } finally {
      setIsDeleting(false);
    }
  }, [selectedDeliveries, refreshData, clearSelection]);

  if (immersiveHidden && selectedCount === 0) {
    return null;
  }

  return (
    <>
      {!immersiveHidden && selectedCount > 0 && (
        <div
          className="absolute left-1/2 z-[240] flex -translate-x-1/2 items-center rounded-full border border-border bg-card/95 shadow-xl backdrop-blur-sm px-2 py-1 gap-1"
          style={{ bottom: `${(stopCardsBaseHeight || 0) + 16}px` }}
        >
          <span className="text-sm font-medium text-foreground px-1">{selectedCount} Stops</span>
          <Button size="sm" onClick={() => setShowBulkEditPanel(true)} className="gap-2" disabled={isSaving || isDeleting}>
            <PencilLine className="h-4 w-4" />
            Edit
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setShowDeleteDialog(true)}
            disabled={isDeleting}
            className="text-destructive hover:text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={clearSelection} disabled={isDeleting}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent className="z-[99999]" style={{ zIndex: 99999 }}>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Delete {selectedCount} Stop{selectedCount !== 1 ? "s" : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>This will permanently delete the following from both local and server records. This cannot be undone.</p>
                <ul className="list-disc pl-4 space-y-1">
                  {pickupCount > 0 && (
                    <li>
                      <strong>{pickupCount} pickup{pickupCount !== 1 ? "s" : ""}</strong>
                    </li>
                  )}
                  {deliveryCount > 0 && (
                    <li><strong>{deliveryCount} deliver{deliveryCount !== 1 ? "ies" : "y"}</strong></li>
                  )}
                </ul>
                {(pendingDeliveryCount > 0 || linkedPendingCount > 0) && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300 space-y-1">
                    <p><strong>⚠ Warning:</strong></p>
                    {pendingDeliveryCount > 0 && (
                      <p>{pendingDeliveryCount} selected deliver{pendingDeliveryCount !== 1 ? "ies are" : "y is"} still pending and will be deleted.</p>
                    )}
                    {linkedPendingCount > 0 && (
                      <p>{linkedPendingCount} pending deliver{linkedPendingCount !== 1 ? "ies are" : "y is"} linked to the pickup{pickupCount !== 1 ? "s" : ""} being deleted and will be left without a pickup.</p>
                    )}
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirmed}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete {selectedCount} Stop{selectedCount !== 1 ? "s" : ""}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="hidden">{selectedDeliveries.length}</div>

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