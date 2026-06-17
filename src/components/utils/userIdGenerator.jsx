/**
 * Generates a unique system user ID
 * Format: [2-char City Code][3 random alphanumeric]
 * Example: EDa2X
 * 
 * @param {string} cityName - The name of the city
 * @param {Array<string>} existingIds - Array of existing system_user_id strings to check for uniqueness
 * @returns {string} A unique 5-character user ID
 */
export const generateSystemUserId = (cityName, existingIds = []) => {
  if (!cityName || typeof cityName !== 'string') {
    throw new Error('City name (string) is required to generate system user ID');
  }

  // Get first 2 characters of city name (uppercase)
  const cityCode = cityName.substring(0, 2).toUpperCase();

  // Characters for random part (uppercase, lowercase, and numbers)
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  // Convert existingIds to a Set for faster lookup
  const existingIdsSet = new Set(
    Array.isArray(existingIds) ? existingIds.filter(id => id && typeof id === 'string') : []
  );

  // Generate unique ID
  let attempts = 0;
  const maxAttempts = 1000;
  
  while (attempts < maxAttempts) {
    // Generate 3 random characters
    let randomPart = '';
    for (let i = 0; i < 3; i++) {
      randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    
    const newId = cityCode + randomPart;
    
    // Check if this ID already exists
    if (!existingIdsSet.has(newId)) {
      return newId;
    }
    
    attempts++;
  }

  throw new Error(`Failed to generate unique system user ID after ${maxAttempts} attempts`);
};

/**
 * Validates a system user ID format
 * @param {string} id - The ID to validate
 * @returns {boolean} True if valid, false otherwise
 */
export const validateSystemUserId = (id) => {
  if (!id || typeof id !== 'string') return false;
  
  // Must be exactly 5 characters
  if (id.length !== 5) return false;
  
  // First 2 chars must be uppercase letters
  if (!/^[A-Z]{2}/.test(id.substring(0, 2))) return false;
  
  // Last 3 chars must be alphanumeric (case-sensitive)
  if (!/^[A-Za-z0-9]{3}$/.test(id.substring(2))) return false;
  
  return true;
};

/**
 * Formats a system user ID to ensure proper casing
 * @param {string} id - The ID to format
 * @returns {string} Formatted ID
 */
export const formatSystemUserId = (id) => {
  if (!id || typeof id !== 'string') return '';
  
  // City code (first 2 chars) should be uppercase
  const cityCode = id.substring(0, 2).toUpperCase();
  // Random part (last 3 chars) keeps its original case
  const randomPart = id.substring(2, 5);
  
  return cityCode + randomPart;
};

/**
 * Extracts the city code from a system user ID
 * @param {string} id - The system user ID
 * @returns {string} The 2-character city code
 */
export const getCityCodeFromUserId = (id) => {
  if (!id || typeof id !== 'string' || id.length < 2) return '';
  return id.substring(0, 2).toUpperCase();
};