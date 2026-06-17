// Handles Square COD operations with timeout protection
export async function deleteCODWithTimeout(deliveryId, reason) {
  try {
    const { base44 } = await import('@/api/base44Client');
    
    console.log('💳 [Square] Deleting COD item:', deliveryId, 'reason:', reason);
    
    // Set 5 second timeout to prevent infinite waiting
    const squareDeletePromise = base44.functions.invoke('squareDeleteCodItem', {
      deliveryId: deliveryId,
      reason: reason
    });
    
    const squareTimeout = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Square delete timeout')), 5000)
    );
    
    await Promise.race([squareDeletePromise, squareTimeout]);
    console.log('✅ [Square] COD item deleted successfully');
    return true;
  } catch (error) {
    console.warn('⚠️ [Square] Failed to delete COD item:', error.message);
    // Don't throw - allow delivery update to continue
    return false;
  }
}

export async function createCODWithTimeout(deliveryId, patientName, storeAbbreviation, codAmount, deliveryDate, storeId) {
  try {
    const { base44 } = await import('@/api/base44Client');
    
    console.log('💳 [Square] Creating COD item for delivery:', deliveryId, 'Amount:', codAmount);
    
    // Set 5 second timeout
    const squareCreatePromise = base44.functions.invoke('squareCreateCodItem', {
      deliveryId: deliveryId,
      patientName: patientName,
      storeAbbreviation: storeAbbreviation,
      codAmount: codAmount,
      deliveryDate: deliveryDate,
      storeId: storeId
    });
    
    const squareTimeout = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Square create timeout')), 5000)
    );
    
    await Promise.race([squareCreatePromise, squareTimeout]);
    console.log('✅ [Square] COD item created successfully');
    return true;
  } catch (error) {
    console.warn('⚠️ [Square] Failed to create COD item:', error.message);
    // Don't throw - allow delivery to be saved
    return false;
  }
}