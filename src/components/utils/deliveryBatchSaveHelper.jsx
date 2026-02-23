/**
 * Helper functions for batch saving deliveries with timeout protection
 * Prevents hanging when operations take too long
 */

/**
 * Update existing delivery TR#s with timeout protection
 */
export async function updateExistingTRNumbers(existingDeliveriesToUpdate, allDeliveries, base44) {
  if (existingDeliveriesToUpdate.length === 0) return;
  
  console.log(`[AddToRoute] 📝 Updating ${existingDeliveriesToUpdate.length} existing deliveries with corrected TR#s...`);
  
  const trUpdatePromises = existingDeliveriesToUpdate.map((update) =>
    Promise.race([
      base44.entities.Delivery.update(update.id, { tracking_number: update.tracking_number }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TR update timeout')), 5000))
    ])
      .catch((error) => {
        if (error.message?.includes('not found') || error.response?.status === 404) {
          console.log(`[AddToRoute] ⏭️ Skipping deleted delivery: ${update.id}`);
          return null;
        }
        if (error.message?.includes('timeout')) {
          console.warn(`⚠️ [AddToRoute] TR update timeout for ${update.id} - continuing anyway`);
          return null;
        }
        const delivery = allDeliveries?.find((d) => d?.id === update.id);
        const deliveryName = delivery?.patient_name || 'Unknown';
        console.error(`❌ [AddToRoute] Failed to update TR for ${deliveryName}:`, error.message);
        return null; // Don't block batch on single failure
      })
  );
  
  await Promise.all(trUpdatePromises);
  console.log('[AddToRoute] ✅ Existing TR#s corrected');
}

/**
 * Update existing deliveries with timeout protection
 */
export async function updateExistingDeliveries(existingDeliveries, hasCompletedDeliveries, allDeliveries, updateDeliveryLocal) {
  if (existingDeliveries.length === 0) return;
  
  console.log(`[AddToRoute] 📝 Updating ${existingDeliveries.length} existing deliveries...`);
  
  const updatePromises = existingDeliveries.map((updated) => {
    // CRITICAL: Convert 'Staged' to 'pending' for existing deliveries
    let finalStatus = updated.status;
    if (finalStatus === 'Staged') {
      const patientName = (updated.patient_name || '').toLowerCase();
      const deliveryNotes = (updated.delivery_notes || '').toLowerCase();
      const patientNotes = (updated.delivery_instructions || '').toLowerCase();
      const deliveryAddress = (updated.delivery_address || '').toLowerCase();
      
      const isInterStore = patientName.includes('interstore') || 
                           deliveryNotes.includes('interstore') || 
                           patientNotes.includes('interstore') ||
                           deliveryAddress.includes('(isp)') || 
                           deliveryAddress.includes('(isd)');
      
      finalStatus = isInterStore ? 'in_transit' : 'pending';
    }

    const updateData = {
      status: finalStatus,
      delivery_notes: updated.delivery_notes || '',
      prescription_number: updated.prescription_number || '',
      cod_total_amount_required: updated.cod_total_amount_required || 0,
      delivery_instructions: updated.delivery_instructions || '',
      tracking_number: updated.tracking_number || '99',
      isNextDelivery: hasCompletedDeliveries ? false : updated.isNextDelivery || false,
      patient_name: updated.patient_name || '',
      patient_phone: updated.patient_phone || '',
      unit_number: updated.unit_number || '',
      mailbox_ok: updated.mailbox_ok || false,
      call_upon_arrival: updated.call_upon_arrival || false,
      ring_bell: updated.ring_bell || false,
      dont_ring_bell: updated.dont_ring_bell || false,
      back_door: updated.back_door || false,
      signature_needed: updated.signature_needed || false,
      fridge_item: updated.fridge_item || false,
      oversized: updated.oversized || false,
      no_charge: updated.no_charge || false,
      extra_time: updated.extra_time || 0,
      time_window_start: updated.time_window_start || '',
      time_window_end: updated.time_window_end || '',
      paid_km_override: updated.paid_km_override ?? null,
      store_id: updated.store_id || '',
      ampm_deliveries: updated.ampm_deliveries || null,
      puid: updated.puid || ''
    };

    return Promise.race([
      updateDeliveryLocal(updated.id, updateData, { isBatchOperation: true, skipSmartRefresh: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Update timeout')), 10000))
    ])
      .then(() => {
        console.log(`[AddToRoute] ✅ Updated delivery: ${updated.patient_name} to status ${updateData.status}`);
        return null;
      })
      .catch((error) => {
        if (error.message?.includes('not found') || error.response?.status === 404) {
          console.log(`[AddToRoute] ⏭️ Skipping deleted delivery: ${updated.id} (${updated.patient_name})`);
          return null;
        }
        if (error.message?.includes('timeout')) {
          console.warn(`⚠️ [AddToRoute] Update timeout for ${updated.patient_name} - continuing anyway`);
          return null;
        }
        console.error(`❌ [AddToRoute] Failed to update ${updated.patient_name}:`, error.message);
        return null; // Don't block batch on single failure
      });
  });

  console.log(`[AddToRoute] 🚀 Batching ${updatePromises.length} updates in parallel...`);
  await Promise.all(updatePromises);
  console.log('[AddToRoute] ✅ All existing deliveries updated');
}

/**
 * Create Square COD items with timeout protection
 */
export async function createSquareCODItems(deliveriesReadyForDB, stores, base44) {
  const squarePromises = deliveriesReadyForDB
    .filter(d => d.cod_total_amount_required > 0 && d.patient_id && d.driver_id && d.status === 'in_transit')
    .map(delivery => {
      const store = stores?.find(s => s && s.id === delivery.store_id);
      console.log('💳 [Square] Creating COD item for in_transit delivery:', delivery.patient_name, 'Amount:', delivery.cod_total_amount_required);
      
      return Promise.race([
        base44.functions.invoke('squareCreateCodItem', {
          deliveryId: delivery.id || delivery._tempId,
          patientName: delivery.patient_name,
          storeAbbreviation: store?.abbreviation || '',
          codAmount: delivery.cod_total_amount_required,
          deliveryDate: delivery.delivery_date,
          storeId: delivery.store_id
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Square timeout')), 8000))
      ])
        .then(() => {
          console.log('✅ [Square] COD item created for:', delivery.patient_name);
          return null;
        })
        .catch(squareError => {
          console.error('⚠️ [Square] Failed to create COD item:', squareError.message);
          return null; // Don't block if Square fails
        });
    });

  if (squarePromises.length > 0) {
    await Promise.all(squarePromises);
  }
}

/**
 * Create default pickups with timeout protection
 */
export async function ensureDefaultPickups(assignedStore, timeSlot, group, driverId, base44) {
  try {
    const pickupResponse = await Promise.race([
      base44.functions.invoke('ensurePickupForDelivery', {
        storeId: assignedStore.id,
        deliveryDate: group.deliveryDate,
        driverId: driverId,
        ampmDeliveries: timeSlot
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Pickup creation timeout')), 8000))
    ]);
    
    console.log(`✅ [DoneButton] Pickup ensured for ${assignedStore.name} [${timeSlot}]: ${pickupResponse.data?.puid}`);
    return pickupResponse;
  } catch (error) {
    console.warn(`⚠️ [DoneButton] Failed to ensure pickup for ${assignedStore.name} [${timeSlot}]:`, error.message);
    return null;
  }
}