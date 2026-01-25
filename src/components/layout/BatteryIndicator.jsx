import React, { useState, useEffect } from 'react';
import { Battery, BatteryCharging, BatteryLow, BatteryMedium, BatteryFull } from 'lucide-react';

export default function BatteryIndicator({ vertical = false }) {
  const [batteryLevel, setBatteryLevel] = useState(null);
  const [isCharging, setIsCharging] = useState(false);

  useEffect(() => {
    // Only show on mobile devices and laptops, not desktop PCs
    const userAgent = navigator.userAgent.toLowerCase();
    const isMobileOrLaptop = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini|mobile|tablet/i.test(userAgent) ||
                             navigator.maxTouchPoints > 1 ||
                             window.innerWidth < 1024; // Treat narrow screens as mobile
    
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

  // Determine icon, color, and background based on battery level and charging status
  const getBatteryIcon = () => {
    const iconSize = vertical ? "w-4 h-4" : "w-6 h-6";
    
    if (isCharging) {
      return <BatteryCharging className={`${iconSize} text-white`} />;
    }

    if (batteryLevel <= 20) {
      return <BatteryLow className={`${iconSize} text-white`} />;
    } else if (batteryLevel <= 50) {
      return <BatteryMedium className={`${iconSize} text-white`} />;
    } else if (batteryLevel <= 80) {
      return <Battery className={`${iconSize} text-white`} />;
    } else {
      return <BatteryFull className={`${iconSize} text-white`} />;
    }
  };

  const getBackgroundColor = () => {
    if (isCharging) {
      return 'bg-green-500';
    }

    if (batteryLevel <= 20) {
      return 'bg-red-500';
    } else if (batteryLevel <= 50) {
      return 'bg-yellow-500';
    } else if (batteryLevel <= 80) {
      return 'bg-blue-500';
    } else {
      return 'bg-green-500';
    }
  };

  if (vertical) {
    return (
      <div 
        className={`flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg ${getBackgroundColor()}`} 
        title={`Battery: ${batteryLevel}%${isCharging ? ' (Charging)' : ''}`}
      >
        {getBatteryIcon()}
        <span className="text-[10px] font-bold text-white">{batteryLevel}%</span>
      </div>
    );
  }

  return (
    <div 
      className={`flex items-center gap-1.5 px-2 py-1 rounded-lg ${getBackgroundColor()}`} 
      title={`Battery: ${batteryLevel}%${isCharging ? ' (Charging)' : ''}`}
    >
      {getBatteryIcon()}
      <span className="text-xs font-bold text-white">{batteryLevel}%</span>
    </div>
  );
}