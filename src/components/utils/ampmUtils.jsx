/**
 * Utility functions for determining and managing AM/PM designations for deliveries
 * 
 * Rules:
 * - AM: delivery_time_start before 15:00 (3:00 PM)
 * - PM: delivery_time_start at or after 15:00
 * - Patient deliveries inherit AM/PM from their pickup stop based on TR# base-20 matching
 * - TR# system: Each pickup is at base of 20 (0, 20, 40, 60...), deliveries follow (1-19, 21-39, 41-59...)
 */

import { format } from 'date-fns';
import { generateStopId } from './idGenerator';

/**
 * Add minutes to a time string (HH:mm format)
 */
export const addMinutes = (timeStr, minutes) => {
  if (!timeStr) return '';
  const [hours, mins] = timeStr.split(':').map(Number);
  const date = new Date();
  date.setHours(hours, mins + minutes, 0, 0);
  return format(date, 'HH:mm');
};

/**
 * Get pickup time (ETA or start) for a given store and date
 */
export const getPickupTimeOrETA = (storeId, deliveryDate, allDeliveries) => {
  const pickupDelivery = allDeliveries.find(d => 
    d && !d.patient_id && d.store_id === storeId && d.delivery_date === deliveryDate
  );
  return pickupDelivery?.delivery_time_eta || pickupDelivery?.delivery_time_start;
};

/**
 * Calculate initial delivery_time_start for staged deliveries
 * Priority: Patient time_window_start > Store pickup time + 5 min (or current + 5 if later)
 */
export const calculateInitialDeliveryTimeStart = (patient, store, deliveryDate, allDeliveries) => {
  // If patient has time windows defined, use them as the primary source
  if (patient?.time_window_start) {
    return patient.time_window_start;
  }

  // If patient has no specific time window, then apply the logic:
  // 5 minutes after the origin store's scheduled Delivery Start Time
  // OR 5 minutes after the current time, if now is later than the origin store's Delivery Start Time.
  if (store && deliveryDate && allDeliveries) {
    const pickupTime = getPickupTimeOrETA(store.id, deliveryDate, allDeliveries);
    if (pickupTime) {
      const pickupPlus5 = addMinutes(pickupTime, 5);
      
      const now = new Date();
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      const pickupMinutes = parseInt(pickupTime.split(':')[0]) * 60 + parseInt(pickupTime.split(':')[1]);

      if (currentMinutes > pickupMinutes) {
        // Current time is later than the origin store's Delivery Start Time
        return addMinutes(format(now, 'HH:mm'), 5);
      } else {
        // Otherwise, use 5 minutes after the origin store's Delivery Start Time
        return pickupPlus5;
      }
    }
  }
  return '';
};

/**
 * Determine AM or PM based on PICKUP time string (HH:mm format)
 * CRITICAL: This is for PICKUPS ONLY - based on their scheduled time
 * AM: before 14:00 (2:00 PM)
 * PM: 14:00 (2:00 PM) and after
 * 
 * For DELIVERIES, use determineDeliveryAMPM which looks at their pickup's time slot
 */
export const determineAMPMFromTime = (timeString) => {
  if (!timeString) return null;
  
  try {
    const [hours, minutes] = timeString.split(':').map(Number);
    if (isNaN(hours)) return null;
    
    // Convert to total minutes for precise comparison
    const totalMinutes = hours * 60 + (minutes || 0);
    const cutoffMinutes = 14 * 60; // 14:00 = 840 minutes
    
    return totalMinutes < cutoffMinutes ? 'AM' : 'PM';
  } catch (error) {
    return null;
  }
};

/**
 * Parse tracking number to numeric value
 */
export const parseTrackingNumber = (trackingNumber) => {
  if (trackingNumber === null || trackingNumber === undefined) return null;
  const digits = String(trackingNumber).match(/\d+/);
  if (!digits) return null;
  const num = parseInt(digits[0], 10);
  return isNaN(num) ? null : num;
};

/**
 * Calculate the base TR# for a given tracking number
 */
export const getBaseTR = (trackingNumber) => {
  const num = parseTrackingNumber(trackingNumber);
  if (num === null) return null;
  return Math.floor(num / 20) * 20;
};

/**
 * Check if a tracking number is a pickup (base of 20: 0, 20, 40, 60...)
 */
export const isPickupTrackingNumber = (trackingNumber) => {
  const num = parseTrackingNumber(trackingNumber);
  if (num === null) return false;
  return num % 20 === 0;
};

