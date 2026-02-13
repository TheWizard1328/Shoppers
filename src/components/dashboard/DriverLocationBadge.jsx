import React, { useState, useEffect, useRef } from 'react';
import { format } from 'date-fns';

const DriverLocationBadge = ({ users = [] }) => {
  const [driverStatus, setDriverStatus] = useState({});
  const prevStateRef = useRef({});

  useEffect(() => {
    const handleLocationUpdate = (event) => {
      const { appUsers } = event.detail || {};
      
      if (!appUsers || appUsers.length === 0) return;

      const newStatus = {};
      
      appUsers.forEach(user => {
        // CRITICAL: Show all drivers with location timestamps for App Owners (regardless of duty status)
        if (!user || !user.location_updated_at) {
          return;
        }

        const userId = user.id;
        const prevState = prevStateRef.current[userId];
        
        const latChanged = !prevState || prevState.lat !== user.current_latitude;
        const lngChanged = !prevState || prevState.lng !== user.current_longitude;
        const timestampChanged = !prevState || prevState.timestamp !== user.location_updated_at;
        
        const coordsChanged = latChanged || lngChanged;
        
        let bulletColor = 'red'; // Both unchanged
        if (coordsChanged && timestampChanged) {
          bulletColor = 'green'; // Both changed
        } else if (timestampChanged) {
          bulletColor = 'yellow'; // Only timestamp changed
        }
        
        newStatus[userId] = {
          name: user.user_name || user.full_name || 'Unknown',
          lat: user.current_latitude,
          lng: user.current_longitude,
          timestamp: user.location_updated_at,
          bulletColor,
          status: user.driver_status,
          latChanged,
          lngChanged,
          timestampChanged,
          sortOrder: user.sort_order ?? Infinity
        };

        // Update previous state tracking
        prevStateRef.current[userId] = {
          lat: user.current_latitude,
          lng: user.current_longitude,
          timestamp: user.location_updated_at
        };
      });

      setDriverStatus(newStatus);
    };

    window.addEventListener('driverLocationsUpdated', handleLocationUpdate);
    return () => window.removeEventListener('driverLocationsUpdated', handleLocationUpdate);
  }, []);

  const drivers = Object.values(driverStatus).sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.name.localeCompare(b.name);
  });

  if (drivers.length === 0) {
    return null;
  }

  const bulletColorMap = {
    'red': '#EF4444',
    'yellow': '#FBBF24',
    'green': '#10B981'
  };

  return (
    <div className="px-4 py-2 space-y-1 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-700">
      {drivers.map((driver) => (
        <div key={driver.name} className="flex items-center gap-2 text-xs">
          <div
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ backgroundColor: bulletColorMap[driver.bulletColor] }}
          />
          <span className="font-medium text-slate-700 dark:text-slate-300" style={{ minWidth: '80px' }}>
            {driver.name}
          </span>
          <span>
            <span className={`transition-colors duration-300 ${driver.latChanged || driver.lngChanged ? 'text-green-500 font-semibold' : 'text-slate-600 dark:text-slate-400'}`}>
              {driver.lat?.toFixed(6) || '?'}
            </span>
            {', '}
            <span className={`transition-colors duration-300 ${driver.latChanged || driver.lngChanged ? 'text-green-500 font-semibold' : 'text-slate-600 dark:text-slate-400'}`}>
              {driver.lng?.toFixed(6) || '?'}
            </span>
          </span>
          <span className={`transition-colors duration-300 ${driver.timestampChanged ? 'text-green-500 font-semibold' : 'text-slate-500 dark:text-slate-400'}`} style={{ marginLeft: 'auto' }}>
            {driver.timestamp ? format(new Date(driver.timestamp), 'HH:mm:ss') : '?'}
          </span>
        </div>
      ))}
    </div>
  );
};

export default DriverLocationBadge;