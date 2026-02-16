/**
 * Utility functions for generating unique IDs for patients and deliveries
 */

/**
 * Validates if an ID matches the expected format (alphanumeric, case-sensitive)
 * @param {string} id - The ID to validate
 * @param {number} length - Expected length
 * @returns {boolean}
 */
export const validateId = (id, length) => {
  if (!id || typeof id !== 'string') return false;
  const alphanumericRegex = new RegExp(`^[A-Za-z0-9]{${length}}$`); // Case-sensitive alphanumeric
  return alphanumericRegex.test(id);
};

/**
 * Formats an ID by trimming and removing invalid characters (preserves case)
 * @param {string} id - The ID to format
 * @returns {string}
 */
export const formatId = (id) => {
  if (!id) return '';
  return id.trim().replace(/[^A-Za-z0-9]/g, ''); // Keep both upper and lowercase
};

/**
 * Generates a unique patient ID (PID) - case-sensitive alphanumeric
 * @param {string[]} existingIds - Array of existing patient IDs to avoid duplicates
 * @returns {string} - A new unique 5-character ID (e.g., "Ab12X")
 */
export const generatePatientId = (existingIds = []) => {
  const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; // Mixed case, excluding confusing chars
  const length = 5;
  const maxAttempts = 100;
  
  // Normalize existing IDs for comparison
  const existingSet = new Set(existingIds.map(id => String(id).trim()));
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let newId = '';
    for (let i = 0; i < length; i++) {
      newId += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    
    // Case-sensitive check
    if (!existingSet.has(newId)) {
      return newId;
    }
  }
  
  // Fallback with timestamp if we can't generate unique after maxAttempts
  const timestamp = Date.now().toString(36).slice(-5);
  return timestamp.padStart(length, characters.charAt(0));
};

/**
 * Generates a unique delivery ID (DID)
 * @param {string[]} existingIds - Array of existing delivery IDs to avoid duplicates
 * @returns {string} - A new unique delivery ID (e.g., "DID-Ab12X")
 */
export const generateDeliveryId = (existingIds = []) => {
  const patientId = generatePatientId(existingIds.map(id => id.replace('DID-', '')));
  return `DID-${patientId}`;
};

/**
 * Generates a unique stop ID for a delivery
 * @param {Array} allDeliveries - Array of all deliveries to check for existing stop IDs
 * @param {string} deliveryDate - The date for which to generate the stop ID
 * @returns {string} - A new unique stop ID
 */
export const generateStopId = (deliveryDate = '', allDeliveries = []) => {
  if (!deliveryDate) {
    deliveryDate = new Date().toISOString().split('T')[0];
  }
  
  // Ensure allDeliveries is an array
  const deliveriesArray = Array.isArray(allDeliveries) ? allDeliveries : [];
  
  // Get existing stop IDs for this date
  const existingStopIds = deliveriesArray
    .filter(d => d && d.delivery_date === deliveryDate && d.delivery_stop_id)
    .map(d => d.delivery_stop_id);
  
  // Generate a simple sequential number
  let counter = 1;
  let stopId = `${deliveryDate}-${String(counter).padStart(3, '0')}`;
  
  while (existingStopIds.includes(stopId) && counter < 1000) {
    counter++;
    stopId = `${deliveryDate}-${String(counter).padStart(3, '0')}`;
  }
  
  return stopId;
};