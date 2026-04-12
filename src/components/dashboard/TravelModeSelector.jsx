import React from 'react';
import { Bike } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { updatePreferredTravelMode } from '@/components/dashboard/travelModeHelpers';

function DrivingWheelIcon({ className = '' }) {
  return (
    <div className={`relative h-4 w-4 rounded-full border-2 border-current ${className}`}>
      <div className="absolute left-1/2 top-[2px] h-[5px] w-[2px] -translate-x-1/2 rounded-full bg-current" />
      <div className="absolute left-[3px] top-[7px] h-[2px] w-[4px] rotate-[28deg] rounded-full bg-current" />
      <div className="absolute right-[3px] top-[7px] h-[2px] w-[4px] -rotate-[28deg] rounded-full bg-current" />
      <div className="absolute left-1/2 top-1/2 h-[3px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-current" />
    </div>
  );
}

export default function TravelModeSelector({ currentUser, appUsers = [], value, onChange }) {
  const appUser = appUsers.find((user) => user?.user_id === currentUser?.id);

  const handleToggle = async () => {
    if (!appUser?.id) return;
    const nextValue = value === 'cycling' ? 'driving' : 'cycling';
    await updatePreferredTravelMode(appUsers, currentUser?.id, nextValue);
    onChange?.(nextValue);
  };

  if (!currentUser) return null;

  const CurrentIcon = value === 'cycling' ? Bike : DrivingWheelIcon;
  const label = value === 'cycling' ? 'Cycling' : 'Driving';

  return (
    <Button
      variant="default"
      size="sm"
      onClick={handleToggle}
      className="bg-emerald-600 hover:bg-emerald-700 text-white px-2 text-sm font-medium rounded-md inline-flex min-h-11 min-w-11 items-center justify-center whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring shadow gap-2 h-6 flex-shrink-0"
      title="Toggle travel mode"
    >
      <CurrentIcon className="w-4 h-4" />
      {label}
    </Button>
  );
}