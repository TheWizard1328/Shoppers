/**
 * Handles Square COD operations based on COD amount changes
 * Prevents unnecessary API calls by comparing initial vs current COD
 */

/**
 * Update Square COD based on changes between initial and current amounts
 * @param {Object} params - Parameters
 * @param {Object} params.delivery - The delivery being edited
 * @param {number} params.initialCodCents - Initial COD amount when form opened (in cents)
 * @param {number} params.currentCodCents - Current COD amount in form (in cents)
 * @param {Object} params.formData - Current form data
 * @param {Array} params.stores - All stores
 * @param {Object} params.base44 - Base44 SDK client
 * @param {Object} params.dataToSave - Data being saved (for clearing cod_payments)
 * @returns {Promise<void>}
 */
export async function updateSquareCODIfChanged({
  delivery,
  initialCodCents,
  currentCodCents,
  formData,
  stores,
  base44,
  dataToSave
}) {
  if (!delivery?.id) return;
  
  const initialCodDollars = initialCodCents / 100;
  const currentCodDollars = currentCodCents / 100;
  
  console.log('💰 [Square] COD comparison:', {
    initialCents: initialCodCents,
    currentCents: currentCodCents,
    initialDollars: initialCodDollars,
    currentDollars: currentCodDollars,
    changed: initialCodCents !== currentCodCents
  });
  
  // No change - skip Square operations
  if (initialCodCents === currentCodCents) {
    console.log('💰 [Square] COD unchanged - no Square operations needed');
    return;
  }
  
  const store = stores?.find(s => s && s.id === formData.store_id);
  
  if (initialCodDollars === 0 && currentCodDollars > 0) {
    // Case 1: No COD → Has COD (CREATE)
    try {
      console.log('💳 [Square] COD added - creating COD item:', delivery.id, 'Amount:', currentCodDollars);
      await Promise.race([
        base44.functions.invoke('squareCreateCodItem', {
          deliveryId: delivery.id,
          patientName: formData.patient_name,
          storeAbbreviation: store?.abbreviation || '',
          codAmount: currentCodDollars,
          deliveryDate: formData.delivery_date,
          storeId: formData.store_id
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Square timeout')), 8000))
      ]);
      console.log('✅ [Square] COD item created');
    } catch (squareError) {
      console.error('⚠️ [Square] Failed to create COD item:', squareError.message);
    }
  } else if (initialCodDollars > 0 && currentCodDollars === 0) {
    // Case 2: Has COD → No COD (DELETE)
    try {
      console.log('💳 [Square] COD removed - deleting COD item:', delivery.id);
      
      // CRITICAL: Clear cod_payments array when COD is removed
      dataToSave.cod_payments = [];
      dataToSave.cod_payment_type = 'No Payment';
      dataToSave.cod_amount = '';
      
      await Promise.race([
        base44.functions.invoke('squareDeleteCodItem', {
          deliveryId: delivery.id,
          reason: 'cod_removed'
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Square timeout')), 8000))
      ]);
      console.log('✅ [Square] COD item deleted');
    } catch (squareError) {
      console.warn('⚠️ [Square] Failed to delete COD item:', squareError.message);
    }
  } else if (initialCodDollars > 0 && currentCodDollars > 0) {
    // Case 3: COD amount changed (UPDATE via DELETE + CREATE)
    try {
      console.log('💳 [Square] COD amount changed - updating:', delivery.id, 'From:', initialCodDollars, 'To:', currentCodDollars);
      
      // Delete old item
      await Promise.race([
        base44.functions.invoke('squareDeleteCodItem', {
          deliveryId: delivery.id,
          reason: 'cod_amount_changed'
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Square timeout')), 8000))
      ]).catch(err => console.warn('⚠️ [Square] Delete old COD failed (continuing):', err.message));
      
      // Create new item with updated amount
      await Promise.race([
        base44.functions.invoke('squareCreateCodItem', {
          deliveryId: delivery.id,
          patientName: formData.patient_name,
          storeAbbreviation: store?.abbreviation || '',
          codAmount: currentCodDollars,
          deliveryDate: formData.delivery_date,
          storeId: formData.store_id
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Square timeout')), 8000))
      ]);
      console.log('✅ [Square] COD amount updated');
    } catch (squareError) {
      console.error('⚠️ [Square] Failed to update COD amount:', squareError.message);
    }
  }
}

/**
 * Handle Square COD deletion when delivery status changes to completion
 */
export async function deleteSquareCODOnCompletion({
  delivery,
  currentStatus,
  currentCodCents,
  base44
}) {
  if (!delivery?.id) return;
  if (currentCodCents === 0) return; // No COD to delete
  
  const statusChangedToCompletion = ['completed', 'cancelled', 'failed', 'returned'].includes(currentStatus) &&
    delivery.status !== currentStatus;

  if (statusChangedToCompletion && (currentStatus === 'completed' || currentStatus === 'failed')) {
    try {
      console.log('💳 [Square] Deleting COD item for completed/failed delivery:', delivery.id);
      await Promise.race([
        base44.functions.invoke('squareDeleteCodItem', {
          deliveryId: delivery.id,
          reason: currentStatus
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Square timeout')), 8000))
      ]);
      console.log('✅ [Square] COD item deleted');
    } catch (squareError) {
      console.warn('⚠️ [Square] Failed to delete COD item:', squareError.message);
      // Don't block the delivery update if Square fails
    }
  }
}