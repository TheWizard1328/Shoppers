/**
 * Shared notes processing utility for route importers
 * Used by both RouteImport (Past Routes) and ImportActiveRoutes (Active Stops)
 */

/**
 * Process and clean delivery notes from CSV imports
 * Extracts special flags (COD, first delivery, etc.) and filters out redundant information
 * 
 * @param {string} rawNotes - Raw notes from CSV import
 * @param {object} deliveryData - Delivery object to update with extracted flags
 * @param {object} patient - Patient object (for patient deliveries)
 * @param {boolean} isPickup - Whether this is a pickup stop
 * @param {boolean} isCompleted - Whether the delivery is completed (for COD collection handling)
 * @returns {string} Cleaned notes string
 */
export const processDeliveryNotes = (rawNotes, deliveryData, patient = null, isPickup = false, isCompleted = false) => {
  if (!rawNotes) return null;

  // Clean and process notes - replace " - " with line breaks
  let cleanedNotes = rawNotes.replace(/ - /g, '\n');
  const notesLower = cleanedNotes.toLowerCase();

  // Parse special flags from notes
  if (notesLower.includes('first delivery')) {
    deliveryData.first_delivery = true;
    cleanedNotes = cleanedNotes.replace(/first delivery/gi, '').trim();
    cleanedNotes = cleanedNotes.replace(/^[,\s\n]+|[,\s\n]+$/g, '').replace(/\s{2,}/g, ' ').replace(/\n{2,}/g, '\n');
  }

  if (notesLower.match(/\bsignature\b/i)) {
    deliveryData.signature_needed = true;
  }

  if (notesLower.match(/\b(fridge|cold|refrigerat(?:e|ed|or)?|refrig)\b/i)) {
    deliveryData.fridge_item = true;
  }

  if (notesLower.match(/\b(oversized|large|bulky|big)\b/i)) {
    deliveryData.oversized = true;
  }

  if (notesLower.match(/\bafter[\s-]?hours\b/i)) {
    deliveryData.after_hours_pickup = true;
  }

  // Parse COD from notes (only for patient deliveries)
  if (patient || (!isPickup && deliveryData.patient_id)) {
    const codRegex = /(cod|dod)\s*[\$]?\s*([\d.]+)\s*(cash|debit|credit|check|cheque)?/gi;
    const codMatches = [...cleanedNotes.matchAll(codRegex)];

    if (codMatches.length > 0) {
      const codPayments = [];
      let totalCodAmount = 0;

      codMatches.forEach((match) => {
        const codType = (match[1] || '').toLowerCase();
        const amount = parseFloat(match[2]);
        let paymentType = (match[3] || '').toLowerCase();

        if (codType === 'dod') {
          paymentType = 'Debit';
        } else if (paymentType === 'cash') {
          paymentType = 'Cash';
        } else if (paymentType === 'debit') {
          paymentType = 'Debit';
        } else if (paymentType === 'credit') {
          paymentType = 'Credit';
        } else if (paymentType === 'check' || paymentType === 'cheque') {
          paymentType = 'Check';
        } else {
          paymentType = 'Cash';
        }

        if (amount > 0) {
          codPayments.push({ type: paymentType, amount });
          totalCodAmount += amount;
        }
      });

      if (codPayments.length > 0) {
        // CRITICAL: For completed stops, COD was collected
        // For incomplete stops, COD is required but not yet collected
        if (isCompleted) {
          // Stop is complete - COD was collected
          deliveryData.cod_payments = codPayments;
          deliveryData.cod_total_amount_required = totalCodAmount;
          deliveryData.cod_payment_type = codPayments[0].type;
          deliveryData.cod_amount = totalCodAmount.toString();
        } else {
          // Stop is incomplete - COD is required but not yet collected
          deliveryData.cod_payments = [];
          deliveryData.cod_total_amount_required = totalCodAmount;
          deliveryData.cod_payment_type = 'No Payment';
          deliveryData.cod_amount = '';
        }
      }
    }
  }

  // Filter notes to remove parsed information
  const linesToRemove = [
    /(?:unit|apt|apartment|suite)\s*#?\s*\d+/i,
    /#\d+/i,
    /\d+\s+buzz\s+\d+/i,
    /(?:cod|dod)\s*[\$]?\s*[\d.]+/i,
    /\b(cash|debit|credit|check|cheque)\b/i,
    /\bsignature\b/i,
    /\b(fridge|cold|refrigerat(?:e|ed|or)?|refrig)\b/i,
    /\b(oversized|large|bulky|big)\b/i,
    /\bafter[\s-]?hours\b/i,
    /\b(failed|cancel|cancelled|return|pickup|pick up)\b/i,
    /\bfirst delivery\b/i
  ];

  const noteLines = cleanedNotes.split('\n');
  const filteredNoteLines = noteLines.filter((noteLine) => {
    const noteLineLower = noteLine.toLowerCase().trim();

    if (!noteLineLower) return false;

    // Always preserve InterStore markers
    if (noteLineLower.includes('interstore')) {
      return true;
    }

    // Remove lines matching patterns
    for (const pattern of linesToRemove) {
      if (pattern.test(noteLine)) {
        return false;
      }
    }

    return true;
  });

  cleanedNotes = filteredNoteLines.join('\n').trim();

  // Return null for empty or dash-only notes
  if (cleanedNotes === '' || cleanedNotes === '-') {
    return null;
  }

  return cleanedNotes;
};