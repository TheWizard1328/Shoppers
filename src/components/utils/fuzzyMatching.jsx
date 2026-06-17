// Fuzzy matching utilities for delivery data import

// Normalize text for comparison (lowercase, trim, remove extra spaces)
export const normalizeText = (text) => {
  if (!text) return '';
  return String(text).toLowerCase().trim().replace(/\s+/g, ' ');
};

// Normalize phone number (remove all non-digits)
export const normalizePhone = (phone) => {
  if (!phone) return '';
  return String(phone).replace(/\D/g, '');
};

// Simple string similarity using Levenshtein distance
export const calculateStringSimilarity = (str1, str2) => {
  if (!str1 || !str2) return 0;
  
  const s1 = normalizeText(str1);
  const s2 = normalizeText(str2);
  
  if (s1 === s2) return 100;
  
  // Levenshtein distance calculation
  const len1 = s1.length;
  const len2 = s2.length;
  const matrix = [];
  
  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  
  const distance = matrix[len1][len2];
  const maxLen = Math.max(len1, len2);
  const similarity = maxLen === 0 ? 100 : ((maxLen - distance) / maxLen) * 100;
  
  return Math.round(similarity);
};

// Parse time string to minutes from midnight for comparison
export const parseTimeToMinutes = (timeString) => {
  if (!timeString) return null;
  
  try {
    // Handle full datetime strings
    const date = new Date(timeString);
    if (!isNaN(date.getTime())) {
      return date.getHours() * 60 + date.getMinutes();
    }
    
    // Handle HH:MM format
    const match = String(timeString).match(/(\d{1,2}):(\d{2})/);
    if (match) {
      const hours = parseInt(match[1], 10);
      const minutes = parseInt(match[2], 10);
      return hours * 60 + minutes;
    }
  } catch (e) {
    console.warn('Failed to parse time:', timeString, e);
  }
  
  return null;
};

