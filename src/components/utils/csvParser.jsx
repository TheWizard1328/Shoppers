/**
 * Parses a single line of a CSV string, respecting quoted fields.
 * This robustly handles fields that contain commas and escaped double quotes ("").
 * @param {string} line - The CSV line to parse.
 * @returns {string[]} An array of strings representing the fields.
 */
export const parseCSVLine = (line) => {
  if (typeof line !== 'string' || line.trim() === '') {
    return [];
  }

  const fields = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (inQuotes) {
      // We are inside a quoted field
      if (char === '"') {
        if (i < line.length - 1 && line[i + 1] === '"') {
          // This is an escaped double quote (""), add a single " to the field
          currentField += '"';
          i++; // Skip the next character
        } else {
          // This is the closing quote for the field
          inQuotes = false;
        }
      } else {
        // A regular character inside a quoted field
        currentField += char;
      }
    } else {
      // We are not inside a quoted field
      if (char === '"') {
        // The start of a quoted field
        inQuotes = true;
      } else if (char === ',') {
        // A comma separator, push the completed field and start a new one
        fields.push(currentField);
        currentField = '';
      } else {
        // A regular character
        currentField += char;
      }
    }
  }

  // Add the last field to the array
  fields.push(currentField);

  return fields;
};