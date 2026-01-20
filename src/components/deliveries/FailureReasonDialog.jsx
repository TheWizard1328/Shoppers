import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
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
    'Customer Unavailable',
    'Address Not Found',
    'Refused by Customer',
    'Access Denied (Building/Gate)',
    'Incorrect Address',
    'Customer Requested Reschedule'
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

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-md z-[10020] border" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)' }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-600">
            <AlertCircle className="w-5 h-5" />
            <span style={{ color: 'var(--text-slate-900)' }}>
              {statusType === 'cancelled' ? 'Cancel' : 'Mark as Failed'} - {isPickup ? 'Pickup' : 'Delivery'}
            </span>
          </DialogTitle>
          <DialogDescription style={{ color: 'var(--text-slate-600)' }}>
            Please select a reason for marking this {isPickup ? 'pickup' : 'delivery'} as {statusType}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg p-3 border" style={{ background: 'var(--bg-slate-100)', borderColor: 'var(--border-slate-200)' }}>
            <p className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>{deliveryName}</p>
          </div>

          <div className="space-y-3">
            <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>
              Reason {isPickup && statusType === 'cancelled' ? 'for Cancellation' : 'for Failure'}:
            </Label>
            <RadioGroup value={selectedReason} onValueChange={setSelectedReason}>
              {failureReasons.map((reason) => (
                <div key={reason} className="flex items-center space-x-2">
                  <RadioGroupItem value={reason} id={reason} />
                  <Label htmlFor={reason} className="text-sm cursor-pointer" style={{ color: 'var(--text-slate-700)' }}>
                    {reason}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>
              Additional Notes (Optional):
            </Label>
            <Textarea
              value={additionalNotes}
              onChange={(e) => setAdditionalNotes(e.target.value)}
              placeholder="Add any additional details..."
              className="text-sm resize-none h-20"
            />
          </div>

          <div className="flex gap-3 pt-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={handleClose}
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
      </DialogContent>
    </Dialog>
  );
}