// Calculate fuzzy match score between imported delivery and existing delivery
export const calculateFuzzyMatchScore = (importedData, existingDelivery, patients) => {
  let score = 0;
  const details = [];
  
  // Get patient data for existing delivery
  const existingPatient = patients.find(p => p.id === existingDelivery.patient_id);
  
  // CRITERION 1: Patient Name Similarity (max 30 points)
  if (importedData.patient_name && existingPatient?.full_name) {
    const nameSimilarity = calculateStringSimilarity(importedData.patient_name, existingPatient.full_name);
    if (nameSimilarity === 100) {
      score += 30;
      details.push('✓ Exact name match (+30)');
    } else if (nameSimilarity >= 85) {
      score += 20;
      details.push(`✓ High name similarity ${nameSimilarity}% (+20)`);
    } else if (nameSimilarity >= 70) {
      score += 10;
      details.push(`~ Moderate name similarity ${nameSimilarity}% (+10)`);
    }
  }
  
  // CRITERION 2: Address Similarity (max 25 points)
  if (importedData.address && existingPatient?.address) {
    const addressSimilarity = calculateStringSimilarity(importedData.address, existingPatient.address);
    if (addressSimilarity === 100) {
      score += 25;
      details.push('✓ Exact address match (+25)');
    } else if (addressSimilarity >= 85) {
      score += 15;
      details.push(`✓ High address similarity ${addressSimilarity}% (+15)`);
    } else if (addressSimilarity >= 70) {
      score += 8;
      details.push(`~ Moderate address similarity ${addressSimilarity}% (+8)`);
    }
  }
  
  // CRITERION 3: Phone Number Match (max 20 points)
  if (importedData.phone && existingPatient?.phone) {
    const normalizedImportPhone = normalizePhone(importedData.phone);
    const normalizedExistingPhone = normalizePhone(existingPatient.phone);
    if (normalizedImportPhone && normalizedExistingPhone && normalizedImportPhone === normalizedExistingPhone) {
      score += 20;
      details.push('✓ Phone number match (+20)');
    }
  }
  
  // CRITERION 4: Store ID Match (max 15 points)
  if (importedData.store_id && existingDelivery.store_id && importedData.store_id === existingDelivery.store_id) {
    score += 15;
    details.push('✓ Store match (+15)');
  }
  
  // CRITERION 5: Tracking Number Match (max 10 points)
  if (importedData.tracking_number && existingDelivery.tracking_number && 
      normalizeText(importedData.tracking_number) === normalizeText(existingDelivery.tracking_number)) {
    score += 10;
    details.push('✓ Tracking number match (+10)');
  }
  
  // CRITERION 5.5: Stop Order Number Match (max 8 points)
  if (importedData.stop_order !== undefined && importedData.stop_order !== null && 
      existingDelivery.stop_order !== undefined && existingDelivery.stop_order !== null) {
    const stopDiff = Math.abs(importedData.stop_order - existingDelivery.stop_order);
    
    if (stopDiff === 0) {
      score += 8;
      details.push('✓ Exact stop order match (+8)');
    } else if (stopDiff <= 3) {
      score += 5;
      details.push(`✓ Stop order within 3 (${stopDiff}, +5)`);
    }
  }
  
  // CRITERION 6: Completion Time Proximity (max 10 points)
  if (importedData.actual_delivery_time && existingDelivery.actual_delivery_time) {
    const importedMinutes = parseTimeToMinutes(importedData.actual_delivery_time);
    const existingMinutes = parseTimeToMinutes(existingDelivery.actual_delivery_time);
    
    if (importedMinutes !== null && existingMinutes !== null) {
      const timeDiff = Math.abs(importedMinutes - existingMinutes);
      
      if (timeDiff === 0) {
        score += 10;
        details.push('✓ Exact completion time match (+10)');
      } else if (timeDiff <= 5) {
        score += 8;
        details.push(`✓ Completion time within 5 min (+8)`);
      } else if (timeDiff <= 15 || (importedMinutes >= existingMinutes - 15 && importedMinutes <= existingMinutes + 60)) {
        score += 5;
        details.push(`~ Completion time within window (${timeDiff} min, +5)`);
      }
    }
  }
  
  // CRITERION 7: Prescription Number Match (max 5 points)
  if (importedData.prescription_number && existingDelivery.prescription_number && 
      normalizeText(importedData.prescription_number) === normalizeText(existingDelivery.prescription_number)) {
    score += 5;
    details.push('✓ RX# match (+5)');
  }
  
  // DEDUCTION: Conflicting Driver Assignment (-5 points)
  if (importedData.driver_id && existingDelivery.driver_id && 
      importedData.driver_id !== existingDelivery.driver_id) {
    score -= 5;
    details.push('⚠ Different driver (-5)');
  }
  
  // DEDUCTION: Conflicting TR# when both exist (-3 points)
  if (importedData.tracking_number && existingDelivery.tracking_number && 
      normalizeText(importedData.tracking_number) !== normalizeText(existingDelivery.tracking_number)) {
    score -= 3;
    details.push('⚠ Different TR# (-3)');
  }
  
  return { score, details };
};

// Find the best fuzzy match for an imported delivery
export const findFuzzyMatch = (importedData, candidateDeliveries, patients) => {
  let bestMatch = null;
  let bestScore = 0;
  let bestDetails = [];
  
  for (const candidate of candidateDeliveries) {
    const { score, details } = calculateFuzzyMatchScore(importedData, candidate, patients);
    
    if (score > bestScore) {
      bestScore = score;
      bestMatch = candidate;
      bestDetails = details;
    }
  }
  
  // Define score thresholds
  let matchTier = 'none';
  if (bestScore >= 85) {
    matchTier = 'strong'; // Auto-update recommended
  } else if (bestScore >= 65) {
    matchTier = 'moderate'; // Review suggested
  } else if (bestScore >= 40) {
    matchTier = 'weak'; // Create new but flagged
  }
  
  return {
    match: bestMatch,
    score: bestScore,
    tier: matchTier,
    details: bestDetails
  };
};