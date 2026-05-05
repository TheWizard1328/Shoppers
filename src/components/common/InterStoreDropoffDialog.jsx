import React from "react";
import ReactDOM from "react-dom";
import { Button } from "@/components/ui/button";

export default function InterStoreDropoffDialog({ open, delivery, match, onConfirm, onSkip, pickupPatientName, originatingStoreName }) {
  if (!open) return null;

  return ReactDOM.createPortal(
    <div className="fixed inset-0 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)', zIndex: 999999 }} onClick={onSkip}>
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4 space-y-4">
        <div>
          <h3 className="text-lg font-semibold">Create InterStore Drop-off?</h3>
          <p className="text-sm text-slate-600 mt-1">This completed stop looks like an InterStore Pickup.</p>
        </div>

        <div className="rounded-lg bg-slate-50 p-3 text-sm space-y-1">
          <div><span className="font-semibold">Pickup patient:</span> {pickupPatientName || '—'}</div>
          <div><span className="font-semibold">Originating store:</span> {originatingStoreName || '—'}</div>
        </div>

        {match ? (
          <div className="rounded-lg bg-slate-50 p-3 text-sm">
            <div><span className="font-semibold">Drop-off:</span> {match.full_name}</div>
            <div><span className="font-semibold">Address:</span> {match.address}</div>
          </div>
        ) : (
          <div className="rounded-lg bg-amber-50 text-amber-800 p-3 text-sm">
            No matching InterStore Drop-off / ISD patient was found for this pickup yet.
          </div>
        )}

        <div className="flex gap-3">
          <Button variant="outline" className="flex-1" onClick={onSkip}>No</Button>
          <Button className="flex-1" onClick={onConfirm} disabled={!match}>Yes, create</Button>
        </div>
      </div>
    </div>,
    document.body
  );
}