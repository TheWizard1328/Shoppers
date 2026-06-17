/**
 * Offline Database Diagnostics
 * Helps identify duplicates in the offline database
 */

import { offlineDB } from './offlineDatabase';

export const checkOfflineDBForDuplicates = async (dateStr) => {
  console.log(`🔍 [OfflineDB Diagnostics] Checking for duplicates on ${dateStr}...`);
  
  try {
    // Get all deliveries for the date
    const deliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, dateStr);
    console.log(`📦 Found ${deliveries.length} total deliveries`);
    
    // Get all app users
    const appUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
    console.log(`👤 Found ${appUsers.length} total AppUsers`);
    
    // Check for duplicate deliveries by ID
    const deliveryIdMap = new Map();
    const duplicateDeliveryIds = [];
    
    deliveries.forEach(d => {
      if (d.id) {
        if (deliveryIdMap.has(d.id)) {
          duplicateDeliveryIds.push(d.id);
        }
        deliveryIdMap.set(d.id, d);
      }
    });
    
    if (duplicateDeliveryIds.length > 0) {
      console.warn(`⚠️ DUPLICATE DELIVERY IDs: ${duplicateDeliveryIds.length}`);
      duplicateDeliveryIds.forEach(id => {
        console.warn(`   - ${id}`);
      });
    } else {
      console.log(`✅ No duplicate delivery IDs`);
    }
    
    // Check for duplicate stop IDs
    const stopIdMap = new Map();
    const duplicateStopIds = [];
    
    deliveries.forEach(d => {
      if (d.stop_id) {
        if (stopIdMap.has(d.stop_id)) {
          duplicateStopIds.push(d.stop_id);
        }
        stopIdMap.set(d.stop_id, (stopIdMap.get(d.stop_id) || 0) + 1);
      }
    });
    
    if (duplicateStopIds.length > 0) {
      console.warn(`⚠️ DUPLICATE STOP IDs: ${duplicateStopIds.length} unique stop IDs with duplicates`);
      duplicateStopIds.forEach(stopId => {
        const count = stopIdMap.get(stopId);
        console.warn(`   - Stop ID "${stopId}": appears ${count} times`);
      });
    } else {
      console.log(`✅ No duplicate stop IDs`);
    }
    
    // Check for duplicate driver IDs
    const driverIdMap = new Map();
    const duplicateDriverIds = [];
    
    appUsers.forEach(au => {
      if (au.user_id) {
        if (driverIdMap.has(au.user_id)) {
          duplicateDriverIds.push(au.user_id);
        } else {
          driverIdMap.set(au.user_id, au);
        }
      }
    });
    
    if (duplicateDriverIds.length > 0) {
      console.warn(`⚠️ DUPLICATE DRIVER (AppUser) IDs: ${duplicateDriverIds.length}`);
      duplicateDriverIds.forEach(id => {
        console.warn(`   - User ID: ${id}`);
      });
    } else {
      console.log(`✅ No duplicate driver user IDs`);
    }
    
    // List all stop IDs for the date (to see if there are obvious duplicates)
    console.log(`\n📋 STOP ID BREAKDOWN for ${dateStr}:`);
    const stopCounts = {};
    deliveries.forEach(d => {
      if (d.stop_id) {
        stopCounts[d.stop_id] = (stopCounts[d.stop_id] || 0) + 1;
      }
    });
    
    const sortedStops = Object.entries(stopCounts).sort((a, b) => b[1] - a[1]);
    sortedStops.forEach(([stopId, count]) => {
      if (count > 1) {
        console.warn(`   ⚠️ Stop "${stopId}": ${count} deliveries`);
      } else {
        console.log(`   ✓ Stop "${stopId}": ${count} delivery`);
      }
    });
    
    return {
      totalDeliveries: deliveries.length,
      totalAppUsers: appUsers.length,
      duplicateDeliveryIds: duplicateDeliveryIds.length,
      duplicateStopIds: duplicateStopIds.length,
      duplicateDriverIds: duplicateDriverIds.length,
      stopIdCounts: stopCounts
    };
  } catch (error) {
    console.error('❌ [OfflineDB Diagnostics] Error:', error);
    return { error: error.message };
  }
};

// Quick summary
export const getOfflineDBSummary = async () => {
  try {
    const deliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
    const appUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
    const patients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
    const stores = await offlineDB.getAll(offlineDB.STORES.STORES);
    const cities = await offlineDB.getAll(offlineDB.STORES.CITIES);
    
    return {
      deliveries: deliveries.length,
      appUsers: appUsers.length,
      patients: patients.length,
      stores: stores.length,
      cities: cities.length
    };
  } catch (error) {
    return { error: error.message };
  }
};