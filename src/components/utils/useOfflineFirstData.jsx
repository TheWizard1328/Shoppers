import { useState, useEffect, useCallback, useRef } from 'react';
import { offlineDB } from './offlineDatabase';

/**
 * Hook that implements offline-first data loading strategy.
 * 
 * Strategy:
 * 1. Load data from offline DB IMMEDIATELY (synchronous or near-synchronous)
 * 2. Show offline data to user right away
 * 3. In background, fetch from API to check for updates
 * 4. Only update UI if data actually changed (compare checksums)
 * 5. If API fails, keep showing offline data (no errors to user)
 */
export const useOfflineFirstData = (entityName, query = {}, onlineDataFetcher) => {
  const [data, setData] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isOnlineRefreshing, setIsOnlineRefreshing] = useState(false);
  const offlineDataChecksumRef = useRef(null);
  const onlineDataChecksumRef = useRef(null);
  const hasInitialLoadRef = useRef(false);

  // Simple checksum to detect data changes
  const calculateChecksum = useCallback((dataArray) => {
    if (!dataArray || dataArray.length === 0) return 'empty';
    
    try {
      const sortedIds = dataArray
        .filter(item => item?.id)
        .map(item => item.id)
        .sort()
        .join(',');
      return `${dataArray.length}_${sortedIds.substring(0, 100)}`;
    } catch (e) {
      return 'error';
    }
  }, []);

  // STEP 1: Load from offline DB immediately
  const loadOfflineData = useCallback(async () => {
    try {
      console.log(`📦 [${entityName}] Loading offline data...`);
      const offlineData = await offlineDB.getAll(entityName);
      
      if (offlineData && offlineData.length > 0) {
        const checksum = calculateChecksum(offlineData);
        offlineDataChecksumRef.current = checksum;
        setData(offlineData);
        console.log(`✓ [${entityName}] Offline data loaded: ${offlineData.length} items (${checksum})`);
        return true;
      } else {
        console.log(`⚠ [${entityName}] No offline data available`);
        return false;
      }
    } catch (err) {
      console.warn(`⚠ [${entityName}] Failed to load offline data:`, err);
      return false;
    }
  }, [entityName, calculateChecksum]);

  // STEP 2: Background sync with online API
  const syncWithOnline = useCallback(async () => {
    if (!onlineDataFetcher) return;

    try {
      setIsOnlineRefreshing(true);
      console.log(`🔄 [${entityName}] Background sync starting...`);
      
      const onlineData = await onlineDataFetcher();
      
      if (!onlineData) {
        console.warn(`⚠ [${entityName}] Online fetch returned null`);
        setIsOnlineRefreshing(false);
        return;
      }

      const onlineChecksum = calculateChecksum(onlineData);
      const offlineChecksum = offlineDataChecksumRef.current;

      console.log(`📊 [${entityName}] Checksum comparison:`, {
        offline: offlineChecksum,
        online: onlineChecksum,
        changed: onlineChecksum !== offlineChecksum
      });

      // Only update UI if data actually changed
      if (onlineChecksum !== offlineChecksum) {
        console.log(`✓ [${entityName}] Data changed - updating UI`);
        onlineDataChecksumRef.current = onlineChecksum;
        setData(onlineData);
        
        // Save to offline DB for next time
        try {
          await offlineDB.bulkSave(entityName, onlineData);
          console.log(`💾 [${entityName}] Saved ${onlineData.length} items to offline DB`);
        } catch (dbErr) {
          console.warn(`⚠ [${entityName}] Failed to save to offline DB:`, dbErr);
        }
      } else {
        console.log(`↔ [${entityName}] No changes detected - keeping current data`);
      }

      setError(null);
    } catch (err) {
      console.warn(`⚠ [${entityName}] Background sync failed (will keep showing offline data):`, err.message);
      // CRITICAL: Don't show error to user - just keep displaying offline data
      // setError stays null so UI doesn't show error state
    } finally {
      setIsOnlineRefreshing(false);
    }
  }, [entityName, onlineDataFetcher, calculateChecksum]);

  // Initial load + background sync
  useEffect(() => {
    const initializeData = async () => {
      // STEP 1: Load offline data immediately
      const hasOfflineData = await loadOfflineData();
      
      // Mark initial load as complete
      if (hasOfflineData) {
        setIsLoading(false);
        hasInitialLoadRef.current = true;
      }

      // STEP 2: Background sync (non-blocking)
      // If we have offline data, show it while syncing in background
      // If we don't have offline data, wait for online fetch
      if (hasOfflineData) {
        // Fire and forget - sync in background
        syncWithOnline().catch(err => console.warn(`Background sync error: ${err}`));
      } else {
        // No offline data - wait for online fetch
        await syncWithOnline();
        setIsLoading(false);
        hasInitialLoadRef.current = true;
      }
    };

    initializeData();
  }, [loadOfflineData, syncWithOnline]);

  return {
    data,
    isLoading: isLoading && data.length === 0, // Only show loading if we have no data at all
    error,
    isOnlineRefreshing,
    hasOfflineData: hasInitialLoadRef.current && !isOnlineRefreshing
  };
};

/**
 * Helper hook to wrap multiple entity loads with offline-first strategy
 */
export const useOfflineFirstEntities = (entityConfigs) => {
  const results = {};
  const [isLoadingAny, setIsLoadingAny] = useState(true);

  const loaders = Object.entries(entityConfigs).map(([key, config]) => {
    const result = useOfflineFirstData(config.name, config.query, config.fetcher);
    results[key] = result;
    return result;
  });

  useEffect(() => {
    const allLoading = loaders.some(r => r.isLoading);
    setIsLoadingAny(allLoading);
  }, [loaders]);

  return {
    ...results,
    isLoadingAny
  };
};