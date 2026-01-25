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

  // Determine color based on battery level and charging status
  const getColor = () => {
    if (isCharging) {
      return 'text-green-600';
    }

    if (batteryLevel <= 20) {
      return 'text-red-600';
    } else if (batteryLevel <= 50) {
      return 'text-yellow-600';
    } else if (batteryLevel <= 80) {
      return 'text-blue-600';
    } else {
      return 'text-green-600';
    }
  };

  const getBatteryIcon = () => {
    const iconSize = vertical ? "w-6 h-4" : "w-10 h-5";
    const colorClass = getColor();

    if (isCharging) {
      return <BatteryCharging className={`${iconSize} ${colorClass}`} />;
    }

    if (batteryLevel <= 20) {
      return <BatteryLow className={`${iconSize} ${colorClass}`} />;
    } else if (batteryLevel <= 50) {
      return <BatteryMedium className={`${iconSize} ${colorClass}`} />;
    } else if (batteryLevel <= 80) {
      return <Battery className={`${iconSize} ${colorClass}`} />;
    } else {
      return <BatteryFull className={`${iconSize} ${colorClass}`} />;
    }
  };

  if (vertical) {
    return (
      <div
        className="flex flex-col items-center"
        title={`Battery: ${batteryLevel}%${isCharging ? ' (Charging)' : ''}`}>

        {getBatteryIcon()}
        <span className={`text-[10px] font-bold ${getColor()}`}>{batteryLevel}%</span>
      </div>);

  }

  return (
    <div className="flex items-center"

    title={`Battery: ${batteryLevel}%${isCharging ? ' (Charging)' : ''}`}>

      {getBatteryIcon()}
      <span className={`text-xs font-bold ${getColor()}`}>{batteryLevel}%</span>
    </div>);

}