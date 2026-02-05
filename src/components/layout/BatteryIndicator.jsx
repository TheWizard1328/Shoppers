import React, { useState, useEffect } from 'react';
import { Zap } from 'lucide-react';

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

  // Determine color and fill based on battery level and charging status
  const getColorAndFill = () => {
    if (isCharging) {
      return { bg: 'bg-green-500', text: 'text-green-600' };
    }

    if (batteryLevel <= 20) {
      return { bg: 'bg-red-500', text: 'text-red-600' };
    } else if (batteryLevel <= 50) {
      return { bg: 'bg-yellow-500', text: 'text-yellow-600' };
    } else if (batteryLevel <= 80) {
      return { bg: 'bg-blue-500', text: 'text-blue-600' };
    } else {
      return { bg: 'bg-green-500', text: 'text-green-600' };
    }
  };

  const { bg, text } = getColorAndFill();
  
  // Determine text color that contrasts well with the fill
  const getTextColor = () => {
    if (batteryLevel <= 30) {
      return 'text-white';
    } else {
      return 'text-slate-900';
    }
  };

  if (vertical) {
    return (
      <div
        className="flex flex-col items-center gap-1"
        title={`Battery: ${batteryLevel}%${isCharging ? ' (Charging)' : ''}`}>

        {/* Battery bar (vertical) */}
        <div className="relative w-6 h-8 border-2 rounded" style={{ borderColor: 'var(--border-slate-300)', backgroundColor: 'var(--bg-slate-100)' }}>
          {/* Fill */}
          <div
            className={`absolute bottom-0 left-0 right-0 rounded transition-all duration-300 ${bg} flex items-center justify-center`}
            style={{ height: `${batteryLevel}%` }}>
            {batteryLevel > 15 && (
              <span className={`text-[8px] font-bold ${getTextColor()} origin-center`} style={{ transform: 'rotate(-90deg)' }}>{batteryLevel}%</span>
            )}
          </div>
          
          {/* Charging indicator */}
          {isCharging && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Zap className="w-3 h-3 text-white animate-pulse" />
            </div>
          )}
        </div>
      </div>);
  }

  return (
    <div className="flex items-center ml-2"
      title={`Battery: ${batteryLevel}%${isCharging ? ' (Charging)' : ''}`}>

      {/* Battery bar (horizontal) */}
      <div className="relative w-16 h-5 border-2 rounded" style={{ borderColor: 'var(--border-slate-300)', backgroundColor: 'var(--bg-slate-100)' }}>
        {/* Fill */}
        <div
          className={`absolute left-0 top-0 bottom-0 rounded transition-all duration-300 ${bg} flex items-center justify-center`}
          style={{ width: `${batteryLevel}%` }}>
          {batteryLevel > 15 && (
            <span className={`text-[10px] font-bold ${getTextColor()}`}>{batteryLevel}%</span>
          )}
        </div>
        
        {/* Charging indicator */}
        {isCharging && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Zap className="w-3 h-3 text-white animate-pulse" />
          </div>
        )}
      </div>
    </div>);

}