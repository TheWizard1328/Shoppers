import React from 'react';
import { Button } from '@/components/ui/button';
import { Bike, Car } from 'lucide-react';
import { normalizeTravelMode, updatePreferredTravelMode } from '@/components/dashboard/travelModeHelpers';

const modeConfig = {
  driving: { label: 'Driving', icon: Car },
  cycling: { label: 'Cycling', icon: Bike },
  pedestrian: { label: 'Walking', icon: Car },
};

export default function TravelModeButton({ currentUser, appUsers = [], value, onChange }) {
  const appUser = appUsers.find((user) => user?.user_id === currentUser?.id);
  const currentMode = normalizeTravelMode(value) === 'cycling' ? 'cycling' : 'driving';
  const isCycling = currentMode === 'cycling';
  const CurrentIcon = isCycling ? Bike : Car;

  const handleToggle = async () => {
    if (!appUser?.id) return;
    const nextValue = isCycling ? 'driving' : 'cycling';
    await updatePreferredTravelMode(appUsers, currentUser?.id, nextValue);
    onChange?.(nextValue);
  };

  if (!currentUser) return null;

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleToggle}
      className="h-8 gap-1.5 px-2 flex-shrink-0"
      style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}
      title={isCycling ? 'Cycling' : 'Driving'}
    >
      <CurrentIcon className="w-3.5 h-3.5" />
      <span className="text-xs">{isCycling ? 'Cycling' : 'Driving'}</span>
    </Button>
  );
}