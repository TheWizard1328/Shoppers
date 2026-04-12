import React from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Bike, Car, ChevronDown } from 'lucide-react';
import { normalizeTravelMode, updatePreferredTravelMode } from '@/components/dashboard/travelModeHelpers';

const modeConfig = {
  driving: { label: 'Driving', icon: Car },
  cycling: { label: 'Cycling', icon: Bike },
  pedestrian: { label: 'Walking', icon: Car },
};

export default function TravelModeButton({ currentUser, appUsers = [], value, onChange }) {
  const appUser = appUsers.find((user) => user?.user_id === currentUser?.id);
  const currentMode = normalizeTravelMode(value);
  const CurrentIcon = modeConfig[currentMode]?.icon || Car;

  const handleSelect = async (nextValue) => {
    if (!appUser?.id) return;
    await updatePreferredTravelMode(appUsers, currentUser?.id, nextValue);
    onChange?.(nextValue);
  };

  if (!currentUser) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 px-2 flex-shrink-0"
          style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}
        >
          <CurrentIcon className="w-3.5 h-3.5" />
          <ChevronDown className="w-3 h-3 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-[10001]">
        {Object.entries(modeConfig).map(([mode, config]) => {
          const Icon = config.icon;
          return (
            <DropdownMenuItem key={mode} onClick={() => handleSelect(mode)}>
              <Icon className="w-4 h-4" />
              {config.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}