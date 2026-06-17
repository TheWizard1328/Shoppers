import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Bike, Car } from 'lucide-react';
import { normalizeTravelMode, updatePreferredTravelMode } from '@/components/dashboard/travelModeHelpers';

const modeConfig = {
  driving: { label: 'Driving', icon: Car },
  cycling: { label: 'Cycling', icon: Bike },
  pedestrian: { label: 'Walking', icon: Car },
};

export default function TravelModeButton({ currentUser, appUsers = [], value, onChange, disabled = false, selectedDriverId }) {
  // Target the selected driver if provided and different from current user, otherwise fall back to current user
  const targetUserId = (selectedDriverId && selectedDriverId !== 'all') ? selectedDriverId : currentUser?.id;
  const appUser = appUsers.find((user) => user?.user_id === targetUserId);
  const [optimisticMode, setOptimisticMode] = useState(normalizeTravelMode(value));
  const currentMode = optimisticMode;
  const isCycling = currentMode === 'cycling';
  const isWalking = currentMode === 'pedestrian';
  const CurrentIcon = isCycling ? Bike : Car;

  useEffect(() => {
    if (value) setOptimisticMode(normalizeTravelMode(value));
  }, [value]);

  const handleToggle = async () => {
    if (disabled || !appUser?.id) return;
    const nextValue = isCycling ? 'driving' : 'cycling';
    setOptimisticMode(nextValue);
    window.dispatchEvent(new CustomEvent('driverTravelModeChanged', {
      detail: { driverId: targetUserId, travelMode: nextValue }
    }));
    onChange?.(nextValue);
    await updatePreferredTravelMode(appUsers, targetUserId, nextValue);
  };

  if (!currentUser) return null;

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleToggle}
      disabled={disabled}
      className="h-8 w-8 p-0 flex-shrink-0"
      style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}
      title={disabled ? 'Available during active route only' : isWalking ? 'Walking' : isCycling ? 'Cycling' : 'Driving'}
    >
      <CurrentIcon className="w-3.5 h-3.5" />
    </Button>
  );
}