/**
 * Centralized device detection utility
 * Provides consistent device type and OS detection across the application
 */

/**
 * Detects if device is a tablet based on user agent
 * @returns {boolean} - true if tablet device
 */
export const isTablet = () => {
  const ua = navigator.userAgent;
  return /iPad|Android(?!.*Mobile)/i.test(ua);
};

/**
 * Detects device orientation
 * @returns {string} - 'portrait' or 'landscape'
 */
export const getOrientation = () => {
  return window.innerWidth < window.innerHeight ? 'portrait' : 'landscape';
};

/**
 * Determines if mobile layout should be used
 * Rules:
 * - Phones: always use mobile layout
 * - Tablets in portrait: use mobile layout
 * - Tablets in landscape: use desktop layout
 * - Desktop: use desktop layout
 * @returns {boolean} - true if mobile layout should be used
 */
export const shouldUseMobileLayout = () => {
  const ua = navigator.userAgent;
  const isTabletDevice = /iPad|Android(?!.*Mobile)/i.test(ua);
  const isPhone = /Android.*Mobile|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  
  // Phones always use mobile layout
  if (isPhone) return true;
  
  // Tablets: portrait = mobile, landscape = desktop
  if (isTabletDevice) {
    return getOrientation() === 'portrait';
  }
  
  // Desktop devices use desktop layout (but respect small screens)
  return window.innerWidth < 768;
};

/**
 * Detects device type and operating system from user agent and screen width
 * Wide-screen devices (> 525px = 1.75 × statscard width) are treated as desktop even if mobile user agent
 * @returns {Object} - { deviceType: 'Mobile'|'Desktop'|'Tablet', os: string }
 */
export const getUserAgentInfo = () => {
  const ua = navigator.userAgent;

  // Detect device type from user agent
  const isTabletDevice = /iPad|Android(?!.*Mobile)/i.test(ua);
  const isMobileUserAgent = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  
  // Touch capability check - any device with touch points is likely a phone/tablet
  const hasTouchScreen = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
  
  // Screen width threshold (1.75 × statscard width = 525px)
  const screenWidth = window.innerWidth;
  const MOBILE_THRESHOLD = 525;
  
  let deviceType = 'Desktop';
  if (isTabletDevice) {
    deviceType = 'Tablet';
  } else if (isMobileUserAgent) {
    // Mobile user agent → always Mobile, regardless of screen width
    deviceType = 'Mobile';
  } else if (hasTouchScreen && screenWidth <= MOBILE_THRESHOLD) {
    // Touch device within mobile screen size → Mobile
    deviceType = 'Mobile';
  }

  // Detect OS
  let os = 'Unknown OS';
  if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Mac OS X/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iOS|iPhone|iPad|iPod/i.test(ua)) os = 'iOS';

  return { deviceType, os };
};

/**
 * Simple check if current device is mobile
 * @returns {boolean} - true if mobile device
 */
export const isMobileDevice = () => {
  const { deviceType } = getUserAgentInfo();
  return deviceType === 'Mobile';
};

/**
 * Checks if device is mobile/tablet based ONLY on user agent (ignores screen width)
 * Used for theme decisions - allows dark mode on mobile devices including tablets
 * @returns {boolean} - true if mobile device (phones AND tablets)
 */
export const isMobileDeviceForTheme = () => {
  const ua = navigator.userAgent;
  // CRITICAL: Include both phones AND tablets for theme settings
  // Tablets get dark mode access but use desktop layout in landscape (via CSS media queries)
  const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  
  return isMobileDevice;
};