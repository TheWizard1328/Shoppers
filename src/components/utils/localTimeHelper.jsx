/**
 * Local Time Helper - Centralized utility for timestamp handling
 * 
 * CRITICAL: This app uses LOCAL device time for ALL timestamps, not UTC.
 * 
 * Why? Medical deliveries require accurate local time tracking for compliance,
 * documentation, and accurate ETA calculations. Using UTC causes confusion
 * and incorrect time displays when crossing timezones or syncing across devices.
 * 
 * RULES:
 * 1. NEVER use .toISOString() for actual_delivery_time or location_updated_at
 * 2. ALWAYS use getLocalTimestamp() for any time-based entity fields
 * 3. Timestamps are stored as: "YYYY-MM-DDTHH:MM:SS" (no 'Z' suffix)
 * 4. This format is treated as local time when parsed by new Date()
 * 
 * Usage Examples:
 * - Delivery completion: actual_delivery_time = getLocalTimestamp()
 * - Location updates: location_updated_at = getLocalTimestamp()
 * - Log entries: timestamp = getLocalTimestamp()
 * - Any field that needs current device time
 */

/**
 * Get current device time as a local timestamp string
 * Format: "YYYY-MM-DDTHH:MM:SS" (no timezone offset)
 * 
 * @returns {string} Local timestamp string
 */
export function getLocalTimestamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}

/**
 * Get local timestamp for a specific Date object
 * 
 * @param {Date} date - Date object to convert
 * @returns {string} Local timestamp string
 */
export function getLocalTimestampFromDate(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    throw new Error('Invalid date provided');
  }
  
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}

/**
 * Combine a date string (YYYY-MM-DD) with a time string (HH:MM) into local timestamp
 * 
 * @param {string} dateStr - Date string (YYYY-MM-DD)
 * @param {string} timeStr - Time string (HH:MM)
 * @returns {string} Local timestamp string
 */
export function combineToLocalTimestamp(dateStr, timeStr) {
  if (!dateStr || !timeStr) {
    throw new Error('Both dateStr and timeStr are required');
  }
  
  return `${dateStr}T${timeStr}:00`;
}

/**
 * Get current date string (YYYY-MM-DD) in local timezone
 * 
 * @returns {string} Local date string
 */
export function getLocalDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  
  return `${year}-${month}-${day}`;
}

/**
 * Get current time string (HH:MM) in local timezone
 * 
 * @returns {string} Local time string
 */
export function getLocalTimeString() {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  
  return `${hours}:${minutes}`;
}

/**
 * Parse a local timestamp string back to a Date object
 * This assumes the timestamp was created WITHOUT timezone offset
 * 
 * @param {string} localTimestamp - Local timestamp string
 * @returns {Date} Date object in local timezone
 */
export function parseLocalTimestamp(localTimestamp) {
  if (!localTimestamp) {
    return null;
  }

  const hasTimezoneSuffix = /Z$|[+-]\d{2}:\d{2}$/.test(localTimestamp);
  if (hasTimezoneSuffix) {
    return new Date(localTimestamp);
  }

  return new Date(localTimestamp);
}

export function parseEntityTimestamp(timestamp) {
  if (!timestamp) {
    return null;
  }

  const normalizedTimestamp = String(timestamp);
  const isUtcEntityTimestamp = /Z$|[+-]\d{2}:\d{2}$/.test(normalizedTimestamp);

  if (isUtcEntityTimestamp) {
    return new Date(normalizedTimestamp);
  }

  return parseLocalTimestamp(normalizedTimestamp);
}