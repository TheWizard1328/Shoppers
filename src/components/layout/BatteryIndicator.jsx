import React, { useState, useEffect } from 'react';
import { getCurrentDevice } from '../utils/deviceManager';
import { useUser } from '../utils/UserContext';

export default function BatteryIndicator({ vertical = false }) {
  const [batteryLevel, setBatteryLevel] = useState(null);
  const [isCharging, setIsCharging] = useState(false);
  const { currentUser } = useUser();

  useEffect(() => {
    const checkDeviceAndSetBattery = async () => {
      // Check if current device is Desktop type
      if (currentUser?.id) {
        const device = await getCurrentDevice(currentUser.id);
        if (device?.device_info?.device_type === 'Desktop') {
          setBatteryLevel(null);
          return;
        }
      }

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
      } else {
        setBatteryLevel(null);
      }
    };

    checkDeviceAndSetBattery();
  }, [currentUser?.id]);

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
  
  // Determine text color based on theme (dark mode = white, light mode = black)
  const getTextColor = () => {
    const isDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches || 
                       document.documentElement.classList.contains('dark');
    return isDarkMode ? '#ffffff' : '#000000';
  };

  if (vertical) {
    return (
      <div
        className="flex flex-col items-center gap-1"
        title={`Battery: ${batteryLevel}%${isCharging ? ' (Charging)' : ''}`}>
        <style>{`
          @keyframes marquee-fill {
            0% { height: 0%; }
            100% { height: ${batteryLevel}%; }
          }
          @keyframes pulse-gently {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.7; }
          }
          .charging-marquee {
            animation: marquee-fill 4s ease-in-out infinite;
          }
          .battery-pulse {
            animation: pulse-gently 4s ease-in-out infinite;
          }
        `}</style>

        {/* Battery bar (vertical) */}
        <div className="relative w-6 h-8 border-2 rounded" style={{ borderColor: 'var(--border-slate-300)', backgroundColor: 'var(--bg-slate-100)' }}>
          {/* Fill */}
          <div
            className={`absolute bottom-0 left-0 right-0 rounded transition-all duration-300 ${bg} ${isCharging && batteryLevel < 100 ? 'charging-marquee' : ''} ${isCharging && batteryLevel === 100 ? 'battery-pulse' : ''}`}
            style={{ height: `${batteryLevel}%` }}>
          </div>
          {/* Percentage text - always centered */}
          {batteryLevel > 15 && (
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-[8px] font-bold origin-center" style={{ transform: 'rotate(-90deg)', color: getTextColor() }}>{batteryLevel}%</span>
            </div>
          )}
        </div>
      </div>);
  }

  return (
    <div className="flex items-center ml-2"
      title={`Battery: ${batteryLevel}%${isCharging ? ' (Charging)' : ''}`}>
      <style>{`
        @keyframes marquee-fill-h {
          0% { width: 0%; }
          100% { width: ${batteryLevel}%; }
        }
        @keyframes pulse-gently {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.7; }
        }
        .charging-marquee-h {
          animation: marquee-fill-h 4s ease-in-out infinite;
        }
        .battery-pulse {
          animation: pulse-gently 4s ease-in-out infinite;
        }
      `}</style>

      {/* Battery bar (horizontal) */}
      <div className="relative w-16 h-5 border-2 rounded" style={{ borderColor: 'var(--border-slate-300)', backgroundColor: 'var(--bg-slate-100)' }}>
        {/* Fill */}
        <div
          className={`absolute left-0 top-0 bottom-0 rounded transition-all duration-300 ${bg} ${isCharging && batteryLevel < 100 ? 'charging-marquee-h' : ''} ${isCharging && batteryLevel === 100 ? 'battery-pulse' : ''}`}
          style={{ width: `${batteryLevel}%` }}>
        </div>
        {/* Percentage text - always centered */}
        {batteryLevel > 15 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[10px] font-bold" style={{ color: getTextColor() }}>{batteryLevel}%</span>
          </div>
        )}
      </div>
    </div>);

}