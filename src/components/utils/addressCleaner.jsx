/**
 * Utility functions for cleaning and formatting delivery addresses
 */

/**
 * Abbreviate compass direction words in an address to their uppercase letter equivalents.
 * Handles full words and compound directions (case-insensitive, whole-word only):
 *   Northwest → NW, Northeast → NE, Southwest → SW, Southeast → SE
 *   North → N, South → S, East → E, West → W
 *
 * Order matters: compound directions must be matched BEFORE single-word directions
 * so "Northwest" doesn't become "NW" via two passes.
 */
export const abbreviateAddressDirections = (address) => {
  if (!address || typeof address !== 'string') return address || '';
  return address
    // Compound directions first
    .replace(/\bnorthwest\b/gi, 'NW')
    .replace(/\bnortheast\b/gi, 'NE')
    .replace(/\bsouthwest\b/gi, 'SW')
    .replace(/\bsoutheast\b/gi, 'SE')
    // Single directions after
    .replace(/\bnorth\b/gi, 'N')
    .replace(/\bsouth\b/gi, 'S')
    .replace(/\beast\b/gi, 'E')
    .replace(/\bwest\b/gi, 'W');
};

/**
 * Normalize street type words in an address:
 *   Street → St, Avenue → Ave, Road → Rd, Boulevard → Blvd, Crescent → Cres
 * Whole-word, case-insensitive matches only.
 */
export const normalizeStreetTypes = (address) => {
  if (!address || typeof address !== 'string') return address || '';
  return address
    .replace(/\bstreet\b/gi, 'St')
    .replace(/\bavenue\b/gi, 'Ave')
    .replace(/\broad\b/gi, 'Rd')
    .replace(/\bboulevard\b/gi, 'Blvd')
    .replace(/\bcrescent\b/gi, 'Cres');
};

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

  // Abbreviate compass directions (North → N, Northwest → NW, etc.)
  cleanAddress = abbreviateAddressDirections(cleanAddress);

  // Normalize street types (Street → St, Avenue → Ave, Road → Rd, etc.)
  cleanAddress = normalizeStreetTypes(cleanAddress);
  
  // Clean the unit number to remove any buzzer info
  const cleanUnit = cleanUnitNumber(unitNumber);
  
  if (cleanUnit) {
    return `${cleanAddress}, #${cleanUnit}`;
  }
  return cleanAddress;
};