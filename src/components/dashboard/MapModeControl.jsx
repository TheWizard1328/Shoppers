import React from 'react';
import { Button } from '@/components/ui/button';
import { Navigation, Users, MapPin } from 'lucide-react';

export default function MapModeControl({ mapMode, onMapModeChange, disabled = false }) {
  if (disabled) return null;

  return (
    <div className="absolute top-4 right-4 z-[1000] bg-white rounded-lg shadow-lg p-2 flex gap-2">
      <Button
        variant={mapMode === 'auto-follow' ? 'default' : 'outline'}
        size="sm"
        onClick={() => onMapModeChange('auto-follow')}
        disabled={disabled}
        className="gap-2"
      >
        <Navigation className="w-4 h-4" />
        Auto Follow
      </Button>
      
      <Button
        variant={mapMode === 'all-drivers' ? 'default' : 'outline'}
        size="sm"
        onClick={() => onMapModeChange('all-drivers')}
        disabled={disabled}
        className="gap-2"
      >
        <Users className="w-4 h-4" />
        All Drivers
      </Button>
      
      <Button
        variant={mapMode === 'all-stops' ? 'default' : 'outline'}
        size="sm"
        onClick={() => onMapModeChange('all-stops')}
        disabled={disabled}
        className="gap-2"
      >
        <MapPin className="w-4 h-4" />
        All Stops
      </Button>
    </div>
  );
}