/**
 * Find the associated pickup delivery for a patient delivery
 */
export const findAssociatedPickup = (patientDelivery, allDeliveries) => {
  if (!patientDelivery || !patientDelivery.tracking_number) return null;
  
  const baseTR = getBaseTR(patientDelivery.tracking_number);
  if (baseTR === null) return null;
  
  const matchingPickup = allDeliveries.find(delivery => {
    if (!delivery || !delivery.tracking_number) return false;
    
    const pickupTR = parseTrackingNumber(delivery.tracking_number);
    
    return (
      pickupTR === baseTR &&
      delivery.store_id === patientDelivery.store_id &&
      delivery.delivery_date === patientDelivery.delivery_date &&
      (delivery.driver_id && patientDelivery.driver_id 
        ? delivery.driver_id === patientDelivery.driver_id
        : delivery.driver_name === patientDelivery.driver_name) &&
      isPickupTrackingNumber(delivery.tracking_number)
    );
  });
  
  return matchingPickup || null;
};

/**
 * Determine AM/PM for a delivery or patient
 * Priority: Patient time_window_start > Associated pickup > null
 */
export const determineDeliveryAMPM = (patientOrDelivery, allDeliveries = []) => {
  if (!patientOrDelivery) return null;

  // Prioritize patient's time window if available
  if (patientOrDelivery.time_window_start) {
    return determineAMPMFromTime(patientOrDelivery.time_window_start);
  }
  
  const isPickup = !patientOrDelivery.patient_id || patientOrDelivery.patient_id === '';
  
  if (isPickup) {
    return determineAMPMFromTime(patientOrDelivery.delivery_time_start);
  } else {
    const associatedPickup = findAssociatedPickup(patientOrDelivery, allDeliveries);
    
    if (associatedPickup) {
      if (associatedPickup.ampm_deliveries) {
        return associatedPickup.ampm_deliveries;
      }
      return determineAMPMFromTime(associatedPickup.delivery_time_start);
    }
    
    return null;
  }
};

/**
 * Determine which time slot (AM/PM) to assign for a store pickup
 * Used for PUID assignment
 * CRITICAL: If store has both AM and PM, assigns to AM if AM pickup is NOT completed
 */
export const getStoreAssignedTimeSlot = (store, deliveryDate, allDeliveries = []) => {
  if (!store || !deliveryDate) return null;
  
  const dateObj = new Date(deliveryDate + 'T00:00:00');
  const dayOfWeek = dateObj.getDay(); // 0 = Sunday, 6 = Saturday
  const isSaturday = dayOfWeek === 6;
  const isSunday = dayOfWeek === 0;
  
  // Get AM and PM driver IDs based on day
  let amDriverId, pmDriverId;
  if (isSaturday) {
    amDriverId = store.saturday_am_driver_id;
    pmDriverId = store.saturday_pm_driver_id;
  } else if (isSunday) {
    amDriverId = store.sunday_am_driver_id;
    pmDriverId = store.sunday_pm_driver_id;
  } else {
    amDriverId = store.weekday_am_driver_id;
    pmDriverId = store.weekday_pm_driver_id;
  }
  
  // If only one slot has a driver, return that slot
  if (amDriverId && !pmDriverId) return 'AM';
  if (pmDriverId && !amDriverId) return 'PM';
  if (!amDriverId && !pmDriverId) return null;
  
  // Both AM and PM have drivers - determine which to use based on AM pickup completion status
  
  // Find the AM pickup for this store on this date
  const amPickup = allDeliveries.find(d => 
    d && 
    d.store_id === store.id && 
    d.delivery_date === deliveryDate && 
    d.ampm_deliveries === 'AM' && 
    !d.patient_id // Is a pickup
  );
  
  // If no AM pickup exists OR AM pickup is NOT completed, use AM
  if (!amPickup || amPickup.status !== 'completed') {
    console.log(`[getStoreAssignedTimeSlot] Store ${store.name}: AM pickup ${amPickup ? `exists (status: ${amPickup.status})` : 'not found'} - assigning to AM`);
    return 'AM';
  }
  
  // AM pickup is completed, use PM
  console.log(`[getStoreAssignedTimeSlot] Store ${store.name}: AM pickup completed - assigning to PM`);
  return 'PM';
};

/**
 * Get the PUID (stop_id of the pickup) for a delivery
 */
