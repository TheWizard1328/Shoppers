/**
 * Centralized device detection utility
 * Provides consistent device type and OS detection across the application
 */

/**
 * Detects device type and operating system from user agent and screen width
 * Wide-screen devices (> 525px = 1.75 × statscard width) are treated as desktop even if mobile user agent
 * @returns {Object} - { deviceType: 'Mobile'|'Desktop', os: string }
 */
export const getUserAgentInfo = () => {
  const ua = navigator.userAgent;

  // Detect device type from user agent
  const isMobileUserAgent = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  
  // Override mobile detection for wide screens (1.75 × 300px statscard width = 525px)
  const screenWidth = window.innerWidth;
  const MOBILE_THRESHOLD = 525; // 1.75 × statscard width (300px)
  
  const deviceType = (isMobileUserAgent && screenWidth <= MOBILE_THRESHOLD) ? 'Mobile' : 'Desktop';

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
 * Used for theme decisions - allows dark mode on tablets regardless of screen size
 * @returns {boolean} - true if mobile/tablet user agent
 */
export const isMobileDeviceForTheme = () => {
  const ua = navigator.userAgent;
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
};