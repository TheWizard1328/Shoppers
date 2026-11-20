import React, { useState } from 'react';
import AppBottomSheet from '@/components/common/AppBottomSheet';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { AlertCircle } from 'lucide-react';

export default function FailureReasonDialog({ 
  isOpen, 
  onClose, 
  onConfirm, 
  deliveryName,
  isPickup = false,
  statusType = 'failed' // 'failed' or 'cancelled'
}) {
  const [selectedReason, setSelectedReason] = useState('');
  const [additionalNotes, setAdditionalNotes] = useState('');

  // Reset state when dialog opens/closes
  React.useEffect(() => {
    if (!isOpen) {
      setSelectedReason('');
      setAdditionalNotes('');
    }
  }, [isOpen]);

  const failureReasons = isPickup ? [
    'No Deliveries',
    'Store Closed',
    'Items Not Ready',
    'Store Requested Cancellation'
  ] : [
    // OWNER (Nov 20 2026): RxDeliver moves patients, not customers — the fail
    // dialog says Patient. The stored reason string is what lands in
    // delivery_notes, so keep the wording identical everywhere it is read.
    'Patient Unavailable',
    'Address Not Found',
    'Refused by Patient',
    'Access Denied (Building/Gate)',
    'Incorrect Address',
    'Patient Requested Reschedule'
  ];

  const handleConfirm = () => {
    if (!selectedReason) {
      alert('Please select a reason');
      return;
    }

    const fullReason = additionalNotes 
      ? `${selectedReason} - ${additionalNotes}`
      : selectedReason;

    onConfirm(fullReason);
    
    // Reset state
    setSelectedReason('');
    setAdditionalNotes('');
  };

  const handleClose = () => {
    setSelectedReason('');
    setAdditionalNotes('');
    onClose();
  };

  // OWNER (Nov 20 2026): this is a slide-up sheet now, same one the Bulk Edit
  // panel uses (AppBottomSheet): slides from the bottom, floats above the nav,
  // fade covers only the header-to-nav band, no dead padding under the buttons.
  return (
    <AppBottomSheet open={isOpen} onOpenChange={(v) => { if (!v) handleClose(); }} zIndex={10020} className="border-t" style={{ borderColor: 'var(--border-slate-300)' }}>
      <div className="flex flex-col min-h-0">
        <div className="px-4 pt-4 pb-2 flex-shrink-0">
          <h2 className="flex items-center gap-2 text-red-600 text-body font-semibold">
            <AlertCircle className="w-5 h-5" />
            <span>{statusType === 'cancelled' ? 'Cancel' : 'Mark as Failed'} - {isPickup ? 'Pickup' : 'Delivery'}</span>
          </h2>
          <p className="text-label mt-1">
            Please select a reason for marking this {isPickup ? 'pickup' : 'delivery'} as {statusType}.
          </p>
        </div>

        <div className="space-y-4 px-4 pb-4 overflow-y-auto min-h-0 flex-1">
          <div className="rounded-lg p-3 border border-surface" style={{ background: 'var(--bg-slate-100)' }}>
            <p className="text-sm font-semibold text-body">{deliveryName}</p>
          </div>

          <div className="space-y-3">
            <Label className="text-sm font-semibold text-body">
              Reason {isPickup && statusType === 'cancelled' ? 'for Cancellation' : 'for Failure'}:
            </Label>
            <RadioGroup value={selectedReason} onValueChange={setSelectedReason}>
              {failureReasons.map((reason) => (
                <div key={reason} className="flex items-center space-x-2">
                  <RadioGroupItem value={reason} id={reason} />
                  <Label htmlFor={reason} className="text-sm cursor-pointer text-body-2">
                    {reason}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium text-body">
              Additional Notes (Optional):
            </Label>
            <Textarea
              value={additionalNotes}
              onChange={(e) => setAdditionalNotes(e.target.value)}
              placeholder="Add any additional details..."
              className="text-sm resize-none h-20"
              autoFocus={false}
            />
          </div>

        </div>

        {/* Buttons live outside the scroll area so they are always reachable. */}
        <div className="flex gap-3 px-4 pt-2 pb-3 flex-shrink-0 border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
          <Button
            variant="outline"
            className="flex-1 text-body bg-surface"
            onClick={handleClose}
            style={{ borderColor: 'var(--border-slate-300)' }}
          >
            Cancel
          </Button>
          <Button
            className="flex-1 bg-red-600 hover:bg-red-700 text-white"
            onClick={handleConfirm}
            disabled={!selectedReason}
          >
            Confirm {statusType === 'cancelled' ? 'Cancellation' : 'Failure'}
          </Button>
        </div>
      </div>
    </AppBottomSheet>
  );
}