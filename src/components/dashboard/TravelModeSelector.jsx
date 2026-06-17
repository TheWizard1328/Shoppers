import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { TRAVEL_MODE_OPTIONS, updatePreferredTravelMode } from '@/components/dashboard/travelModeHelpers';

export default function TravelModeSelector({ currentUser, appUsers = [], value, onChange }) {
  const appUser = appUsers.find((user) => user?.user_id === currentUser?.id);

  const handleValueChange = async (nextValue) => {
    if (!appUser?.id) return;
    await updatePreferredTravelMode(appUsers, currentUser?.id, nextValue);
    onChange?.(nextValue);
  };

  if (!currentUser) return null;

  return (
    <div className="flex items-center gap-2 rounded-lg border bg-white/90 px-3 py-2 shadow-sm">
      <Label className="text-xs font-semibold text-slate-600">Mode</Label>
      <Select value={value} onValueChange={handleValueChange}>
        <SelectTrigger className="h-9 w-[140px] border-0 bg-transparent px-0 shadow-none focus:ring-0">
          <SelectValue placeholder="Travel mode" />
        </SelectTrigger>
        <SelectContent>
          {TRAVEL_MODE_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}