/**
 * Date Utilities - Consistent Local Date Handling
 * 
 * CRITICAL: All date parsing ensures dates are interpreted in the LOCAL timezone,
 * not UTC, to prevent day-of-week shifts and incorrect date comparisons.
 */

import { format, parseISO, differenceInDays, isValid } from 'date-fns';

/**
 * Parse a date string or Date object into a consistent Date object
 * CRITICAL FIX: Forces YYYY-MM-DD strings to be interpreted as LOCAL dates at noon
 * to avoid UTC timezone shifts that would change the day of week.
 * 
 * @param {string|Date|null|undefined} dateInput - Date string (YYYY-MM-DD, ISO 8601) or Date object
 * @returns {Date|null} - Parsed Date object in local timezone, or null if invalid
 */
export const parseDate = (dateInput) => {
  if (!dateInput) {
    return null;
  }

  // If already a Date object, return as-is
  if (dateInput instanceof Date) {
    return isValid(dateInput) ? dateInput : null;
  }

  // If not a string, cannot parse
  if (typeof dateInput !== 'string') {
    return null;
  }

  try {
    const trimmedInput = dateInput.trim();

    // CRITICAL: Handle YYYY-MM-DD format by forcing local timezone interpretation
    // The issue: new Date('2025-10-24') interprets as UTC midnight, which can shift to previous day in local time
    // The fix: Append 'T12:00:00' to force local timezone interpretation at noon (avoids DST midnight issues)
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmedInput)) {
      const localDateString = `${trimmedInput}T12:00:00`;
      const date = new Date(localDateString);
      
      if (!isNaN(date.getTime())) {
        // Set to midnight local time for consistency
        date.setHours(0, 0, 0, 0);
        return date;
      }
      return null;
    }

    // Handle ISO 8601 datetime strings (YYYY-MM-DDTHH:mm:ss or with Z/timezone)
    if (trimmedInput.includes('T')) {
      const date = parseISO(trimmedInput);
      return isValid(date) ? date : null;
    }

    // Fallback: Try direct Date constructor
    const date = new Date(trimmedInput);
    if (!isNaN(date.getTime())) {
      return date;
    }

    return null;
  } catch (error) {
    console.warn('[dateUtils] Failed to parse date:', dateInput, error.message);
    return null;
  }
};

/**
 * Convert a Date object to YYYY-MM-DD string format (local date)
 * 
 * @param {Date|string|null} dateInput - Date to convert
 * @returns {string|null} - Date string in YYYY-MM-DD format, or null if invalid
 */
export const toDateString = (dateInput) => {
  if (!dateInput) {
    return null;
  }

  try {
    const date = dateInput instanceof Date ? dateInput : parseDate(dateInput);
    
    if (!date || !isValid(date)) {
      return null;
    }

    // Use date-fns format which respects local timezone
    return format(date, 'yyyy-MM-dd');
  } catch (error) {
    console.warn('[dateUtils] Failed to convert to date string:', dateInput, error.message);
    return null;
  }
};

/**
 * Calculate the number of days between two dates
 * 
 * @param {Date|string} startDate - Start date
 * @param {Date|string} endDate - End date
 * @returns {number|null} - Number of days between dates, or null if invalid
 */
export const daysBetween = (startDate, endDate) => {
  try {
    const start = startDate instanceof Date ? startDate : parseDate(startDate);
    const end = endDate instanceof Date ? endDate : parseDate(endDate);

    if (!start || !end || !isValid(start) || !isValid(end)) {
      return null;
    }

    return Math.abs(differenceInDays(end, start));
  } catch (error) {
    console.warn('[dateUtils] Failed to calculate days between:', startDate, endDate, error.message);
    return null;
  }
};

/**
 * Get the day of week name from a date (using local timezone)
 * @param {Date|string} dateInput - Date to get day from
 * @returns {string|null} - 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', or null if invalid
 */
export const getDayOfWeek = (dateInput) => {
  try {
    const date = dateInput instanceof Date ? dateInput : parseDate(dateInput);
    
    if (!date || !isValid(date)) {
      return null;
    }

    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    return days[date.getDay()]; // getDay() returns 0-6 in local timezone
  } catch (error) {
    console.warn('[dateUtils] Failed to get day of week:', dateInput, error.message);
    return null;
  }
};

/**
 * Format a date for display (e.g., "Oct 24, 2025")
 * 
 * @param {Date|string} dateInput - Date to format
 * @param {string} formatString - date-fns format string (default: 'MMM d, yyyy')
 * @returns {string|null} - Formatted date string, or null if invalid
 */
export const formatDate = (dateInput, formatString = 'MMM d, yyyy') => {
  try {
    const date = dateInput instanceof Date ? dateInput : parseDate(dateInput);
    
    if (!date || !isValid(date)) {
      return null;
    }

    return format(date, formatString);
  } catch (error) {
    console.warn('[dateUtils] Failed to format date:', dateInput, error.message);
    return null;
  }
};

/**
 * Check if a date is today (local timezone)
 * 
 * @param {Date|string} dateInput - Date to check
 * @returns {boolean} - True if date is today
 */
export const isToday = (dateInput) => {
  try {
    const date = dateInput instanceof Date ? dateInput : parseDate(dateInput);
    
    if (!date || !isValid(date)) {
      return false;
    }

    const today = new Date();
    return toDateString(date) === toDateString(today);
  } catch (error) {
    return false;
  }
};

/**
 * Get today's date as a Date object (midnight local time)
 * 
 * @returns {Date} - Today's date at midnight
 */
export const getToday = () => {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
};

/**
 * Get today's date as a YYYY-MM-DD string
 * 
 * @returns {string} - Today's date in YYYY-MM-DD format
 */
export const getTodayString = () => {
  return toDateString(getToday());
};