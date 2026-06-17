import React from "react";
import ReactDOM from "react-dom";
import { Button } from "@/components/ui/button";
import { Undo2, Loader2 } from "lucide-react";
import { formatPhoneNumber } from '../utils/phoneFormatter';
import { getDriverDisplayName } from '../utils/driverUtils';

export default function StopCardReturnDialog({
  showReturnConfirm,
  returnPatient,
  handleCancelReturn,
  handleConfirmReturn,
  isCreatingReturn,
  store,
  delivery,
  driver,
  patient
}) {
  if (!showReturnConfirm || !returnPatient) return null;

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
        className="rounded-lg shadow-xl p-6 max-w-md w-full mx-4"
        style={{ background: 'var(--bg-white)' }}
      >
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
  );
}