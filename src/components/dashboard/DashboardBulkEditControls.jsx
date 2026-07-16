import React, { useCallback, useMemo, useState } from "react"; // useMemo already imported
import { useDevice } from '@/components/utils/DeviceContext';
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
  AlertDialogTitle } from
"@/components/ui/alert-dialog";
import BulkEditStopsPanel from "@/components/deliveries/BulkEditStopsPanel";
import { updateDeliveryLocal, deleteDeliveryLocal, updatePatientLocal } from "@/components/utils/offlineMutations";
import { useAppData } from "@/components/utils/AppDataContext";
import { getDriverNameForStorage } from "@/components/utils/driverUtils";
import { invalidate } from "@/components/utils/dataManager";
import { base44 } from "@/api/base44Client";
import { smartRefreshManager } from "@/components/utils/smartRefreshManager";

export default function DashboardBulkEditControls({
  deliveriesWithStopOrder = [],
  drivers = [],
  stores = [],
  allDeliveries = [],
  patients = [],
  currentUser,
  stopCardsBaseHeight = 0,
  immersiveHidden = false,
  refreshData,
  selectedDeliveryIds = {},
  onSelectionChange,
  onBulkDeleteComplete,
  onBulkApplyComplete
}) {
  const { isMobile } = useDevice();
  const { appUsers } = useAppData();
  const effectiveDrivers = useMemo(() => {
    if (drivers && drivers.length > 0) return drivers;
    if (!appUsers) return [];
    return appUsers.filter((au) => au && au.app_roles?.includes('driver') && au.status !== 'inactive' && au.user_name);
  }, [drivers, appUsers]);
  const [showBulkEditPanel, setShowBulkEditPanel] = useState(false);

  const openBulkEditPanel = useCallback(() => {
    smartRefreshManager.pause();
    setShowBulkEditPanel(true);
  }, []);

  const closeBulkEditPanel = useCallback((open) => {
    if (!open) smartRefreshManager.resume();
    setShowBulkEditPanel(open);
  }, []);
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
  const handleApply = useCallback(async (values, initialValues, patientWindowEdits = {}) => {
    if (selectedDeliveries.length === 0) return;
    setIsSaving(true);

    try {
      // Build shared updates — only include fields that actually changed
      const sharedUpdates = {};

      // Delivery date
      if (values.delivery_date && values.delivery_date !== initialValues.delivery_date) {
        sharedUpdates.delivery_date = values.delivery_date;
      }

      // Time windows (allow clearing to null)
      if (values.delivery_time_start !== initialValues.delivery_time_start) {
        sharedUpdates.delivery_time_start = values.delivery_time_start || null;
      }
      if (values.delivery_time_end !== initialValues.delivery_time_end) {
        sharedUpdates.delivery_time_end = values.delivery_time_end || null;
      }

      // Driver
      if (values.driverChoice !== initialValues.driverChoice) {
        if (values.driverChoice === "unassigned") {
          sharedUpdates.driver_id = null;
          sharedUpdates.driver_name = "";
        } else if (values.driverChoice !== "unchanged") {
          const selectedDriver = effectiveDrivers.find((d) => d.id === values.driverChoice);
          if (selectedDriver) {
            sharedUpdates.driver_id = selectedDriver.id;
            sharedUpdates.driver_name = getDriverNameForStorage(selectedDriver);
          }
        }
      }

      // Travel mode — apply whenever the user has explicitly selected a mode (not mixed)
      // Only include transport_mode (not finished_leg_transport_mode — not an entity field)
      if (values.travelModeChoice && values.travelModeChoice !== "mixed") {
        sharedUpdates.transport_mode = values.travelModeChoice;
      }

      // AM/PM (only if changed and not "unchanged")
      if (values.ampmChoice !== initialValues.ampmChoice && values.ampmChoice !== "unchanged") {
        sharedUpdates.ampm_deliveries = values.ampmChoice;
      }

      // Store/slot (parse storeId and slot from "storeId::slot" format)
      if (values.storeChoice !== "unchanged") {
        const [storeId, slot] = String(values.storeChoice).split("::");
        if (storeId) {
          sharedUpdates.store_id = storeId;
          if (slot) sharedUpdates.ampm_deliveries = slot;
        }
      }

      // STEP 1: Apply all delivery updates immediately — both offline DB and backend API in parallel.
      await Promise.all(selectedDeliveries.map(async (delivery) => {
        const payload = { ...sharedUpdates };

        // Status is per-delivery (pickup vs delivery determines en_route vs in_transit)
        if (values.statusChoice !== "unchanged") {
          payload.status = values.statusChoice === "in_transit_or_en_route" ?
          !delivery?.patient_id ? "en_route" : "in_transit" :
          values.statusChoice;
        }

        // PUID: only apply if admin changed it (and storeChoice is not overriding)
        if (values.puid !== initialValues.puid && values.storeChoice === "unchanged") {
          payload.puid = values.puid || null;
        }

        if (Object.keys(payload).length === 0) return;

        return updateDeliveryLocal(delivery.id, payload, { skipSmartRefresh: true, isBatchOperation: false });
      }));

      // STEP 2: Save patient time window edits (updates Patient entity directly).
      const patientUpdates = Object.entries(patientWindowEdits).map(([patientId, edits]) => {
        return updatePatientLocal(patientId, {
          time_window_start: edits.time_window_start || null,
          time_window_end: edits.time_window_end || null
        });
      });
      if (patientUpdates.length > 0) {
        await Promise.all(patientUpdates);
        invalidate("Patient");
      }

      invalidate("Delivery");

      // If transport_mode was explicitly changed, also write directly to the backend entity
      // to ensure it persists even if the offline mutation pipeline strips or delays it.
      if (sharedUpdates.transport_mode) {
        const modeToApply = sharedUpdates.transport_mode;
        Promise.all(
          selectedDeliveries.map((delivery) =>
            base44.entities.Delivery.update(delivery.id, { transport_mode: modeToApply }).catch(() => null)
          )
        ).catch(() => null); // fire-and-forget — non-blocking
      }

      await refreshData?.();
      clearSelection();
      onBulkApplyComplete?.();
    } finally {
      setIsSaving(false);
      smartRefreshManager.resume();
    }
  }, [selectedDeliveries, drivers, refreshData, clearSelection]);

  const totalDeleteCount = selectedCount + linkedPendingCount;

  const handleDeleteConfirmed = useCallback(async () => {
    setShowDeleteDialog(false);
    setIsDeleting(true);
    try {
      // Collect all IDs to delete: selected + linked pending deliveries from deleted pickups
      const deletedPickupStopIds = new Set(
        selectedDeliveries.filter((d) => !d?.patient_id && d?.stop_id).map((d) => d.stop_id)
      );
      const linkedPendingDeliveries = deletedPickupStopIds.size > 0 ?
      allDeliveries.filter((d) =>
      d?.patient_id &&
      d?.status === "pending" &&
      d?.puid && deletedPickupStopIds.has(d.puid) &&
      !selectedDeliveryIds[d.id]
      ) :
      [];
      const allToDelete = [...selectedDeliveries, ...linkedPendingDeliveries];
      const allDeletedIds = allToDelete.map((d) => d.id);

      // 1. Immediately remove from local UI on this device
      window.dispatchEvent(new CustomEvent("offlineDeliveriesDeleted", {
        detail: { deletedIds: allDeletedIds }
      }));

      // 2. Delete from offline DB + backend for each record
      await Promise.all(allToDelete.map((delivery) => deleteDeliveryLocal(delivery.id)));

      // 3. Broadcast batch_delete so other devices' realtime sync removes them too
      window.dispatchEvent(new CustomEvent("deliveriesUpdated", {
        detail: {
          triggeredBy: "bulkDelete",
          deletedIds: allDeletedIds,
          freshDeliveries: [],
          preserveLocalState: false
        }
      }));

      // 4. Force all devices to reconcile by invalidating server-side cache
      invalidate("Delivery");
      try {
        await base44.functions.invoke("forceDriverSyncRefresh", {
          deletedDeliveryIds: allDeletedIds
        });
      } catch (_) {/* non-critical */}

      await refreshData?.();
      clearSelection();
      onBulkDeleteComplete?.();
    } finally {
      setIsDeleting(false);
    }
  }, [selectedDeliveries, allDeliveries, selectedDeliveryIds, refreshData, clearSelection, onBulkDeleteComplete]);

  if (immersiveHidden && selectedCount === 0) {
    return null;
  }

  return (
    <>
      {!immersiveHidden && selectedCount > 0 &&
      <div
        className="absolute left-1/2 z-[240] flex -translate-x-1/2 items-center rounded-full border border-border bg-card/95 shadow-xl backdrop-blur-sm px-2 py-1 gap-1"
        style={{ bottom: `${(stopCardsBaseHeight || 0) + 16}px` }}>
        
          <span className="text-sm font-medium text-foreground px-1">{totalDeleteCount} Stops</span>
          <Button size="sm" onClick={openBulkEditPanel} className="gap-2" disabled={isSaving || isDeleting}>
            <PencilLine className="h-4 w-4" />
            Edit
          </Button>
          <Button
          size="sm"
          variant="ghost"
          onClick={() => setShowDeleteDialog(true)}
          disabled={isDeleting}
          className="text-destructive hover:text-destructive hover:bg-destructive/10 gap-1">
          
            <Trash2 className="h-4 w-4" />
            {totalDeleteCount}
          </Button>
          <Button size="icon" variant="ghost" onClick={clearSelection} disabled={isDeleting}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      }

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent className="z-[99999] py-4 px-4" style={{ zIndex: 99999 }}>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Delete {totalDeleteCount} Stop{totalDeleteCount !== 1 ? "s" : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>This will permanently delete the following from both local and server records. This cannot be undone.</p>
                <ul className="list-disc pl-4 space-y-1">
                  {pickupCount > 0 &&
                  <li>
                      <strong>{pickupCount} pickup{pickupCount !== 1 ? "s" : ""}</strong>
                    </li>
                  }
                  {deliveryCount > 0 &&
                  <li><strong>{deliveryCount} deliver{deliveryCount !== 1 ? "ies" : "y"}</strong></li>
                  }
                </ul>
                {(pendingDeliveryCount > 0 || linkedPendingCount > 0) &&
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300 space-y-1">
                    <p><strong>⚠ Warning:</strong></p>
                    {pendingDeliveryCount > 0 &&
                  <p>{pendingDeliveryCount} selected deliver{pendingDeliveryCount !== 1 ? "ies are" : "y is"} still pending and will be deleted.</p>
                  }
                    {linkedPendingCount > 0 &&
                  <p>{linkedPendingCount} pending deliver{linkedPendingCount !== 1 ? "ies are" : "y is"} linked to the pickup{pickupCount !== 1 ? "s" : ""} being deleted and will be deleted as well.</p>
                  }
                  </div>
                }
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="pb-4">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirmed}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              
              Delete {totalDeleteCount} Stop{totalDeleteCount !== 1 ? "s" : ""}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="hidden">{selectedDeliveries.length}</div>

      <BulkEditStopsPanel
        open={showBulkEditPanel}
        onOpenChange={closeBulkEditPanel}
        isMobile={isMobile}
        selectedCount={selectedCount}
        selectedDeliveries={selectedDeliveries}
        drivers={effectiveDrivers}
        stores={stores}
        allDeliveries={allDeliveries}
        patients={patients}
        currentUser={currentUser}
        onApply={handleApply}
        isSaving={isSaving} />
      
    </>);

}