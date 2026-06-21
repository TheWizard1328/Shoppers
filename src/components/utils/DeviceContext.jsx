/**
 * DeviceContext.jsx
 *
 * Single source of truth for device/layout type across the entire app.
 *
 * Rules:
 *   - Mobile phone           → isMobile = true
 *   - Tablet portrait        → isMobile = true  (mimics mobile)
 *   - Tablet landscape       → isDesktop = true (mimics desktop)
 *   - Desktop/laptop         → isDesktop = true
 *
 * Usage anywhere in the app:
 *   import { useDevice } from '@/components/utils/DeviceContext';
 *   const { isMobile, isDesktop, isTablet, isTabletPortrait, deviceType } = useDevice();
 *
 * Do NOT call isMobileDevice() or getUserAgentInfo() directly in components —
 * use this hook instead so all device checks share one consistent value.
 */

import React, { createContext, useContext, useState, useEffect } from 'react';
import { getUserAgentInfo } from './deviceUtils';

const DeviceContext = createContext(null);

export function DeviceProvider({ children }) {
  const { deviceType, os } = getUserAgentInfo();

  const isPhysicalMobile = deviceType === 'Mobile';
  const isTablet         = deviceType === 'Tablet';

  // Use matchMedia for orientation — more reliable than innerWidth/Height in iframes/editors
  const getIsPortrait = () => window.matchMedia('(orientation: portrait)').matches;

  // Track screen dimensions reactively so orientation changes on phones are detected
  const [screenWidth, setScreenWidth] = useState(() => window.innerWidth);
  const [screenHeight, setScreenHeight] = useState(() => window.innerHeight);
  const [isPortrait, setIsPortrait] = useState(() => getIsPortrait());

  // Tablet orientation — portrait mimics mobile, landscape mimics desktop
  const [isTabletPortrait, setIsTabletPortrait] = useState(() => {
    if (deviceType !== 'Tablet') return false;
    return getIsPortrait();
  });

  useEffect(() => {
    const mq = window.matchMedia('(orientation: portrait)');
    const handleChange = (e) => {
      const portrait = e.matches;
      setIsPortrait(portrait);
      setScreenWidth(window.innerWidth);
      setScreenHeight(window.innerHeight);
      if (deviceType === 'Tablet') {
        setIsTabletPortrait(portrait);
      }
    };
    // Also handle resize for edge cases (editor viewport resizing)
    const handleResize = () => {
      const portrait = getIsPortrait();
      setIsPortrait(portrait);
      setScreenWidth(window.innerWidth);
      setScreenHeight(window.innerHeight);
      if (deviceType === 'Tablet') {
        setIsTabletPortrait(portrait);
      }
    };
    mq.addEventListener('change', handleChange);
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);
    return () => {
      mq.removeEventListener('change', handleChange);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
    };
  }, [deviceType]);

  // Wide-screen / landscape override for phones:
  // Use matchMedia orientation as primary signal — works correctly in editor iframes too.
  const isLandscape = !isPortrait;
  const isWideScreenMobile = isPhysicalMobile && (isLandscape || screenWidth >= 768);

  // Stop-card width is ~300px. If the screen is narrower than 3 stop-cards wide (< 900px)
  // we force mobile layout regardless of device type — sidebar hides, mobile header/nav show.
  const STOP_CARD_WIDTH = 300;
  const isTooNarrowForSidebar = screenWidth < STOP_CARD_WIDTH * 3;

  // The two flags everything should use
  // isMobile = phone (narrow/portrait) OR tablet-portrait — NOT wide-screen mobile/landscape
  //          + any screen narrower than 3× stop-card width
  const isMobile  = (isPhysicalMobile && !isWideScreenMobile) || isTabletPortrait || isTooNarrowForSidebar;
  const isDesktop = !isMobile; // everything else is desktop

  const value = {
    isMobile,
    isDesktop,
    isTablet,
    isTabletPortrait,
    isTabletLandscape: isTablet && !isTabletPortrait,
    isWideScreenMobile,
    isLandscape,
    deviceType,   // raw: 'Mobile' | 'Tablet' | 'Desktop'
    os,
  };

  return (
    <DeviceContext.Provider value={value}>
      {children}
    </DeviceContext.Provider>
  );
}

/**
 * useDevice — the only hook components should use for device detection.
 * Throws if used outside <DeviceProvider>.
 */
export function useDevice() {
  const ctx = useContext(DeviceContext);
  if (!ctx) throw new Error('useDevice() must be used inside <DeviceProvider>');
  return ctx;
}

export default DeviceContext;