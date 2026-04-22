import React from 'react';
import { Button } from '@/components/ui/button';
import { Bike, Car, Footprints, Circle } from 'lucide-react';
import ModeSelectionDialog from '@/components/dashboard/ModeSelectionDialog';
import { getNextModeValue } from '@/components/dashboard/modeButtonHelpers';
import { normalizeTravelMode, updatePreferredTravelMode } from '@/components/dashboard/travelModeHelpers';

export default function TravelModeControl({
  currentUser,
  appUsers = [],
  value,
  onChange,
  disabled = false,
  dialogOpen = false,
  onDialogOpenChange,
  nearbyStops = [],
  selectedStopIds = [],
  onToggleStop,
  returnToCurrentLocation = false,
  onToggleReturn,
  onOptimize,
  isSubmitting = false,
}) {
  const currentMode = normalizeTravelMode(value);
  const CurrentIcon = currentMode === 'cycling'
    ? Bike
    : currentMode === 'pedestrian'
      ? Footprints
      : currentMode === 'scootering'
        ? Circle
        : Car;

  const handleClick = async () => {
    if (disabled || !currentUser) return;
    onDialogOpenChange?.(true);
  };

  if (!currentUser) return null;

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={handleClick}
        disabled={disabled}
        className="h-8 gap-1.5 px-2 flex-shrink-0"
        style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}
        title={disabled ? 'Available during active route only' : currentMode === 'cycling' ? 'Cycling' : currentMode === 'pedestrian' ? 'Walking' : currentMode === 'scootering' ? 'Scootering' : 'Driving'}
      >
        <CurrentIcon className="w-3.5 h-3.5" />
        <span className="text-xs">{currentMode === 'cycling' ? 'Cycling' : currentMode === 'pedestrian' ? 'Walking' : currentMode === 'scootering' ? 'Scootering' : 'Driving'}</span>
      </Button>

      <ModeSelectionDialog
        open={dialogOpen}
        onOpenChange={onDialogOpenChange}
        modeLabel={currentMode === 'cycling' ? 'Cycling' : currentMode === 'pedestrian' ? 'Walking' : currentMode === 'scootering' ? 'Scootering' : 'Driving'}
        nearbyStops={nearbyStops}
        selectedStopIds={selectedStopIds}
        onToggleStop={onToggleStop}
        returnToCurrentLocation={returnToCurrentLocation}
        onToggleReturn={onToggleReturn}
        onOptimize={onOptimize}
        isSubmitting={isSubmitting}
      />
    </>
  );
}