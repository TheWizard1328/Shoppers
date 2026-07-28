import React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { RotateCcw, Loader2 } from "lucide-react";
import SpecialSymbolsBadges from "@/components/utils/SpecialSymbolsBadges";

export default function RestartConfirmDialog({ open, onClose, onConfirm, delivery, patient, store, isRestarting }) {
  if (!delivery) return null;

  const name = patient?.full_name || delivery.patient_name || delivery.delivery_id || "Unknown";
  const address = patient?.address || delivery.delivery_address || null;
  const phone = patient?.phone || delivery.phone || null;
  const notes = delivery.delivery_notes || delivery.delivery_instructions || null;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-sm mx-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <RotateCcw className="w-4 h-4 text-red-600" />
            Restart Delivery?
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-1">
          {/* Name + special symbols */}
          <div className="flex items-start justify-between gap-2">
            <p className="font-semibold text-slate-900 text-sm leading-tight">{name}</p>
            <SpecialSymbolsBadges
              delivery={delivery}
              patient={patient}
              isPickup={false}
              size="sm"
            />
          </div>

          {address && (
            <div className="text-xs text-slate-600">
              <span className="font-medium text-slate-700">Address: </span>{address}
            </div>
          )}

          {phone && (
            <div className="text-xs text-slate-600">
              <span className="font-medium text-slate-700">Phone: </span>
              <a href={`tel:${phone}`} className="text-blue-600 underline">{phone}</a>
            </div>
          )}

          {notes && (
            <div className="text-xs text-slate-600 bg-slate-50 rounded p-2 border border-slate-200">
              <span className="font-medium text-slate-700">Notes: </span>{notes}
            </div>
          )}

          <p className="text-xs text-slate-500 pt-1">
            This will move the delivery back to <strong>In Transit</strong> and place it as the next stop.
          </p>
        </div>

        <DialogFooter className="flex gap-2 pt-1">
          <Button variant="outline" size="sm" className="flex-1" onClick={onClose} disabled={isRestarting}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="flex-1 bg-red-600 hover:bg-red-700 text-white"
            onClick={onConfirm}
            disabled={isRestarting}
          >
            {isRestarting
              ? <Loader2 className="w-4 h-4 mr-1 animate-spin" />
              : <RotateCcw className="w-4 h-4 mr-1" />
            }
            Restart
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}