export const getPickupStopIdForDelivery = (storeId, deliveryDate, timeSlot, allDeliveries = []) => {
  if (!storeId || !deliveryDate || !timeSlot) return null;
  
  const pickup = allDeliveries.find(d => 
    d && 
    d.store_id === storeId && 
    d.delivery_date === deliveryDate && 
    d.ampm_deliveries === timeSlot && 
    !d.patient_id && // Is a pickup
    d.stop_id
  );
  
  return pickup ? pickup.stop_id : null;
};

/**
 * Batch update AM/PM for deliveries - DISABLED FOR NOW
 * SDK access issue needs to be resolved
 */
export const batchUpdateAMPM = async (deliveries, allDeliveries) => {
  console.log('[ampmUtils] batchUpdateAMPM is currently disabled due to SDK access issues');
  return 0;
};

const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned', 'picked_up'];

/**
 * Find or create a pickup ID (PUID) for a delivery
 * Handles logic for finding existing pickups or creating new ones based on completion status
 */
export const findOrCreatePickupId = (store, deliveryDate, driverId, requestedTimeSlot, allDeliveries) => {
  if (!store || !deliveryDate || !driverId || !requestedTimeSlot) return generateStopId();
  
  // First, look for an existing NON-COMPLETED pickup for the requested time slot and driver
  let puid = null;
  let existingPickup = allDeliveries.find((d) =>
    d && !d.patient_id &&
    d.store_id === store.id &&
    d.delivery_date === deliveryDate &&
    d.driver_id === driverId &&
    d.ampm_deliveries === requestedTimeSlot &&
    !FINISHED_STATUSES.includes(d.status)
  );

  if (existingPickup) {
    puid = existingPickup.stop_id;
    console.log(`✅ [PUID Logic] Found existing NON-COMPLETED ${requestedTimeSlot} pickup: ${puid}`);
    return puid;
  }

  // If no non-completed pickup for the requested slot, check if ALL existing pickups for this store/date/driver are completed.
  const allPickupsForStoreDateDriver = allDeliveries.filter(d =>
    d && !d.patient_id &&
    d.store_id === store.id &&
    d.delivery_date === deliveryDate &&
    d.driver_id === driverId
  );
  const allAreCompleted = allPickupsForStoreDateDriver.length > 0 && allPickupsForStoreDateDriver.every(d => FINISHED_STATUSES.includes(d.status));

  if (allAreCompleted && requestedTimeSlot === 'AM') {
    console.log(`🔄 [PUID Logic] AM slot pickups are all completed. Checking for PM slot...`);
    // Try to find a PM slot driver for the store for today.
    const dateObj = new Date(deliveryDate + 'T00:00:00');
    const dayOfWeek = dateObj.getDay();
    const isSaturday = dayOfWeek === 6;
    const isSunday = dayOfWeek === 0;
    
    let pmDriverIdField = '';
    if (isSaturday) pmDriverIdField = 'saturday_pm_driver_id';
    else if (isSunday) pmDriverIdField = 'sunday_pm_driver_id';
    else pmDriverIdField = 'weekday_pm_driver_id';
    
    const pmDriverExists = !!store[pmDriverIdField];

    if (pmDriverExists) {
      // If a PM slot driver exists, look for a non-completed PM pickup.
      existingPickup = allDeliveries.find(d =>
        d && !d.patient_id &&
        d.store_id === store.id &&
        d.delivery_date === deliveryDate &&
        d.driver_id === driverId &&
        d.ampm_deliveries === 'PM' &&
        !FINISHED_STATUSES.includes(d.status)
      );

      if (existingPickup) {
        puid = existingPickup.stop_id;
        console.log(`✅ [PUID Logic] Found existing NON-COMPLETED PM pickup: ${puid}`);
      } else {
        // No existing PM pickup, create a new one for PM.
        puid = generateStopId();
        console.log(`🆕 [PUID Logic] Created NEW PM pickup PUID: ${puid}`);
      }
    } else {
      // No PM driver, just create a new pickup for the requested timeslot
      puid = generateStopId();
      console.log(`🆕 [PUID Logic] No PM driver found, created NEW ${requestedTimeSlot} pickup PUID: ${puid}`);
    }
  } else {
    // Otherwise, create a new pickup for the requested timeslot.
    puid = generateStopId();
    console.log(`🆕 [PUID Logic] Created NEW ${requestedTimeSlot} pickup PUID: ${puid}`);
  }
  
  return puid;
};