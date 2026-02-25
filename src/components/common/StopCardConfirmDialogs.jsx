import React from "react";
import ReactDOM from "react-dom";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Trash2, Undo2, Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "sonner";
import { formatPhoneNumber } from '../utils/phoneFormatter';
import { getDriverDisplayName } from '../utils/driverUtils';

export default function StopCardConfirmDialogs({
  // Delete dialog
  showDeleteConfirm,
  setShowDeleteConfirm,
  isPickup,
  delivery,
  displayName,
  displayAddress,
  store,
  pendingPickups,
  availableTransferPickups,
  selectedTransferPickupId,
  setSelectedTransferPickupId,
  allDeliveries,
  onDeleteDelivery,
  // Return dialog
  showReturnConfirm,
  returnPatient,
  handleCancelReturn,
  handleConfirmReturn,
  isCreatingReturn,
  driver,
  patient,
}) {
  return (
    <>
      {/* Delete Confirmation Dialog */}
      {showDeleteConfirm && ReactDOM.createPortal(
        <div
          className="fixed inset-0 flex items-center justify-center"
          style={{ background: 'rgba(0, 0, 0, 0.6)', zIndex: 999999, pointerEvents: 'auto' }}
          onClick={() => setShowDeleteConfirm(false)}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="rounded-lg shadow-xl p-6 max-w-md w-full mx-4" style={{ background: 'var(--bg-white)' }}>
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2 text-red-600">
              <Trash2 className="w-5 h-5" />
              Confirm Delete
            </h3>

            <div className="space-y-3 mb-6">
              <p className="text-slate-700">
                Are you sure you want to delete this {isPickup ? 'pickup' : 'delivery'}?
              </p>

              <div className="rounded-lg p-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm" style={{ background: 'var(--bg-slate-50)' }}>
                <span className="font-semibold" style={{ color: 'var(--text-slate-700)' }}>Name:</span>
                <span style={{ color: 'var(--text-slate-900)' }}>{displayName}</span>
                {displayAddress && <>
                  <span className="font-semibold" style={{ color: 'var(--text-slate-700)' }}>Address:</span>
                  <span style={{ color: 'var(--text-slate-900)' }}>{displayAddress}</span>
                </>}
                {delivery.tracking_number && <>
                  <span className="font-semibold" style={{ color: 'var(--text-slate-700)' }}>Tr#:</span>
                  <span style={{ color: 'var(--text-slate-900)' }}>{delivery.tracking_number}</span>
                </>}
              </div>

              {isPickup && delivery.stop_id && pendingPickups && pendingPickups.length > 0 &&
                <div className="rounded-lg p-3 border-2 border-amber-400 space-y-3" style={{ background: 'var(--bg-amber-50)' }}>
                  <div>
                    <p className="text-sm font-semibold text-amber-800 mb-1">
                      ⚠️ Warning: {pendingPickups.length} Pending Delivery{pendingPickups.length > 1 ? 's' : ''} Will {selectedTransferPickupId ? 'Be Transferred' : 'Also Be Deleted'}
                    </p>
                    <p className="text-xs text-amber-700">
                      {pendingPickups.map(p => p.patient_name).join(', ')}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm font-semibold text-amber-900">Transfer to another pickup (optional):</Label>
                    <Select value={selectedTransferPickupId} onValueChange={(value) => setSelectedTransferPickupId(value)}>
                      <SelectTrigger className="h-8 text-sm bg-white">
                        <SelectValue placeholder="Select pickup location" />
                      </SelectTrigger>
                      <SelectContent className="z-[999999]">
                        <SelectItem value="delete_all">All Stops Will Be Deleted</SelectItem>
                        {availableTransferPickups.map(pickup => (
                          <SelectItem key={pickup.id} value={pickup.id}>
                            {store?.name} [{pickup.ampm_deliveries || 'AM'}] (TR# {pickup.tracking_number})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {selectedTransferPickupId && selectedTransferPickupId !== 'delete_all' && (
                      <p className="text-xs text-blue-700 italic">
                        Pending stops will be updated with new PUID and TR# range
                      </p>
                    )}
                  </div>
                </div>
              }

              <p className="text-sm text-red-600 font-medium">This action cannot be undone.</p>
            </div>

            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={() => { setShowDeleteConfirm(false); setSelectedTransferPickupId(''); }}>
                Cancel
              </Button>
              <Button
                className="flex-1 bg-red-600 hover:bg-red-700"
                onClick={async () => {
                  try {
                    if (isPickup && selectedTransferPickupId && selectedTransferPickupId !== 'delete_all' && pendingPickups && pendingPickups.length > 0) {
                      const newPickup = allDeliveries.find(d => d.id === selectedTransferPickupId);
                      if (!newPickup) { toast.error('Selected pickup not found'); return; }
                      const newPuid = newPickup.stop_id;
                      const newPickupTR = parseInt(newPickup.tracking_number, 10);
                      const sortedPending = [...pendingPickups].sort((a, b) => (a.patient_name || '').localeCompare(b.patient_name || ''));
                      const updatePromises = sortedPending.map((pending, index) =>
                        base44.entities.Delivery.update(pending.id, {
                          puid: newPuid,
                          tracking_number: String(newPickupTR + index + 1),
                          ampm_deliveries: newPickup.ampm_deliveries
                        })
                      );
                      await Promise.all(updatePromises);
                      toast.success(`Transferred ${pendingPickups.length} pending stop(s)`);
                    }

                    if (delivery.status === 'in_transit' && delivery.cod_total_amount_required > 0 && delivery.patient_id) {
                      try {
                        await base44.functions.invoke('squareDeleteCodItem', { deliveryId: delivery.id, reason: 'delivery_deleted' });
                      } catch (squareError) {
                        console.error('⚠️ [Delete] Failed to delete Square COD item:', squareError);
                      }
                    }

                    await onDeleteDelivery(delivery.id);
                    setShowDeleteConfirm(false);
                    setSelectedTransferPickupId('');
                  } catch (error) {
                    console.error('Delete failed:', error);
                    toast.error(`Failed: ${error.message}`);
                  }
                }}>
                <Trash2 className="w-4 h-4 mr-2" />
                {availableTransferPickups.length === 0 ? 'Delete All' : selectedTransferPickupId && selectedTransferPickupId !== 'delete_all' ? 'Trans & Del' : 'Delete'}
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Return Confirmation Dialog */}
      {showReturnConfirm && returnPatient && ReactDOM.createPortal(
        <div
          className="fixed inset-0 flex items-center justify-center"
          style={{ background: 'rgba(0, 0, 0, 0.6)', zIndex: 999999, pointerEvents: 'auto' }}
          onClick={handleCancelReturn}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="rounded-lg shadow-xl p-6 max-w-md w-full mx-4" style={{ background: 'var(--bg-white)' }}>
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Undo2 className="w-5 h-5 text-orange-600" />
              Confirm Return Delivery
            </h3>

            <div className="space-y-3 mb-6 text-sm">
              <p className="text-slate-600">A new return delivery will be created with the following details:</p>
              <div className="rounded-lg p-3 space-y-2" style={{ background: 'var(--bg-slate-50)' }}>
                <div><span className="font-semibold" style={{ color: 'var(--text-slate-700)' }}>Return To: {returnPatient.full_name}</span></div>
                <div><span className="font-semibold" style={{ color: 'var(--text-slate-700)' }}>Address: {returnPatient.address || store?.address || 'N/A'}</span></div>
                <div><span className="font-semibold" style={{ color: 'var(--text-slate-700)' }}>Phone: {formatPhoneNumber(returnPatient.phone || store?.phone || 'N/A')}</span></div>
                <div><span className="font-semibold" style={{ color: 'var(--text-slate-700)' }}>Delivery Date: {delivery.delivery_date}</span></div>
                <div><span className="font-semibold" style={{ color: 'var(--text-slate-700)' }}>Assigned Driver: {getDriverDisplayName(driver) || 'N/A'}</span></div>
                <div>
                  <span className="font-semibold" style={{ color: 'var(--text-slate-700)' }}>Notes:</span>
                  <p className="text-xs" style={{ color: 'var(--text-slate-900)' }}>PATIENT RETURN</p>
                  <p className="text-xs" style={{ color: 'var(--text-slate-900)' }}>For: {patient?.full_name || delivery.patient_name || 'Unknown'}</p>
                </div>
                <div>
                  <span className="font-semibold" style={{ color: 'var(--text-slate-700)' }}>Tracking Number:</span>
                  <p className="italic" style={{ color: 'var(--text-slate-500)' }}>Will be assigned when saved</p>
                </div>
              </div>
            </div>

            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={handleCancelReturn} disabled={isCreatingReturn}>
                Cancel
              </Button>
              <Button className="flex-1 bg-orange-600 hover:bg-orange-700" onClick={handleConfirmReturn} disabled={isCreatingReturn}>
                {isCreatingReturn ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Undo2 className="w-4 h-4 mr-2" />}
                Create Return
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}