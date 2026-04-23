import React, { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Pencil, Package, Trash2 } from "lucide-react";
import StopCard from "../common/StopCard";
import StopDetailsPanel from "./StopDetailsPanel";
import DeliveryListView from "../dashboard/DeliveryListView";
import BulkEditStopsPanel from "./BulkEditStopsPanel";
import DeleteConfirmDialog from "./DeleteConfirmDialog";
import { isMobileDevice } from "../utils/deviceUtils";
import { createDeliveryLocal, batchDeleteDeliveriesLocal } from "../utils/entityMutations";
import { invalidate } from "../utils/dataManager";
import { userHasRole } from "../utils/userRoles";
import { applyBulkEditStops } from "./bulkEditHelpers.jsx";

export default function RouteManagementContent({
  deliveries,
  patients,
  stores,
  drivers,
  currentUser,
  selectedDate,
  allDeliveries,
  viewMode,
  canBulkEdit,
  onEdit,
  onEditPatient,
  onDelete,
  onRestart,
  onStatusUpdate,
  onNotesUpdate,
  onCODUpdate,
  loadData,
  appUsers = []
}) {
  const isMobile = useMemo(() => isMobileDevice(), []);
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const [selectedDeliveryId, setSelectedDeliveryId] = useState(null);
  const [bulkEditMode, setBulkEditMode] = useState(false);
  const [selectedBulkDeliveryIds, setSelectedBulkDeliveryIds] = useState([]);
  const [isBulkEditPanelOpen, setIsBulkEditPanelOpen] = useState(false);
  const [isBulkUpdating, setIsBulkUpdating] = useState(false);
  const [isBulkDeleteDialogOpen, setIsBulkDeleteDialogOpen] = useState(false);

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const showSplitView = !isMobile || windowWidth >= 640;
  const resolvedViewMode = bulkEditMode ? "list" : viewMode;

  const bulkEditableDrivers = useMemo(() => {
    return (drivers || []).filter((driver) => userHasRole(driver, "driver"));
  }, [drivers]);

  const visibleBulkDeliveryIds = useMemo(() => {
    return (deliveries || []).map((delivery) => delivery.id).filter(Boolean);
  }, [deliveries]);

  const areAllVisibleBulkDeliveriesSelected = useMemo(() => {
    return visibleBulkDeliveryIds.length > 0 && visibleBulkDeliveryIds.every((id) => selectedBulkDeliveryIds.includes(id));
  }, [visibleBulkDeliveryIds, selectedBulkDeliveryIds]);

  const selectedBulkDeliveries = useMemo(() => {
    const selectedIds = new Set(selectedBulkDeliveryIds);
    return (deliveries || []).filter((delivery) => selectedIds.has(delivery.id));
  }, [deliveries, selectedBulkDeliveryIds]);

  useEffect(() => {
    setSelectedBulkDeliveryIds((current) => current.filter((id) => visibleBulkDeliveryIds.includes(id)));
  }, [visibleBulkDeliveryIds]);

  const handleToggleBulkDelivery = useCallback((deliveryId) => {
    setSelectedBulkDeliveryIds((current) =>
    current.includes(deliveryId) ?
    current.filter((id) => id !== deliveryId) :
    [...current, deliveryId]
    );
  }, []);

  const handleToggleAllVisibleBulkDeliveries = useCallback(() => {
    setSelectedBulkDeliveryIds((current) => {
      if (areAllVisibleBulkDeliveriesSelected) {
        return current.filter((id) => !visibleBulkDeliveryIds.includes(id));
      }
      return Array.from(new Set([...current, ...visibleBulkDeliveryIds]));
    });
  }, [areAllVisibleBulkDeliveriesSelected, visibleBulkDeliveryIds]);

  const handleCancelBulkEdit = useCallback(() => {
    setIsBulkEditPanelOpen(false);
    setBulkEditMode(false);
    setSelectedBulkDeliveryIds([]);
  }, []);

  const handleBulkEditApply = useCallback((values) => {
    return applyBulkEditStops({
      values,
      currentUser,
      deliveries,
      allDeliveries,
      bulkEditableDrivers,
      selectedBulkDeliveryIds,
      loadData,
      setSelectedBulkDeliveryIds,
      setBulkEditMode,
      setIsBulkUpdating
    });
  }, [allDeliveries, bulkEditableDrivers, currentUser, deliveries, loadData, selectedBulkDeliveryIds]);

  const handleBulkDelete = useCallback(async () => {
    if (selectedBulkDeliveryIds.length === 0) return;
    setIsBulkUpdating(true);
    try {
      await batchDeleteDeliveriesLocal(selectedBulkDeliveryIds);
      setSelectedBulkDeliveryIds([]);
      setBulkEditMode(false);
      setIsBulkDeleteDialogOpen(false);
    } finally {
      setIsBulkUpdating(false);
    }
  }, [selectedBulkDeliveryIds]);

  const handleCreateReturn = useCallback(async ({ originalDelivery, returnPatient, store }) => {
    const currentDate = format(new Date(), "yyyy-MM-dd");
    await createDeliveryLocal({
      patient_id: returnPatient.id,
      store_id: originalDelivery.store_id,
      driver_id: originalDelivery.driver_id,
      driver_name: originalDelivery.driver_name,
      delivery_date: currentDate,
      delivery_time_start: originalDelivery.delivery_time_start,
      delivery_time_end: originalDelivery.delivery_time_end,
      status: "in_transit",
      delivery_notes: `PATIENT RETURN From: ${originalDelivery.delivery_date}`,
      patient_name: returnPatient.full_name,
      patient_phone: returnPatient.phone || store?.phone || "",
      store_phone: store?.phone || ""
    });
    await invalidate("Delivery");
    await loadData(true);
  }, [loadData]);

  const selectedDelivery = selectedDeliveryId ? deliveries.find((delivery) => delivery?.id === selectedDeliveryId) : null;
  const selectedPatient = selectedDelivery ? (patients || []).find((patient) => patient && (patient.id === selectedDelivery.patient_id || patient.patient_id === selectedDelivery.patient_id)) : null;
  const selectedStore = selectedDelivery ? (stores || []).find((store) => store && store.id === selectedDelivery.store_id) : null;
  const selectedDriver = selectedDelivery ?
  (drivers || []).find((driver) => driver.id === selectedDelivery.driver_id || driver.appUserId === selectedDelivery.driver_id) ||
  (drivers || []).find((driver) => driver.full_name === selectedDelivery.driver_name) ||
  (drivers || []).find((driver) => driver.user_name === selectedDelivery.driver_name) :
  null;

  if (!deliveries || deliveries.length === 0) {
    return (
      <div className="text-center py-12 text-slate-500 col-span-full">
        <Package className="w-16 h-16 mx-auto mb-4 opacity-30" />
        <p className="text-lg font-medium">No deliveries for this date</p>
      </div>);

  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" style={{ paddingBottom: isMobile ? 'var(--bottom-nav-height, 88px)' : 0 }}>
      {canBulkEdit &&
      <Card className="sticky top-0 z-10 flex-shrink-0 shadow-sm mb-2" style={{ background: "var(--bg-white)", borderColor: "var(--border-slate-200)" }}>
          <CardContent className="px-3 py-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-medium" style={{ color: "var(--text-slate-700)" }}>
                {bulkEditMode ? "Select the stops you want to update." : "Bulk edit driver, date, status, pickup location, and time windows for multiple stops."}
              </p>
              {bulkEditMode &&
            <Badge variant="secondary" style={{ background: "var(--bg-slate-100)", color: "var(--text-slate-700)" }}>
                  {selectedBulkDeliveryIds.length} selected
                </Badge>
            }
            </div>
            <div className="flex flex-wrap gap-2">
              {!bulkEditMode ?
            <Button variant="outline" className="gap-2" onClick={() => setBulkEditMode(true)}>
                  <Pencil className="w-4 h-4" />
                  Bulk Edit Stops
                </Button> :

            <>
                  <Button variant="outline" className="gap-2" onClick={handleToggleAllVisibleBulkDeliveries}>
                    {areAllVisibleBulkDeliveriesSelected ? "Clear Visible" : "Select Visible"}
                  </Button>
                  <Button className="gap-2" onClick={() => setIsBulkEditPanelOpen(true)} disabled={selectedBulkDeliveryIds.length === 0 || isBulkUpdating}>
                    <Pencil className="w-4 h-4" />
                    Edit Selected
                  </Button>
                  <Button variant="destructive" className="gap-2" onClick={() => setIsBulkDeleteDialogOpen(true)} disabled={selectedBulkDeliveryIds.length === 0 || isBulkUpdating}>
                    <Trash2 className="w-4 h-4" />
                    Delete Selected
                  </Button>
                  <Button variant="ghost" onClick={handleCancelBulkEdit} disabled={isBulkUpdating}>
                    Cancel
                  </Button>
                </>
            }
            </div>
          </CardContent>
        </Card>
      }

      {resolvedViewMode === "cards" ?
      <div className="flex h-full gap-4">
          <div className={`${showSplitView ? "w-[400px] flex-shrink-0" : "w-full"} h-full overflow-hidden`}>
            <div className="px-3 py-2 space-y-2 overflow-y-auto h-full min-h-0 flex flex-col items-center" style={{ maxHeight: isMobile ? 'calc(100dvh - var(--mobile-header-height, 64px) - var(--bottom-nav-height, 88px) - 220px)' : 'calc(100vh - 280px)' }}>
              {deliveries.map((delivery, index) =>
            <StopCard
              key={delivery.id || `${delivery.delivery_date || "unknown"}-${delivery.patient_id ?? "pickup"}-${delivery.store_id ?? "store"}-${delivery.tracking_number || index}`}
              delivery={delivery}
              patient={(patients || []).find((patient) => patient && (patient.id === delivery.patient_id || patient.patient_id === delivery.patient_id))}
              store={(stores || []).find((store) => store && store.id === delivery.store_id)}
              driver={
              (drivers || []).find((driver) => driver.id === delivery.driver_id || driver.appUserId === delivery.driver_id) ||
              (drivers || []).find((driver) => driver.full_name === delivery.driver_name) ||
              (drivers || []).find((driver) => driver.user_name === delivery.driver_name)
              }
              currentUser={currentUser}
              stopOrder={delivery.stopOrder || delivery.stop_order || index + 1}
              isSelected={selectedDeliveryId === delivery.id}
              onClick={() => setSelectedDeliveryId(selectedDeliveryId === delivery.id ? null : delivery.id)}
              onStatusUpdate={onStatusUpdate}
              onNotesUpdate={onNotesUpdate}
              onEdit={(nextDelivery) => {
                setSelectedDeliveryId(null);
                onEdit(nextDelivery);
              }}
              onDelete={onDelete}
              showDriverName={false}
              onRestart={onRestart}
              allDeliveries={allDeliveries || []}
              selectedDate={selectedDate}
              onEditPatient={onEditPatient}
              onCODUpdate={onCODUpdate}
              onStartDelivery={onStatusUpdate}
              onCreateReturn={handleCreateReturn}
              patients={patients || []}
              drivers={drivers || []}
              stores={stores || []}
              appUsers={appUsers}
              showDragHandle={false}
              compact />

            )}
            </div>
          </div>

          {showSplitView &&
        <div className="flex-1 h-full overflow-hidden rounded-lg border" style={{ background: "var(--bg-white)", borderColor: "var(--border-slate-200)" }}>
              <StopDetailsPanel
            delivery={selectedDelivery}
            patient={selectedPatient}
            store={selectedStore}
            driver={selectedDriver}
            currentUser={currentUser}
            onClose={() => setSelectedDeliveryId(null)}
            onStatusUpdate={onStatusUpdate}
            onEdit={(nextDelivery) => {
              setSelectedDeliveryId(null);
              onEdit(nextDelivery);
            }}
            onDelete={onDelete}
            onRestart={onRestart} />
          
            </div>
        }
        </div> :

      <div className="flex-1 min-h-0 min-w-0 h-full w-full max-h-full max-w-full overflow-hidden px-4 relative">
          <DeliveryListView
          deliveries={deliveries}
          patients={patients || []}
          stores={stores || []}
          drivers={drivers || []}
          currentUser={currentUser}
          bulkEditMode={bulkEditMode}
          bulkSelectedIds={selectedBulkDeliveryIds}
          onBulkToggle={handleToggleBulkDelivery}
          onBulkToggleAllVisible={handleToggleAllVisibleBulkDeliveries}
          onEdit={onEdit}
          onEditPatient={onEditPatient}
          onDelete={onDelete}
          onRestart={onRestart}
          onStatusUpdate={onStatusUpdate}
          onNotesUpdate={onNotesUpdate}
          onCODUpdate={onCODUpdate}
          onCreateReturn={handleCreateReturn}
          onStartDelivery={onStatusUpdate}
          allDeliveries={allDeliveries || []}
          selectedDate={selectedDate}
          isMobile={isMobile} />
        
        </div>
      }

      {isMobile && !showSplitView && resolvedViewMode === "cards" && selectedDeliveryId &&
      <div className="fixed inset-0 z-[10000] flex items-end justify-center bg-black/50 backdrop-blur-sm" onClick={() => setSelectedDeliveryId(null)}>
          <div className="w-full max-h-[85vh] overflow-hidden rounded-t-2xl" style={{ background: "var(--bg-white)" }} onClick={(event) => event.stopPropagation()}>
            <StopDetailsPanel
            delivery={selectedDelivery}
            patient={selectedPatient}
            store={selectedStore}
            driver={selectedDriver}
            currentUser={currentUser}
            onClose={() => setSelectedDeliveryId(null)}
            onStatusUpdate={onStatusUpdate}
            onEdit={(nextDelivery) => {
              setSelectedDeliveryId(null);
              onEdit(nextDelivery);
            }}
            onDelete={onDelete}
            onRestart={onRestart} />
          
          </div>
        </div>
      }

      <BulkEditStopsPanel
        open={isBulkEditPanelOpen}
        onOpenChange={setIsBulkEditPanelOpen}
        isMobile={isMobile}
        selectedCount={selectedBulkDeliveryIds.length}
        selectedDeliveries={selectedBulkDeliveries}
        drivers={bulkEditableDrivers}
        stores={stores || []}
        allDeliveries={allDeliveries || []}
        currentUser={currentUser}
        onApply={handleBulkEditApply}
        isSaving={isBulkUpdating} />

      <DeleteConfirmDialog
        isOpen={isBulkDeleteDialogOpen}
        onConfirm={handleBulkDelete}
        onCancel={() => setIsBulkDeleteDialogOpen(false)}
        stopName={`${selectedBulkDeliveryIds.length} selected stop${selectedBulkDeliveryIds.length === 1 ? "" : "s"}`} />
    </div>);


}