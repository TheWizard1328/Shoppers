/**
 * Optimized delete handler for deliveries
 * Ensures immediate UI update and full data sync for all users
 */

export const handleDelete = async (deliveryId, deliveriesWithStopOrder, deliveries, updateDeliveriesLocally, selectedCardId, setSelectedCardId, invalidateDeliveriesForDate, invalidate, base44, refreshData) => {
  try {
    console.log('🗑️ [DELETE Handler] Step 1: Checking if delivery exists...');
    const targetDelivery = deliveriesWithStopOrder.find((d) => d && d.id === deliveryId);
    
    if (!targetDelivery) {
      console.warn('⚠️ [DELETE Handler] Delivery not found (possibly already deleted), skipping');
      return;
    }

    const driverId = targetDelivery.driver_id;
    const deliveryDate = targetDelivery.delivery_date;
    console.log(`📦 [DELETE Handler] Deleting: ${targetDelivery.patient_name || 'Pickup'}`);

    console.log('🗑️ [DELETE Handler] Step 2: Deleting from offline DB and backend...');
    const { deleteDeliveryLocal } = await import('./offlineMutations');
    await deleteDeliveryLocal(deliveryId);
    console.log('✅ [DELETE Handler] Deleted from offline DB and backend');

    console.log('🗑️ [DELETE Handler] Step 3: Updating UI state immediately...');
    if (updateDeliveriesLocally) {
      const updatedDeliveries = deliveries.filter((d) => d && d.id !== deliveryId);
      updateDeliveriesLocally(updatedDeliveries, true); // Full replacement
      console.log(`✅ [DELETE Handler] UI state updated (${updatedDeliveries.length} remaining)`);
    }

    if (selectedCardId === deliveryId) {
      setSelectedCardId(null);
    }

    invalidateDeliveriesForDate(deliveryDate);
    invalidate('Delivery');

    console.log('🗑️ [DELETE Handler] Step 4: Triggering ETA recalculation...');
    if (driverId && deliveryDate) {
      try {
        await base44.functions.invoke('etaOptimizer', {
          driverId: driverId,
          deliveryDate: deliveryDate,
          triggerFullRecalculation: true,
          deviceTime: new Date().toISOString()
        });
        console.log('✅ [DELETE Handler] ETAs recalculated');
      } catch (etaError) {
        console.warn('⚠️ [DELETE Handler] ETA recalculation failed:', etaError);
      }
    }

    console.log('🗑️ [DELETE Handler] Step 5: Forcing full data refresh...');
    await refreshData(true);

    console.log('✅ [DELETE Handler] Delete complete');
  } catch (error) {
    console.error('❌ [DELETE Handler] Error:', error);
    alert('Failed to delete delivery. Please try again.');
    throw error;
  }
};