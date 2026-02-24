import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X } from "lucide-react";
import DeliveryFormStaged from './DeliveryFormStaged';

// Desktop staged panel
export function DeliveryStagedPanelDesktop({
  sortedStagedDeliveries,
  sortedProjectedDeliveries,
  stores,
  patients,
  currentUser,
  editingStagedId,
  isMobileDevice,
  handleStagedDeliveryClick,
  handleClearForm,
  stagedDeliveries,
  fullPredictionListRef,
  setProjectedDeliveries,
  setStagedDeliveries,
  setEditingStagedId,
  patientSearchInputRef,
  confirmAddProjectedToStaged,
  setDeleteConfirmation,
  isLoadingPredictions,
  onRefreshProjections,
}) {
  return (
    <div className="w-[300px] flex-shrink-0 p-3 rounded-lg border-2 flex flex-col h-full" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
      <Label className="text-sm font-semibold mb-2" style={{ color: 'var(--text-slate-900)' }}>
        Deliveries: (S: {sortedStagedDeliveries.filter(s => !s.id).length} P: {sortedStagedDeliveries.filter(s => s.id).length})
      </Label>
      <DeliveryFormStaged
        sortedStagedDeliveries={sortedStagedDeliveries}
        sortedProjectedDeliveries={sortedProjectedDeliveries}
        stores={stores}
        patients={patients}
        currentUser={currentUser}
        editingStagedId={editingStagedId}
        isMobileDevice={isMobileDevice}
        handleStagedDeliveryClick={handleStagedDeliveryClick}
        handleClearForm={handleClearForm}
        stagedDeliveries={stagedDeliveries}
        fullPredictionListRef={fullPredictionListRef}
        setProjectedDeliveries={setProjectedDeliveries}
        setStagedDeliveries={setStagedDeliveries}
        setEditingStagedId={setEditingStagedId}
        patientSearchInputRef={patientSearchInputRef}
        confirmAddProjectedToStaged={confirmAddProjectedToStaged}
        setDeleteConfirmation={setDeleteConfirmation}
        isLoadingPredictions={isLoadingPredictions}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full mt-2 text-xs"
        onClick={onRefreshProjections}
        disabled={isLoadingPredictions}
        style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}
      >
        {isLoadingPredictions ? 'Analyzing...' : 'Refresh Projections'}
      </Button>
    </div>
  );
}

// Mobile staged panel (slide-in overlay)
export function DeliveryStagedPanelMobile({
  show,
  onClose,
  sortedStagedDeliveries,
  sortedProjectedDeliveries,
  stores,
  patients,
  currentUser,
  editingStagedId,
  isMobileDevice,
  handleStagedDeliveryClick,
  handleClearForm,
  stagedDeliveries,
  fullPredictionListRef,
  setProjectedDeliveries,
  setStagedDeliveries,
  setEditingStagedId,
  patientSearchInputRef,
  confirmAddProjectedToStaged,
  setDeleteConfirmation,
  isLoadingPredictions,
  onRefreshProjections,
}) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 bg-black/60 z-50"
          onClick={onClose}
        >
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            onClick={(e) => e.stopPropagation()}
            className="absolute right-0 top-0 bottom-0 w-[300px] shadow-2xl flex flex-col"
            style={{ background: 'var(--bg-white)' }}
          >
            <div className="border-b p-4 flex items-center justify-between" style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-slate-50)' }}>
              <h3 className="text-lg font-semibold" style={{ color: 'var(--text-slate-900)' }}>
                Deliveries: (S: {sortedStagedDeliveries.filter(s => !s.id).length} P: {sortedStagedDeliveries.filter(s => s.id).length})
              </h3>
              <Button variant="ghost" size="icon" onClick={onClose}><X className="w-4 h-4" /></Button>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              <DeliveryFormStaged
                sortedStagedDeliveries={sortedStagedDeliveries}
                sortedProjectedDeliveries={sortedProjectedDeliveries}
                stores={stores}
                patients={patients}
                currentUser={currentUser}
                editingStagedId={editingStagedId}
                isMobileDevice={isMobileDevice}
                handleStagedDeliveryClick={handleStagedDeliveryClick}
                handleClearForm={handleClearForm}
                stagedDeliveries={stagedDeliveries}
                fullPredictionListRef={fullPredictionListRef}
                setProjectedDeliveries={setProjectedDeliveries}
                setStagedDeliveries={setStagedDeliveries}
                setEditingStagedId={setEditingStagedId}
                patientSearchInputRef={patientSearchInputRef}
                confirmAddProjectedToStaged={confirmAddProjectedToStaged}
                setDeleteConfirmation={setDeleteConfirmation}
                isLoadingPredictions={isLoadingPredictions}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full mt-2 mx-3 mb-2 text-xs"
              onClick={onRefreshProjections}
              disabled={isLoadingPredictions}
              style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}
            >
              {isLoadingPredictions ? 'Analyzing...' : 'Refresh Projections'}
            </Button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// Delete confirmation dialog
