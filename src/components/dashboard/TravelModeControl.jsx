import React from 'react';
import { Button } from '@/components/ui/button';
import { Bike, Car } from 'lucide-react';
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
  const currentMode = normalizeTravelMode(value) === 'cycling' ? 'cycling' : 'driving';
  const isCycling = currentMode === 'cycling';
  const CurrentIcon = isCycling ? Bike : Car;

  const handleClick = async () => {
    if (disabled || !currentUser) return;
    const nextMode = getNextModeValue(currentMode);
    if (nextMode === 'cycling') {
      onDialogOpenChange?.(true);
      return;
    }
    await updatePreferredTravelMode(appUsers, currentUser.id, nextMode);
    onChange?.(nextMode);
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
        title={disabled ? 'Available during active route only' : isCycling ? 'Cycling' : 'Driving'}
      >
        <CurrentIcon className="w-3.5 h-3.5" />
        <span className="text-xs">{isCycling ? 'Cycling' : 'Driving'}</span>
      </Button>

      <ModeSelectionDialog
        open={dialogOpen}
        onOpenChange={onDialogOpenChange}
        modeLabel="Cycling"
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