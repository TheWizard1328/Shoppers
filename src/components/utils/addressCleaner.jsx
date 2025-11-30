/**
 * Utility functions for cleaning and formatting delivery addresses
 */

/**
 * Remove buzzer numbers from an address string
 * Handles various formats like "Buzz 123", "Buzzer: 456", "Buz 789", etc.
 */
export const cleanBuzzerFromAddress = (address) => {
  if (!address || typeof address !== 'string') return '';
  
  return address
    // Remove common buzzer patterns (case insensitive, with various separators)
    .replace(/,?\s*buzz(?:er)?[\s:.-]*\d+/gi, '') // "buzz 123", "buzzer: 456", "buzz.789"
    .replace(/,?\s*buz[\s:.-]*\d+/gi, '') // "buz 123", "buz: 456"
    .replace(/\(\s*buzz(?:er)?[\s:.-]*\d+\s*\)/gi, '') // "(buzz 123)", "(buzzer: 456)"
    // Clean up any resulting extra commas, spaces, or dashes
    .replace(/,\s*,/g, ',') // Remove double commas
    .replace(/\s{2,}/g, ' ') // Replace multiple spaces with single space
    .replace(/^[,\s-]+|[,\s-]+$/g, '') // Trim leading/trailing commas, spaces, dashes
    .trim();
};

/**
 * Clean unit number to remove buzzer information
 * Extracts only the actual unit/apt number, removing buzzer codes
 */
export const cleanUnitNumber = (unitNumber) => {
  if (!unitNumber || typeof unitNumber !== 'string') return '';
  
  // Remove buzzer patterns from unit number
  let cleaned = unitNumber
    .replace(/,?\s*buzz(?:er)?[\s:.-]*\d+/gi, '') // Remove "buzz 123", "buzzer: 456"
    .replace(/,?\s*buz[\s:.-]*\d+/gi, '') // Remove "buz 123"
    .trim();
  
  // If the entire unit number was just buzzer info, return empty
  if (!cleaned) return '';
  
  return cleaned;
};

/**
 * Format an address with a unit number
 * Also cleans buzzer numbers from both the address and unit number
 */
export const formatAddressWithUnit = (address, unitNumber) => {
  if (!address) return '';
  
  // First clean buzzer numbers from address
  let cleanAddress = cleanBuzzerFromAddress(address);
  
  // Take only the first part before comma (street address)
  cleanAddress = cleanAddress.split(',')[0].trim();
  
  // Clean the unit number to remove any buzzer info
  const cleanUnit = cleanUnitNumber(unitNumber);
  
  if (cleanUnit) {
    return `${cleanAddress}, #${cleanUnit}`;
  }
  return cleanAddress;
};