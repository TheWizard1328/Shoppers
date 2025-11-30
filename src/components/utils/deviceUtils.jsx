/**
 * Centralized device detection utility
 * Provides consistent device type and OS detection across the application
 */

/**
 * Detects device type and operating system from user agent
 * @returns {Object} - { deviceType: 'Mobile'|'Desktop', os: string }
 */
export const getUserAgentInfo = () => {
  const ua = navigator.userAgent;

  // Detect device type
  const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  const deviceType = isMobileDevice ? 'Mobile' : 'Desktop';

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