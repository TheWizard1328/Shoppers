/**
 * DeviceContext.jsx
 *
 * Single source of truth for device/layout type across the entire app.
 *
 * Defined screen-ratio chrome modes (Sep 15, 2026):
 *   Mode 1 — Vertical (narrow) portrait, phones: mobile chrome
 *           (mobile header + bottom nav, sidebar as drawer).
 *   Mode 2 — Vertical (wide) portrait, foldables/tablets: same mobile
 *           chrome as Mode 1, roomier content.
 *   Mode 3 — Horizontal landscape on WIDE devices only (foldables/tablets,
 *           landscape height >= 480px): desktop chrome — persistent
 *           sidebar, no mobile header, no bottom nav.
 *   Phones in landscape keep the mobile chrome (Mode 1 behavior) — a rotated
 *   desktop layout for narrow screens was evaluated and rejected.
 *   Desktop browsers keep the plain width-driven responsive rule.
 *
 *   - Mobile phone portrait  → isMobile = true
 *   - Mobile phone landscape → isMobile = true (stays mobile)
 *   - Foldable portrait      → isMobile = true (Mode 2)
 *   - Foldable landscape     → isDesktop = true (Mode 3)
 *   - Tablet portrait        → isMobile = true  (mimics mobile)
 *   - Tablet landscape       → isDesktop = true (mimics desktop)
 *   - Desktop/laptop         → width-driven (>= 850px = desktop)
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

  // Thresholds: widescreen = 850px wide; a landscape screen qualifies for
  // desktop chrome only when it's also tall enough (foldables/tablets).
  // Short landscape screens are phones — they keep the mobile chrome.
  const WIDESCREEN_THRESHOLD = 850;
  const LANDSCAPE_DESKTOP_MIN_HEIGHT = 480;
  const isLandscape = !isPortrait;
  const isTouchDevice = isPhysicalMobile || isTablet;
  const isWideScreenMobile = isPhysicalMobile && screenWidth >= WIDESCREEN_THRESHOLD;
  const isLandscapeWide = isLandscape && screenHeight >= LANDSCAPE_DESKTOP_MIN_HEIGHT && screenWidth >= WIDESCREEN_THRESHOLD;

  // The two flags everything should use
  let isMobile;
  if (!isTouchDevice) {
    // Desktop / editor windows: unchanged, plain width-driven responsive layout
    isMobile = screenWidth < WIDESCREEN_THRESHOLD;
  } else if (isPortrait) {
    // Modes 1 & 2 — any touch device held vertically gets the mobile chrome
    isMobile = true;
  } else {
    // Mode 3 — landscape: desktop chrome only on wide devices (foldables/tablets).
    // Phones in landscape (short screens) stay mobile.
    isMobile = !isLandscapeWide;
  }
  const isDesktop = !isMobile;

  const value = {
    isMobile,
    isDesktop,
    isTablet,
    isTabletPortrait,
    isTabletLandscape: isTablet && !isTabletPortrait,
    isWideScreenMobile,
    isLandscape,
    isLandscapeWide,
    // Chrome mode consumed by Layout for the app-container class + CSS
    chromeMode: isMobile ? 'mobile' : 'desktop',
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