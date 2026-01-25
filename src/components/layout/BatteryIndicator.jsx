import React, { useState, useEffect } from 'react';
import { Battery, BatteryCharging, BatteryLow, BatteryMedium, BatteryFull } from 'lucide-react';

export default function BatteryIndicator({ vertical = false }) {
  const [batteryLevel, setBatteryLevel] = useState(null);
  const [isCharging, setIsCharging] = useState(false);

  useEffect(() => {
    // Only show on mobile devices and laptops, not desktop PCs
    const isMobileOrLaptop = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Tablet/i.test(navigator.userAgent) ||
                             (navigator.maxTouchPoints > 0 && navigator.maxTouchPoints > 1);
    
    if (!isMobileOrLaptop) {
      setBatteryLevel(null);
      return;
    }

    // Check if Battery Status API is supported
    if ('getBattery' in navigator) {
      navigator.getBattery().then((battery) => {
        // Set initial values
        setBatteryLevel(Math.round(battery.level * 100));
        setIsCharging(battery.charging);

        // Update on battery level change
        battery.addEventListener('levelchange', () => {
          setBatteryLevel(Math.round(battery.level * 100));
        });

        // Update on charging status change
        battery.addEventListener('chargingchange', () => {
          setIsCharging(battery.charging);
        });
      }).catch(() => {
        // Battery API not available
        setBatteryLevel(null);
      });
    }
  }, []);

  // Don't render if battery level is not available
  if (batteryLevel === null) return null;

  // Determine icon and color based on battery level and charging status
  const getBatteryIcon = () => {
    const iconSize = vertical ? "w-4 h-4" : "w-5 h-5";
    
    if (isCharging) {
      return <BatteryCharging className={`${iconSize} text-green-600`} />;
    }

    if (batteryLevel <= 20) {
      return <BatteryLow className={`${iconSize} text-red-600`} />;
    } else if (batteryLevel <= 50) {
      return <BatteryMedium className={`${iconSize} text-yellow-600`} />;
    } else if (batteryLevel <= 80) {
      return <Battery className={`${iconSize} text-slate-600`} />;
    } else {
      return <BatteryFull className={`${iconSize} text-green-600`} />;
    }
  };

  if (vertical) {
    return (
      <div className="flex flex-col items-center gap-0.5" title={`Battery: ${batteryLevel}%${isCharging ? ' (Charging)' : ''}`}>
        {getBatteryIcon()}
        <span className="text-[10px] font-medium text-slate-700">{batteryLevel}%</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1" title={`Battery: ${batteryLevel}%${isCharging ? ' (Charging)' : ''}`}>
      {getBatteryIcon()}
      <span className="text-xs font-medium text-slate-700">{batteryLevel}%</span>
    </div>
  );
}