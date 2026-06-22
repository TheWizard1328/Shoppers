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

  // Single reliable threshold: below 850px = mobile layout, 850px+ = desktop/widescreen layout.
  // This avoids orientation-based guessing which breaks in editors, foldables, and split-screen.
  // - Phones (Android/iPhone): always mobile regardless of width
  // - Tablets portrait: always mobile
  // - Foldables unfolded / tablets landscape / desktop: only widescreen if >= 850px
  const WIDESCREEN_THRESHOLD = 850;
  const isLandscape = !isPortrait;
  const isWideScreenMobile = isPhysicalMobile && screenWidth >= WIDESCREEN_THRESHOLD;

  // The two flags everything should use
  const isMobile  = isPhysicalMobile && !isWideScreenMobile
                    ? true                                         // phone below threshold → always mobile
                    : isTabletPortrait                             // tablet portrait → mobile
                    ? true
                    : screenWidth < WIDESCREEN_THRESHOLD;         // anything (editor, foldable, desktop) below 850px → mobile
  const isDesktop = !isMobile;

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