export function DeliveryDeleteConfirmDialog({
  deleteConfirmation,
  setDeleteConfirmation,
  isDeletingPending,
  sortedStagedDeliveries,
  stores,
  stagedDeliveries,
  allDeliveries,
  onConfirmDelete,
}) {
  if (!deleteConfirmation.show || !deleteConfirmation.staged) return null;

  const staged = deleteConfirmation.staged;
  const isPickup = !staged.patient_id;
  const otherPickups = isPickup ? sortedStagedDeliveries.filter(s =>
    s.id && !s.patient_id && s.store_id === staged.store_id && s.id !== staged.id
  ) : [];
  const linkedStops = isPickup ? sortedStagedDeliveries.filter(s =>
    s.id && s.patient_id && s.puid === staged.stop_id
  ) : [];

  if (isPickup && linkedStops.length > 0 && otherPickups.length > 0 && !deleteConfirmation.transferPickupId) {
    setTimeout(() => setDeleteConfirmation(prev => ({ ...prev, transferPickupId: otherPickups[0].id })), 0);
  }

  return (
    <div className="fixed inset-0 z-[10030] bg-black/60 flex items-center justify-center p-4">
      <div className="rounded-lg shadow-xl max-w-md w-full p-4 border" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)' }}>
        <h3 className="text-lg font-semibold mb-2" style={{ color: 'var(--text-slate-900)' }}>
          Delete Pending {isPickup ? 'Pickup' : 'Delivery'}?
        </h3>
        <p className="text-sm mb-4" style={{ color: 'var(--text-slate-600)' }}>
          {isPickup ? <>Delete pickup for <strong style={{ color: 'var(--text-slate-900)' }}>{staged.store_name}</strong> [{staged.ampm_deliveries}]?</> : <>Delete delivery for <strong style={{ color: 'var(--text-slate-900)' }}>{staged.patient_name}</strong>? This action cannot be undone.</>}
        </p>

        {isPickup && linkedStops.length > 0 && (
          <>
            <p className="text-sm mb-2 text-orange-600 font-medium">⚠️ {linkedStops.length} pending stop{linkedStops.length > 1 ? 's' : ''} linked to this pickup</p>
            {otherPickups.length > 0 ? (
              <div className="mb-4 space-y-2">
                <Label className="text-sm font-semibold">Transfer stops to:</Label>
                <Select
                  value={deleteConfirmation.transferPickupId || otherPickups[0]?.id || "delete_all"}
                  onValueChange={(value) => setDeleteConfirmation(prev => ({ ...prev, transferPickupId: value === "delete_all" ? null : value }))}
                >
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent className="z-[10040]">
                    <SelectItem value="delete_all">🗑️ Delete All Stops</SelectItem>
                    {otherPickups.map(pickup => (
                      <SelectItem key={pickup.id} value={pickup.id}>{pickup.store_name} [{pickup.ampm_deliveries}] (TR: {pickup.tracking_number})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <p className="text-sm mb-4 text-red-600 font-medium">⚠️ All Stops Will Be Deleted</p>
            )}
          </>
        )}

        <div className="flex gap-2 justify-end">
          <Button variant="outline" size="sm" onClick={() => setDeleteConfirmation({ show: false, staged: null, transferPickupId: null })} disabled={isDeletingPending}>Cancel</Button>
          <Button variant="destructive" size="sm" disabled={isDeletingPending} onClick={onConfirmDelete}>
            {isDeletingPending ? 'Processing...' : (deleteConfirmation.transferPickupId ? 'Trans & Del' : 'Delete')}
          </Button>
        </div>
      </div>
    </div>
  );
}