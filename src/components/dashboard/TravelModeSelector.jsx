import React from 'react';
import { Bike, ChevronDown, Circle } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { TRAVEL_MODE_OPTIONS, updatePreferredTravelMode } from '@/components/dashboard/travelModeHelpers';

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

export default function TravelModeSelector({ currentUser, appUsers = [], value, onChange, className = '' }) {
  const appUser = appUsers.find((user) => user?.user_id === currentUser?.id);

  const handleValueChange = async (nextValue) => {
    if (!appUser?.id) return;
    await updatePreferredTravelMode(appUsers, currentUser?.id, nextValue);
    onChange?.(nextValue);
  };

  if (!currentUser) return null;

  const CurrentIcon = value === 'cycling' ? Bike : DrivingWheelIcon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={`h-8 px-2 gap-1.5 flex-shrink-0 ${className}`}
          style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}
          title="Travel mode"
        >
          <CurrentIcon className="w-4 h-4" />
          <ChevronDown className="w-3.5 h-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-[10001]">
        {TRAVEL_MODE_OPTIONS.map((option) => {
          const OptionIcon = option.value === 'cycling' ? Bike : DrivingWheelIcon;
          const isActive = value === option.value;
          return (
            <DropdownMenuItem key={option.value} onClick={() => handleValueChange(option.value)} className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <OptionIcon className="w-4 h-4" />
                <span>{option.label}</span>
              </div>
              {isActive ? <Circle className="w-2.5 h-2.5 fill-current" /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}