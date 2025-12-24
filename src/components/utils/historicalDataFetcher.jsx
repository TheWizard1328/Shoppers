/**
 * Historical Data Fetcher
 * Handles on-demand fetching of data older than the local cache window (3 months)
 * For deep historical analysis, patient metrics, and reporting
 */

import { Delivery } from '@/entities/Delivery';
import { format, subDays, subMonths, parseISO } from 'date-fns';

const LOCAL_CACHE_DAYS = 90; // 3 months - data beyond this is fetched on-demand

// In-memory cache for historical requests (per session)
const historicalCache = new Map();
const HISTORICAL_CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

/**
 * Check if a date is within the local cache window (last 3 months)
 * @param {string|Date} date - Date to check
 * @returns {boolean} - True if within local cache window
 */
export const isWithinLocalCache = (date) => {
  const checkDate = typeof date === 'string' ? parseISO(date) : date;
  const cutoffDate = subDays(new Date(), LOCAL_CACHE_DAYS);
  return checkDate >= cutoffDate;
};

/**
 * Get the local cache cutoff date
 * @returns {Date} - The oldest date in the local cache
 */
export const getLocalCacheCutoffDate = () => {
  return subDays(new Date(), LOCAL_CACHE_DAYS);
};

/**
 * Fetch deliveries for a specific patient - includes both local and historical data
 * @param {string} patientId - Patient ID
 * @param {object} options - Options: { includeHistorical: boolean, maxMonths: number }
 * @returns {Promise<Array>} - All deliveries for the patient
 */
export const fetchPatientDeliveries = async (patientId, options = {}) => {
  const { includeHistorical = true, maxMonths = 12 } = options;
  
  if (!patientId) return [];
  
  const cacheKey = `patient_deliveries_${patientId}_${maxMonths}`;
  
  // Check session cache
  const cached = historicalCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < HISTORICAL_CACHE_DURATION)) {
    return cached.data;
  }
  
  try {
    // Fetch all deliveries for this patient from backend
    // This is more efficient than date-range queries for single patient
    const deliveries = await Delivery.filter({ patient_id: patientId }, '-delivery_date');
    
    // Filter by maxMonths if specified
    if (maxMonths && maxMonths < 120) { // Cap at 10 years
      const cutoffDate = subMonths(new Date(), maxMonths);
      const cutoffStr = format(cutoffDate, 'yyyy-MM-dd');
      const filtered = deliveries.filter(d => d.delivery_date >= cutoffStr);
      
      historicalCache.set(cacheKey, { data: filtered, timestamp: Date.now() });
      return filtered;
    }
    
    historicalCache.set(cacheKey, { data: deliveries, timestamp: Date.now() });
    return deliveries;
  } catch (error) {
    console.error(`❌ [HistoricalDataFetcher] Error fetching patient deliveries:`, error);
    return [];
  }
};

/**
 * Fetch deliveries for a specific driver over a date range
 * @param {string} driverId - Driver ID
 * @param {string} startDate - Start date (yyyy-MM-dd)
 * @param {string} endDate - End date (yyyy-MM-dd)
 * @returns {Promise<Array>} - Deliveries for the driver in that range
 */
export const fetchDriverDeliveries = async (driverId, startDate, endDate) => {
  if (!driverId) return [];
  
  const cacheKey = `driver_deliveries_${driverId}_${startDate}_${endDate}`;
  
  // Check session cache
  const cached = historicalCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < HISTORICAL_CACHE_DURATION)) {
    return cached.data;
  }
  
  try {
    const deliveries = await Delivery.filter({
      driver_id: driverId,
      delivery_date: {
        $gte: startDate,
        $lte: endDate
      }
    }, '-delivery_date');
    
    historicalCache.set(cacheKey, { data: deliveries, timestamp: Date.now() });
    return deliveries;
  } catch (error) {
    console.error(`❌ [HistoricalDataFetcher] Error fetching driver deliveries:`, error);
    return [];
  }
};

/**
 * Fetch deliveries for a date range (for metrics/reporting)
 * @param {string} startDate - Start date (yyyy-MM-dd)
 * @param {string} endDate - End date (yyyy-MM-dd)
 * @param {object} filters - Additional filters (store_id, driver_id, etc.)
 * @returns {Promise<Array>} - Deliveries in that range
 */
export const fetchDeliveriesForRange = async (startDate, endDate, filters = {}) => {
  const cacheKey = `range_deliveries_${startDate}_${endDate}_${JSON.stringify(filters)}`;
  
  // Check session cache
  const cached = historicalCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < HISTORICAL_CACHE_DURATION)) {
    return cached.data;
  }
  
  try {
    const query = {
      ...filters,
      delivery_date: {
        $gte: startDate,
        $lte: endDate
      }
    };
    
    const deliveries = await Delivery.filter(query, '-delivery_date');
    
    historicalCache.set(cacheKey, { data: deliveries, timestamp: Date.now() });
    return deliveries;
  } catch (error) {
    console.error(`❌ [HistoricalDataFetcher] Error fetching deliveries for range:`, error);
    return [];
  }
};

/**
 * Fetch monthly aggregated stats for reporting (server-side would be more efficient)
 * @param {number} months - Number of months to fetch
 * @param {object} filters - Additional filters
 * @returns {Promise<Array>} - Monthly stats
 */
export const fetchMonthlyStats = async (months = 12, filters = {}) => {
  const cacheKey = `monthly_stats_${months}_${JSON.stringify(filters)}`;
  
  // Check session cache
  const cached = historicalCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < HISTORICAL_CACHE_DURATION)) {
    return cached.data;
  }
  
  try {
    const today = new Date();
    const startDate = format(subMonths(today, months), 'yyyy-MM-dd');
    const endDate = format(today, 'yyyy-MM-dd');
    
    const deliveries = await fetchDeliveriesForRange(startDate, endDate, filters);
    
    // Aggregate by month
    const monthlyStats = {};
    deliveries.forEach(d => {
      if (!d.delivery_date) return;
      const monthKey = d.delivery_date.substring(0, 7); // yyyy-MM
      
      if (!monthlyStats[monthKey]) {
        monthlyStats[monthKey] = {
          month: monthKey,
          total: 0,
          completed: 0,
          failed: 0,
          cancelled: 0
        };
      }
      
      monthlyStats[monthKey].total++;
      if (d.status === 'completed' || d.status === 'delivered') {
        monthlyStats[monthKey].completed++;
      } else if (d.status === 'failed') {
        monthlyStats[monthKey].failed++;
      } else if (d.status === 'cancelled') {
        monthlyStats[monthKey].cancelled++;
      }
    });
    
    const stats = Object.values(monthlyStats).sort((a, b) => a.month.localeCompare(b.month));
    
    historicalCache.set(cacheKey, { data: stats, timestamp: Date.now() });
    return stats;
  } catch (error) {
    console.error(`❌ [HistoricalDataFetcher] Error fetching monthly stats:`, error);
    return [];
  }
};

/**
 * Clear historical cache (e.g., on logout or data change)
 */
export const clearHistoricalCache = () => {
  historicalCache.clear();
};

/**
 * Get cache stats for debugging
 */
export const getHistoricalCacheStats = () => {
  return {
    size: historicalCache.size,
    keys: Array.from(historicalCache.keys())
  };
};