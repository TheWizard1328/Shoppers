import React from "react";
import ReactDOM from "react-dom";
import { Button } from "@/components/ui/button";
import { Undo2, Loader2 } from "lucide-react";
import { formatPhoneNumber } from '../utils/phoneFormatter';
import { getDriverDisplayName } from '../utils/driverUtils';

// Parse the returned-patient names listed in an existing return stop's notes
// ("For: A" + "And: B" lines) for display in merge mode.
function parseReturnNames(notes) {
  const lines = String(notes || '').split('\n');
  const names = [];
  for (const line of lines) {
    const m = line.match(/^\s*(?:For|And):\s*(.+)$/i);
    if (m && m[1].trim()) names.push(m[1].trim());
  }
  return names;
}

export default function StopCardReturnDialog({
  showReturnConfirm,
  returnPatient,
  existingReturn,
  handleCancelReturn,
  handleConfirmReturn,
  isCreatingReturn,
  store,
  delivery,
  driver,
  patient
}) {
  if (!showReturnConfirm || !returnPatient) return null;

  const isMerge = Boolean(existingReturn);
  const existingNames = isMerge ? parseReturnNames(existingReturn.delivery_notes) : [];
  const addingName = patient?.full_name || delivery.patient_name || 'Unknown';
  const alreadyListed = isMerge && existingNames.some((n) => n.toLowerCase() === String(addingName).toLowerCase());

  return ReactDOM.createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ background: 'rgba(0, 0, 0, 0.6)', zIndex: 999999, pointerEvents: 'auto' }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        className="rounded-lg shadow-xl p-6 max-w-md w-full mx-4 bg-card"
      >
        <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Undo2 className="w-5 h-5 text-orange-600" />
          {isMerge ? 'Add To Existing Return' : 'Confirm Return Delivery'}
        </h3>

        <div className="space-y-3 mb-6 text-sm">
          <p className="text-slate-600 dark:text-slate-400">
            {isMerge
              ? 'Your route already has an incomplete return stop for this store. This patient will be added to it:'
              : 'A new return delivery will be created with the following details:'}
          </p>
          <div className="rounded-lg p-3 space-y-2" style={{ background: 'var(--bg-slate-50)' }}>
            <div><span className="font-semibold text-secondary">Return To: {returnPatient.full_name}</span></div>
            <div><span className="font-semibold text-secondary">Address: {returnPatient.address || store?.address || 'N/A'}</span></div>
            <div><span className="font-semibold text-secondary">Phone: {formatPhoneNumber(returnPatient.phone || store?.phone || 'N/A')}</span></div>
            {isMerge ? (
              <>
                <div><span className="font-semibold text-secondary">Existing Return Stop: Stop {existingReturn.stop_order ?? '—'}</span></div>
                <div>
                  <span className="font-semibold text-secondary">Patients On This Return:</span>
                  {existingNames.length > 0
                    ? existingNames.map((name) => <p key={name} className="text-xs text-body">{name}</p>)
                    : <p className="text-xs italic text-muted">None listed</p>}
                </div>
                <div>
                  <span className="font-semibold text-secondary">Adding:</span>
                  <p className="text-xs text-body">And: {addingName}{alreadyListed ? ' (already on this return)' : ''}</p>
                </div>
                <p className="text-xs italic text-muted">No new stop is created — the route is not re-optimized.</p>
              </>
            ) : (
              <>
                <div><span className="font-semibold text-secondary">Delivery Date: {delivery.delivery_date}</span></div>
                <div><span className="font-semibold text-secondary">Assigned Driver: {getDriverDisplayName(driver) || 'N/A'}</span></div>
                <div>
                  <span className="font-semibold text-secondary">Notes:</span>
                  <p className="text-xs text-body">PATIENT RETURN</p>
                  <p className="text-xs text-body">For: {patient?.full_name || delivery.patient_name || 'Unknown'}</p>
                </div>
                <div>
                  <span className="font-semibold text-secondary">Tracking Number:</span>
                  <p className="italic text-muted">Will be assigned when saved</p>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="flex gap-3">
          <Button variant="outline" className="flex-1" onClick={handleCancelReturn} disabled={isCreatingReturn}>
            Cancel
          </Button>
          <Button className="flex-1 bg-orange-600 hover:bg-orange-700" onClick={handleConfirmReturn} disabled={isCreatingReturn}>
            {isCreatingReturn ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Undo2 className="w-4 h-4 mr-2" />}
            {isMerge ? 'Add To Return' : 'Create Return'}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}