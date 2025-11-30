/**
 * Formats a phone number to standard format: (XXX) XXX-XXXX
 * Handles various input formats including international numbers
 */
export const formatPhoneNumber = (phoneNumber) => {
  if (!phoneNumber) return '';
  
  // Remove all non-digit characters
  const cleaned = phoneNumber.replace(/\D/g, '');
  
  // Handle different lengths
  if (cleaned.length === 10) {
    // US/Canada format: (XXX) XXX-XXXX
    return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
  } else if (cleaned.length === 11 && cleaned[0] === '1') {
    // US/Canada with country code: +1 (XXX) XXX-XXXX
    return `+1 (${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`;
  } else if (cleaned.length > 10) {
    // International format: keep as is but add spacing
    return `+${cleaned}`;
  }
  
  // Return original if doesn't match expected formats
  return phoneNumber;
};

/**
 * Formats phone number for storage (removes formatting)
 */
export const cleanPhoneNumber = (phoneNumber) => {
  if (!phoneNumber) return '';
  return phoneNumber.replace(/\D/g, '');
};

/**
 * Validates if a phone number is valid
 */
export const isValidPhoneNumber = (phoneNumber) => {
  if (!phoneNumber) return true; // Empty is valid (optional field)
  const cleaned = cleanPhoneNumber(phoneNumber);
  return cleaned.length >= 10 && cleaned.length <= 15;
};