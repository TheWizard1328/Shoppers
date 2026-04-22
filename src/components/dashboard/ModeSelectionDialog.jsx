import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Bike, Car, Footprints, Circle, MapPin } from 'lucide-react';

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
  const ModeIcon = modeLabel === 'Cycling'
    ? Bike
    : modeLabel === 'Walking'
      ? Footprints
      : modeLabel === 'Scootering'
        ? Circle
        : Car;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ModeIcon className="w-4 h-4" />
            {modeLabel} route options
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 p-3">
            <div className="text-sm font-medium text-slate-900">Nearby stops within 5 km</div>
            <div className="mt-3 space-y-2 max-h-72 overflow-y-auto pr-1">
              {nearbyStops.length === 0 && (
                <div className="text-sm text-slate-500">No nearby stops found for this mode.</div>
              )}

              {nearbyStops.map((stop) => {
                const checked = selectedStopIds.includes(stop.id);
                return (
                  <label
                    key={stop.id}
                    className="flex items-start gap-3 rounded-lg border border-slate-200 p-3 cursor-pointer hover:bg-slate-50"
                  >
                    <Checkbox checked={checked} onCheckedChange={() => onToggleStop(stop.id)} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-slate-900 truncate">{stop.label}</div>
                      <div className="text-xs text-slate-500 truncate">{stop.subtitle}</div>
                    </div>
                    <div className="text-xs font-medium text-slate-600 whitespace-nowrap">
                      {stop.distanceKm.toFixed(1)} km
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          <label className="flex items-center gap-3 rounded-xl border border-slate-200 p-3 cursor-pointer hover:bg-slate-50">
            <Checkbox checked={returnToCurrentLocation} onCheckedChange={onToggleReturn} />
            <div className="flex items-center gap-2 text-sm font-medium text-slate-900">
              <MapPin className="w-4 h-4" />
              Return to current location
            </div>
          </label>

          <Button
            onClick={onOptimize}
            disabled={isSubmitting || selectedStopIds.length === 0}
            className="w-full"
          >
            {isSubmitting ? 'Optimizing...' : 'Optimize Route'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}