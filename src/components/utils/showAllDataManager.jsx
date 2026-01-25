/**
 * Show All Data Manager
 * 
 * Ensures that when "Show All" checkbox is enabled on Dashboard,
 * the UI properly reflects ALL drivers' data for the selected date.
 * 
 * This utility:
 * 1. Checks the "Show All" checkbox state
 * 2. Verifies if all drivers' data is available for the selected date
 * 3. Loads missing data if needed
 * 4. Coordinates with smart refresh to respect the "Show All" state
 */

import { base44 } from '@/api/base44Client';
import { offlineDB } from './offlineDatabase';
import { format } from 'date-fns';

class ShowAllDataManager {
  constructor() {
    this.isLoading = false;
    this.lastCheckTimestamp = 0;
    this.checkCooldown = 2000; // 2 seconds between checks
  }

  /**
   * Check if "Show All" is enabled
   */
  isShowAllEnabled() {
    const saved = localStorage.getItem('rxdeliver_show_all_driver_markers');
    return saved === 'true';
  }

  /**
   * Check if we have all drivers' data for the selected date
   * Returns { hasAllData: boolean, missingDriverIds: string[] }
   */
  async checkDataCompleteness(selectedDate, deliveries, drivers) {
    try {
      const selectedDateStr = typeof selectedDate === 'string' 
        ? selectedDate 
        : format(selectedDate, 'yyyy-MM-dd');

      // Get all deliveries for the selected date from the deliveries array
      const deliveriesForDate = (deliveries || []).filter(d => 
        d && d.delivery_date === selectedDateStr
      );

      // Get unique driver IDs from deliveries
      const driversWithDeliveries = new Set(
        deliveriesForDate.map(d => d.driver_id).filter(Boolean)
      );

      console.log(`🔍 [Show All Manager] Found ${driversWithDeliveries.size} drivers with deliveries for ${selectedDateStr}`);

      // Get all drivers from deliveries for the date from the backend to verify completeness
      const allDeliveriesFromBackend = await base44.entities.Delivery.filter({
        delivery_date: selectedDateStr
      });

      const allDriversWithDeliveriesBackend = new Set(
        allDeliveriesFromBackend.map(d => d.driver_id).filter(Boolean)
      );

      // Compare - find missing drivers
      const missingDriverIds = Array.from(allDriversWithDeliveriesBackend).filter(
        driverId => !driversWithDeliveries.has(driverId)
      );

      const hasAllData = missingDriverIds.length === 0;

      if (!hasAllData) {
        console.log(`⚠️ [Show All Manager] Missing data for ${missingDriverIds.length} drivers:`, missingDriverIds);
      } else {
        console.log(`✅ [Show All Manager] Have complete data for all ${driversWithDeliveries.size} drivers`);
      }

      return {
        hasAllData,
        missingDriverIds,
        totalDriversExpected: allDriversWithDeliveriesBackend.size,
        driversCurrentlyLoaded: driversWithDeliveries.size
      };
    } catch (error) {
      console.error('❌ [Show All Manager] Error checking data completeness:', error);
      return { hasAllData: false, missingDriverIds: [] };
    }
  }

