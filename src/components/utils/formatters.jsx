import { format } from "date-fns";

/**
 * Formats a phone number to standard format: (XXX) XXX-XXXX
 */
export const formatPhoneNumber = (phoneNumber) => {
  if (!phoneNumber) return '';
  
  // Remove all non-digit characters
  const cleaned = ('' + phoneNumber).replace(/\D/g, '');
  
  // Handle 10-digit US/Canada format
  if (cleaned.length === 10) {
    const match = cleaned.match(/^(\d{3})(\d{3})(\d{4})$/);
    if (match) {
      return `(${match[1]}) ${match[2]}-${match[3]}`;
    }
  }
  
  // Handle 11-digit with country code
  if (cleaned.length === 11 && cleaned[0] === '1') {
    const match = cleaned.match(/^1(\d{3})(\d{3})(\d{4})$/);
    if (match) {
      return `+1 (${match[1]}) ${match[2]}-${match[3]}`;
    }
  }
  
  // Return original if doesn't match expected formats
  return phoneNumber;
};

/**
 * Formats an address with unit number using # symbol
 */
export const formatAddressWithUnit = (address, unitNumber) => {
  if (!address) return '';
  if (!unitNumber) return address;
  // Use # instead of "Unit"
  return `${address} #${unitNumber}`;
};

/**
 * Formats a date string for display
 */
export const formatDate = (dateString, formatString = 'MMM d, yyyy') => {
  if (!dateString) return '';
  try {
    // Add time component to avoid timezone issues
    return format(new Date(dateString + 'T12:00:00'), formatString);
  } catch (error) {
    return dateString;
  }
};