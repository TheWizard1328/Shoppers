/**
 * Gradual historical data sync - rebuilds offline DB by fetching missing dates
 * Only syncs dates that don't exist in the offline DB
 */

import { base44 } from '@/api/base44Client';
import { offlineDB } from './offlineDatabase';
import { format, subDays } from 'date-fns';

let historicalSyncInProgress = false;
let historicalSyncCancelled = false;
let syncStatusCallback = null;

export function setSyncStatusCallback(callback) {
  syncStatusCallback = callback;
}

function updateStatus(status) {
  if (syncStatusCallback) {
    syncStatusCallback(status);
  }
}

/**
 * Get all historical dates from the offline DB that have deliveries
 */
export async function getHistoricalDates() {
  try {
    const allDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
    if (!allDeliveries || allDeliveries.length === 0) {
      return [];
    }
    
    const uniqueDates = [...new Set(allDeliveries.map(d => d.delivery_date).filter(Boolean))];
    return uniqueDates.sort().reverse(); // Most recent first
  } catch (error) {
    console.error('❌ [HistoricalSync] Failed to get historical dates:', error);
    return [];
  }
}

/**
 * Get date range for the past 90 days (default historical period)
 */
export function get90DayRange() {
  const today = new Date();
  const start = subDays(today, 90);
  const end = today;
  
  const dates = [];
  let current = new Date(start);
  
  while (current <= end) {
    dates.push(format(current, 'yyyy-MM-dd'));
    current = new Date(current.getTime() + 86400000); // Add 1 day
  }
  
  return dates;
}

/**
 * Check which dates are missing from offline DB
 */
export async function getMissingDates(dateRange) {
  const historicalDates = new Set(await getHistoricalDates());
  return dateRange.filter(date => !historicalDates.has(date));
}

/**
 * Gradually sync historical delivery data for missing dates
 * Fetches one date at a time with delays to avoid rate limiting
 */
export async function syncHistoricalData(options = {}) {
  const {
    dateRange = get90DayRange(),
    delayBetweenDates = 2000, // 2 seconds between requests
    maxDates = null // null = no limit
  } = options;

  if (historicalSyncInProgress) {
    console.warn('⚠️ [HistoricalSync] Sync already in progress');
    return false;
  }

  historicalSyncInProgress = true;
  historicalSyncCancelled = false;

  try {
    // Find missing dates
    const missingDates = await getMissingDates(dateRange);
    const datesToSync = maxDates ? missingDates.slice(0, maxDates) : missingDates;

    if (datesToSync.length === 0) {
      console.log('✅ [HistoricalSync] No missing dates to sync');
      updateStatus({ type: 'complete', missing: 0, synced: 0 });
      return true;
    }

    console.log(`📅 [HistoricalSync] Starting sync of ${datesToSync.length} missing dates`);
    updateStatus({ type: 'started', total: datesToSync.length, synced: 0, missing: datesToSync.length });

    let syncedCount = 0;

    for (let i = 0; i < datesToSync.length; i++) {
      if (historicalSyncCancelled) {
        console.log('⏹️ [HistoricalSync] Sync cancelled by user');
        break;
      }

      const dateStr = datesToSync[i];

      try {
        // Fetch deliveries for this date
        const deliveries = await base44.entities.Delivery.filter(
          { delivery_date: dateStr },
          '-updated_date',
          1000
        );

        if (deliveries && deliveries.length > 0) {
          // Save to offline DB
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, deliveries);
          syncedCount++;
          
          const progress = Math.round((syncedCount / datesToSync.length) * 100);
          updateStatus({
            type: 'progress',
            dateStr,
            count: deliveries.length,
            synced: syncedCount,
            total: datesToSync.length,
            progress
          });

          console.log(`✅ [HistoricalSync] Synced ${dateStr}: ${deliveries.length} deliveries (${syncedCount}/${datesToSync.length})`);
        } else {
          console.log(`ℹ️ [HistoricalSync] No deliveries for ${dateStr}`);
        }

        // Wait before next request (rate limiting)
        if (i < datesToSync.length - 1) {
          await new Promise(resolve => setTimeout(resolve, delayBetweenDates));
        }
      } catch (error) {
        console.error(`⚠️ [HistoricalSync] Failed to sync ${dateStr}:`, error.message);
        
        // On rate limit error, increase delay for remaining dates
        if (error.response?.status === 429 || error.message?.includes('429')) {
          console.log('⏰ [HistoricalSync] Rate limit hit, increasing delay');
          delayBetweenDates = Math.min(delayBetweenDates * 2, 10000); // Cap at 10s
        }
      }
    }

    console.log(`📊 [HistoricalSync] Sync complete: ${syncedCount}/${datesToSync.length} dates synced`);
    updateStatus({
      type: 'complete',
      synced: syncedCount,
      total: datesToSync.length,
      missing: datesToSync.length - syncedCount
    });

    return true;
  } catch (error) {
    console.error('❌ [HistoricalSync] Fatal sync error:', error);
    updateStatus({ type: 'error', error: error.message });
    return false;
  } finally {
    historicalSyncInProgress = false;
  }
}

/**
 * Cancel ongoing historical sync
 */
export function cancelHistoricalSync() {
  historicalSyncCancelled = true;
  console.log('🛑 [HistoricalSync] Cancel requested');
}

/**
 * Check if sync is in progress
 */
export function isHistoricalSyncInProgress() {
  return historicalSyncInProgress;
}