  /**
   * Load all drivers' deliveries for the selected date
   * Called when "Show All" is enabled but data is incomplete
   */
  async ensureAllDriversDataLoaded(selectedDate, currentDeliveries, updateDeliveriesCallback) {
    // Prevent concurrent loads
    if (this.isLoading) {
      console.log('⏭️ [Show All Manager] Already loading data - skipping duplicate call');
      return;
    }

    // Cooldown to prevent excessive checks
    const now = Date.now();
    if (now - this.lastCheckTimestamp < this.checkCooldown) {
      console.log('⏭️ [Show All Manager] Cooldown active - skipping check');
      return;
    }

    this.isLoading = true;
    this.lastCheckTimestamp = now;

    try {
      const selectedDateStr = typeof selectedDate === 'string' 
        ? selectedDate 
        : format(selectedDate, 'yyyy-MM-dd');

      console.log(`📥 [Show All Manager] Loading ALL drivers' data for ${selectedDateStr}...`);

      // Step 1: Try offline DB first
      let allDateDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr);

      // Step 2: If offline DB is empty or incomplete, fetch from API
      if (!allDateDeliveries || allDateDeliveries.length === 0) {
        console.log('📥 [Show All Manager] Offline DB empty - fetching from API');
        allDateDeliveries = await base44.entities.Delivery.filter({ 
          delivery_date: selectedDateStr 
        });

        // Save to offline DB for future use
        if (allDateDeliveries.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, allDateDeliveries);
          console.log(`✅ [Show All Manager] Saved ${allDateDeliveries.length} deliveries to offline DB`);
        }
      } else {
        console.log(`📦 [Show All Manager] Using ${allDateDeliveries.length} deliveries from offline DB`);
        
        // Verify completeness by comparing with backend
        const backendDeliveries = await base44.entities.Delivery.filter({ 
          delivery_date: selectedDateStr 
        });

        if (backendDeliveries.length > allDateDeliveries.length) {
          console.log(`⚠️ [Show All Manager] Offline DB incomplete (${allDateDeliveries.length} vs ${backendDeliveries.length}) - using backend data`);
          allDateDeliveries = backendDeliveries;
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, allDateDeliveries);
        }
      }

      // Step 3: Update UI with complete data
      if (updateDeliveriesCallback && allDateDeliveries.length > 0) {
        // Merge with deliveries from other dates
        const otherDateDeliveries = (currentDeliveries || []).filter(d => 
          d && d.delivery_date !== selectedDateStr
        );
        const mergedDeliveries = [...otherDateDeliveries, ...allDateDeliveries];

        console.log(`✅ [Show All Manager] Updating UI with ${allDateDeliveries.length} deliveries for ${selectedDateStr}`);
        updateDeliveriesCallback(mergedDeliveries, true);

        return allDateDeliveries;
      }

      return allDateDeliveries;
    } catch (error) {
      console.error('❌ [Show All Manager] Error loading data:', error);
      return null;
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Smart refresh integration - ensures smart refresh respects "Show All" state
   * Returns the appropriate filter to use for fetching deliveries
   */
  getDeliveryFilterForSmartRefresh(selectedDate, selectedDriverId) {
    const showAll = this.isShowAllEnabled();
    const selectedDateStr = typeof selectedDate === 'string' 
      ? selectedDate 
      : format(selectedDate, 'yyyy-MM-dd');

    const filter = { delivery_date: selectedDateStr };

    // If "Show All" is enabled, don't add driver filter (fetch all)
    // If "All Drivers" mode, don't add driver filter
    // Otherwise, filter by selected driver
    if (!showAll && selectedDriverId && selectedDriverId !== 'all') {
      filter.driver_id = selectedDriverId;
      console.log(`🔍 [Show All Manager] Smart refresh filter: Single driver (${selectedDriverId})`);
    } else {
      console.log(`🔍 [Show All Manager] Smart refresh filter: All drivers (showAll: ${showAll}, mode: ${selectedDriverId})`);
    }

    return filter;
  }

  /**
   * Check and load data if needed
   * Should be called when:
   * - Dashboard mounts
   * - "Show All" checkbox is toggled
   * - Smart refresh completes
   * - Driver/date changes
   */
  async checkAndLoadIfNeeded(selectedDate, currentDeliveries, drivers, updateDeliveriesCallback) {
    const showAll = this.isShowAllEnabled();

    // Only proceed if "Show All" is enabled
    if (!showAll) {
      console.log('⏭️ [Show All Manager] Not enabled - skipping check');
      return null;
    }

    console.log('🔍 [Show All Manager] Checking data completeness...');

    const completeness = await this.checkDataCompleteness(selectedDate, currentDeliveries, drivers);

    if (!completeness.hasAllData && completeness.missingDriverIds.length > 0) {
      console.log(`📥 [Show All Manager] Loading missing data for ${completeness.missingDriverIds.length} drivers`);
      return await this.ensureAllDriversDataLoaded(selectedDate, currentDeliveries, updateDeliveriesCallback);
    }

    console.log(`✅ [Show All Manager] Data is complete - no loading needed`);
    return null;
  }

  /**
   * Reset state (call when unmounting or changing dates)
   */
  reset() {
    this.isLoading = false;
    this.lastCheckTimestamp = 0;
  }
}

// Export singleton instance
export const showAllDataManager = new ShowAllDataManager();