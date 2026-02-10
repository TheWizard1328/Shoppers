/**
 * Show All Data Manager
 * Ensures that when "Show All" checkbox is enabled, all drivers' deliveries are loaded
 * Integrates with smart refresh to prevent data mismatches
 */

import { base44 } from '@/api/base44Client';
import { offlineDB } from './offlineDatabase';
import { format } from 'date-fns';

class ShowAllDataManager {
  constructor() {
    this.listeners = new Set();
  }

  /**
   * Get the current state of "Show All" checkbox
   */
  getShowAllState() {
    const saved = localStorage.getItem('rxdeliver_show_all_driver_markers');
    return saved === 'true';
  }

  /**
   * Check if we need to load all drivers' data for the selected date
   * @param {Array} currentDeliveries - Current deliveries in memory
   * @param {string} selectedDateStr - Selected date (yyyy-MM-dd)
   * @param {string} selectedDriverId - Selected driver ID
   * @returns {boolean} - True if we need to load additional data
   */
  needsAllDriversData(currentDeliveries, selectedDateStr, selectedDriverId) {
    const showAll = this.getShowAllState();
    const isAllDriversMode = selectedDriverId === 'all';

    // If neither "Show All" nor "All Drivers" mode, we don't need all drivers' data
    if (!showAll && !isAllDriversMode) {
      return false;
    }

    // Check if we have deliveries for the selected date
    const deliveriesForDate = (currentDeliveries || []).filter(d => 
      d && d.delivery_date === selectedDateStr
    );

    // If we have no deliveries at all, we need to load
    if (deliveriesForDate.length === 0) {
      console.log('📊 [ShowAllDataManager] No deliveries for date - need to load');
      return true;
    }

    // Check if we have multiple drivers' data
    const uniqueDrivers = new Set(
      deliveriesForDate.map(d => d.driver_id).filter(Boolean)
    );

    // If Show All is checked or All Drivers mode, we should have multiple drivers
    // If we only have 1 driver, we likely don't have all drivers' data yet
    if (uniqueDrivers.size <= 1) {
      console.log(`📊 [ShowAllDataManager] Only ${uniqueDrivers.size} driver(s) found - need to load all drivers`);
      return true;
    }

    console.log(`✅ [ShowAllDataManager] Already have ${uniqueDrivers.size} drivers' data - no load needed`);
    return false;
  }

  /**
   * Load all drivers' deliveries for the selected date
   * @param {string} selectedDateStr - Selected date (yyyy-MM-dd)
   * @param {Array} currentDeliveries - Current deliveries in memory
   * @param {Function} updateCallback - Callback to update UI state
   * @returns {Promise<Array>} - Updated deliveries array
   */
  async ensureAllDriversDataLoaded(selectedDateStr, currentDeliveries, updateCallback) {
    console.log('📥 [ShowAllDataManager] Loading all drivers\' deliveries...');

    try {
      // Try offline DB first
      let allDateDeliveries = await offlineDB.getByDate(
        offlineDB.STORES.DELIVERIES, 
        selectedDateStr
      );

      // If offline DB is empty or incomplete, fetch from API
      if (!allDateDeliveries || allDateDeliveries.length === 0) {
        console.log('📥 [ShowAllDataManager] Offline DB empty - fetching from API');
        allDateDeliveries = await base44.entities.Delivery.filter({ 
          delivery_date: selectedDateStr 
        });
        
        // Save to offline DB for future use
        await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, allDateDeliveries);
      } else {
        console.log(`📦 [ShowAllDataManager] Using ${allDateDeliveries.length} deliveries from offline DB`);
      }

      // Merge with existing deliveries from other dates
      const otherDateDeliveries = (currentDeliveries || []).filter(d => 
        d && d.delivery_date !== selectedDateStr
      );
      const mergedDeliveries = [...otherDateDeliveries, ...allDateDeliveries];

      // Update UI via callback
      if (updateCallback) {
        updateCallback(mergedDeliveries, true);
      }

      console.log(`✅ [ShowAllDataManager] Loaded ${allDateDeliveries.length} deliveries for ${selectedDateStr}`);
      return mergedDeliveries;

    } catch (error) {
      console.error('❌ [ShowAllDataManager] Failed to load all drivers data:', error);
      return currentDeliveries;
    }
  }

  /**
   * Hook into smart refresh to ensure Show All data is loaded
   * Call this after smart refresh completes
   */
  async validateDataAfterRefresh(currentDeliveries, selectedDateStr, selectedDriverId, updateCallback) {
    const showAll = this.getShowAllState();
    const isAllDriversMode = selectedDriverId === 'all';

    console.log(`🔍 [ShowAllDataManager] Validating data after refresh...`);
    console.log(`   - Show All: ${showAll}, All Drivers Mode: ${isAllDriversMode}`);

    // If neither mode is active, no validation needed
    if (!showAll && !isAllDriversMode) {
      console.log('⏭️ [ShowAllDataManager] Neither Show All nor All Drivers mode - skipping validation');
      return currentDeliveries;
    }

    // Check if we need to load all drivers' data
    const needsData = this.needsAllDriversData(currentDeliveries, selectedDateStr, selectedDriverId);

    if (needsData) {
      console.log('🔄 [ShowAllDataManager] Loading missing drivers\' data...');
      return await this.ensureAllDriversDataLoaded(selectedDateStr, currentDeliveries, updateCallback);
    }

    console.log('✅ [ShowAllDataManager] Data validation passed');
    return currentDeliveries;
  }

  /**
   * Subscribe to show all state changes
   */
  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Notify listeners of state change
   */
  notifyListeners(data) {
    this.listeners.forEach(listener => {
      try {
        listener(data);
      } catch (error) {
        console.error('ShowAllDataManager listener error:', error);
      }
    });
  }
}

export const showAllDataManager = new ShowAllDataManager();