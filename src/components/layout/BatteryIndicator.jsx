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
  // Theme detection — follows the APP theme only (html dark/dark-theme classes,
  // set for both explicit Dark and Auto+system-dark by useAutoThemeSync).
  // FIX (Oct 21 2026): previously read the OS prefers-color-scheme FIRST, so a PC
  // set to OS-dark rendered white battery text while the app itself was Light.
  const [isDarkMode, setIsDarkMode] = useState(() =>
    document.documentElement.classList.contains('dark-theme') ||
    document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      const dark = root.classList.contains('dark-theme') || root.classList.contains('dark');
      setIsDarkMode(prev => prev === dark ? prev : dark);
    });
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  if (batteryLevel === null) return null;

  const textColor = isDarkMode ? '#ffffff' : '#000000';

  // Determine fill color based on battery level and charging status.
  // In dark mode while charging, use a darker green (green-700) so the white
  // percentage text stays legible against the fill instead of washing out.
  const getColorAndFill = () => {
    if (isCharging) {
      return { bg: isDarkMode ? 'bg-green-700' : 'bg-green-500' };
    }

    if (batteryLevel <= 20) {
      return { bg: 'bg-red-500' };
    } else if (batteryLevel <= 50) {
      return { bg: 'bg-yellow-500' };
    } else if (batteryLevel <= 80) {
      return { bg: 'bg-blue-500' };
    } else {
      return { bg: 'bg-green-500' };
    }
  };

  const { bg } = getColorAndFill();

  if (vertical) {
    return (
      <div
        className="flex flex-col items-center gap-1"
        title={`Battery: ${batteryLevel}%${isCharging ? ' (Charging)' : ''}`}>
        {/* OWNER FIX (Oct 22 2026): charging marquee/pulse animations REMOVED.
            They animated height/width at 60fps nonstop while plugged in,
            forcing continuous style/layout/paint work on the dashboard. The
            fill is now static and simply updates (300ms transition) whenever
            the Battery API fires levelchange. */}

        {/* Battery bar (vertical) */}
        <div className="relative w-6 h-8 border-2 rounded" style={{ borderColor: 'var(--border-slate-300)', backgroundColor: 'var(--bg-slate-100)' }}>
          {/* Fill */}
          <div
            className={`absolute bottom-0 left-0 right-0 rounded transition-all duration-300 ${bg}`}
            style={{ height: `${batteryLevel}%` }}>
          </div>
          {/* Percentage text - always centered */}
          {batteryLevel > 15 && (
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-[8px] font-bold origin-center" style={{ transform: 'rotate(-90deg)', color: textColor }}>{batteryLevel}%</span>
            </div>
          )}
        </div>
      </div>);
  }

  return (
    <div className="flex items-center ml-2"
      title={`Battery: ${batteryLevel}%${isCharging ? ' (Charging)' : ''}`}>
      {/* Charging animations removed (Oct 22 2026) — see vertical branch note. */}

      {/* Battery bar (horizontal) */}
      <div className="relative w-16 h-5 border-2 rounded" style={{ borderColor: 'var(--border-slate-300)', backgroundColor: 'var(--bg-slate-100)' }}>
        {/* Fill */}
        <div
          className={`absolute left-0 top-0 bottom-0 rounded transition-all duration-300 ${bg}`}
          style={{ width: `${batteryLevel}%` }}>
        </div>
        {/* Percentage text - always centered */}
        {batteryLevel > 15 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[10px] font-bold" style={{ color: textColor }}>{batteryLevel}%</span>
          </div>
        )}
      </div>
    </div>);

}