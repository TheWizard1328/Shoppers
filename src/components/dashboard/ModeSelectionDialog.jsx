import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { isMobileDevice } from '@/components/utils/deviceUtils';

const STATUS_STYLES = {
  en_route:   { label: 'En Route',   bg: 'bg-blue-500',   text: 'text-white' },
  in_transit: { label: 'In Transit', bg: 'bg-green-600',  text: 'text-white' },
  pending:    { label: 'Pending',    bg: 'bg-amber-300',  text: 'text-amber-900' },
};

function StatusBadge({ status }) {
  const style = STATUS_STYLES[status] || { label: status, bg: 'bg-slate-200', text: 'text-slate-700' };
  return (
    <span className={`inline-flex items-center rounded-full px-3 py-0.5 text-sm font-semibold ${style.bg} ${style.text}`}>
      {style.label}
    </span>
  );
}

export default function ModeSelectionDialog({
  open,
  onOpenChange,
  modeLabel,
  nearbyStops = [],
  selectedStopIds = [],
  onToggleStop,
  returnToCurrentLocation,
  onToggleReturn,
  onOptimize,
  isSubmitting = false,
}) {
  const isMobile = isMobileDevice();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={
          isMobile
            ? 'fixed inset-x-0 bottom-0 top-auto w-full max-w-full rounded-t-2xl rounded-b-none p-0 border-0 shadow-2xl'
            : 'sm:max-w-md rounded-2xl p-0 overflow-hidden shadow-2xl'
        }
        style={isMobile ? { margin: 0 } : {}}
      >
        {/* Header */}
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border">
          <DialogTitle className="text-xl font-bold text-foreground">
            Select Stops for Cycling Mode
          </DialogTitle>
        </DialogHeader>

        {/* Stop list */}
        <div className="max-h-[55vh] overflow-y-auto divide-y divide-border">
          {nearbyStops.length === 0 && (
            <div className="px-6 py-8 text-sm text-muted-foreground text-center">
              No active or pending stops found within 5 km.
            </div>
          )}

          {nearbyStops.map((stop) => {
            const checked = selectedStopIds.includes(stop.id);
            return (
              <label
                key={stop.id}
                className="flex items-center gap-4 px-6 py-4 cursor-pointer hover:bg-muted/40 transition-colors"
              >
                {/* Text + badge */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-base font-bold text-foreground">{stop.label}</span>
                    <StatusBadge status={stop.status} />
                  </div>
                  <div className="flex items-center gap-1 mt-1">
                    <span className="text-sm text-muted-foreground">Distance</span>
                    <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-sm font-medium text-foreground ml-1">
                      {stop.distanceKm != null ? `${stop.distanceKm.toFixed(1)} km` : '— km'}
                    </span>
                  </div>
                </div>

                {/* Checkbox */}
                <Checkbox
                  checked={checked}
                  onCheckedChange={() => onToggleStop(stop.id)}
                  className="h-5 w-5 shrink-0 rounded-md border-2 border-slate-300 data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600"
                />
              </label>
            );
          })}
        </div>

        {/* Footer buttons */}
        <div className="flex gap-3 px-6 py-4 border-t border-border">
          <Button
            variant="outline"
            onClick={() => onOpenChange?.(false)}
            disabled={isSubmitting}
            className="flex-1 h-12 rounded-xl text-base font-bold border-2"
          >
            Cancel
          </Button>
          <Button
            onClick={onOptimize}
            disabled={isSubmitting || selectedStopIds.length === 0}
            className="flex-1 h-12 rounded-xl text-base font-bold bg-blue-600 hover:bg-blue-700 text-white border-0"
          >
            {isSubmitting ? 'Processing…' : 'Continue'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}