import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export const TRANSPORT_MODE_OPTIONS = [
  { value: 'driving', label: 'Driving' },
  { value: 'cycling', label: 'Cycling' },
  { value: 'pedestrian', label: 'Walking' }
];

export default function TransportModeSelector({ value = 'driving', onChange, disabled = false, className = '' }) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className={`w-[140px] bg-white ${className}`.trim()}>
        <SelectValue placeholder="Mode" />
      </SelectTrigger>
      <SelectContent>
        {TRANSPORT_MODE_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}