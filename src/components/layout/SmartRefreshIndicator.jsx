import React, { useState, useEffect } from 'react';
import { useAppData } from "../utils/AppDataContext";
import { RefreshCw } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { isAppOwner } from '../utils/userRoles';
import { useUser } from '../utils/UserContext';
import { offlineManager } from '../utils/offlineManager';
import { smartRefreshManager } from '../utils/smartRefreshManager';

/**
 * Smart Refresh Indicator - Shows app owners when smart refresh is active
 * and which entities were updated (A=AppUser, P=Patient, D=Delivery, S=Store)
 * Now inline and clickable to trigger manual refresh
 */
export default function SmartRefreshIndicator({ inline = false, onManualRefresh }) {
  // CRITICAL: Handle missing context gracefully - these hooks may be called outside providers
  let smartRefreshActivity = { active: false, updatedEntities: [] };
  let isEntityUpdating = false;
  let refreshData = null;
  let currentUser = null;
  
  try {
    const appData = useAppData();
    if (appData) {
      smartRefreshActivity = appData.smartRefreshActivity || { active: false, updatedEntities: [] };
      isEntityUpdating = appData.isEntityUpdating || false;
      refreshData = appData.refreshData;
    }
  } catch (e) {
    // Context not available, use defaults
  }
  
  try {
    const userData = useUser();
    if (userData) {
      currentUser = userData.currentUser;
    }
  } catch (e) {
    // Context not available, use defaults
  }
  
  const [recentUpdates, setRecentUpdates] = useState([]);
  const [isOnline, setIsOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true);
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const [currentDisplayIndex, setCurrentDisplayIndex] = useState(0);
  const [hasError, setHasError] = useState(false);

  // Track which entities were updated and reset index
  // CRITICAL: Use a ref to track the timeout so we can clear it properly
  const clearTimeoutRef = React.useRef(null);
  const cycleIntervalRef = React.useRef(null);
  
  useEffect(() => {
    // Clear any pending timeouts/intervals when dependencies change
    if (clearTimeoutRef.current) {
      clearTimeout(clearTimeoutRef.current);
      clearTimeoutRef.current = null;
    }
    if (cycleIntervalRef.current) {
      clearInterval(cycleIntervalRef.current);
      cycleIntervalRef.current = null;
    }
    
    if (smartRefreshActivity?.updatedEntities && smartRefreshActivity.updatedEntities.length > 0) {
      setRecentUpdates(smartRefreshActivity.updatedEntities);
      setCurrentDisplayIndex(0);
      
      // CRITICAL: Start cycling through entity badges ONLY while refresh is active
      if (smartRefreshActivity.active && smartRefreshActivity.updatedEntities.length > 1) {
        cycleIntervalRef.current = setInterval(() => {
          setCurrentDisplayIndex(prev => (prev + 1) % smartRefreshActivity.updatedEntities.length);
        }, 1000);
      }
    } else if (!smartRefreshActivity?.active) {
      // CRITICAL: Immediately clear entity badges when refresh completes
      // This prevents flickering and ensures spinner icon returns
      setRecentUpdates([]);
      setCurrentDisplayIndex(0);
    }
    
    return () => {
      if (clearTimeoutRef.current) {
        clearTimeout(clearTimeoutRef.current);
        clearTimeoutRef.current = null;
      }
      if (cycleIntervalRef.current) {
        clearInterval(cycleIntervalRef.current);
        cycleIntervalRef.current = null;
      }
    };
  }, [smartRefreshActivity?.active, smartRefreshActivity?.updatedEntities]);

  // Subscribe to online/offline status
  useEffect(() => {
    const unsubscribe = offlineManager.subscribe((online) => {
      setIsOnline(online);
    });
    return unsubscribe;
  }, []);

  // Subscribe to rate limit errors from smartRefreshManager
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const handleRateLimitError = (event) => {
        setHasError(event.detail.hasError);
        // Clear error after 5 seconds
        if (event.detail.hasError) {
          setTimeout(() => setHasError(false), 5000);
        }
      };
      
      window.addEventListener('rateLimitError', handleRateLimitError);
      return () => window.removeEventListener('rateLimitError', handleRateLimitError);
    }
  }, []);

  // Real-time sync broadcasts removed

  // Show for all users (removed app owner restriction)
  if (!currentUser) {
    return null;
  }

  const isActive = smartRefreshActivity?.active || isManualRefreshing;
  const isPaused = isEntityUpdating;
  const hasUpdates = recentUpdates.length > 0;

  // Handle manual refresh click
  const handleManualRefresh = async () => {
    if (isManualRefreshing || isPaused) return;

    console.log('🔄 [SmartRefreshIndicator] Manual refresh triggered');
    setIsManualRefreshing(true);

    try {
      // Step 1: Invalidate all caches
      const { dataManager } = await import('../utils/dataManager');
      console.log('   🗑️ Invalidating all caches...');
      dataManager.invalidateCache('Patient');
      dataManager.invalidateCache('Delivery');
      dataManager.invalidateCache('Store');
      dataManager.invalidateCache('AppUser');
      dataManager.invalidateAllDeliveryRangeCache();

      // Step 2: Reset all refresh timers to force immediate refresh
      smartRefreshManager.lastRefreshTimes = {
        driverLocation: 0,
        activeDeliveries: 0,
        todayDeliveries: 0,
        appUsers: 0,
        patients: 0,
        stores: 0
      };

      // Step 3: Reload data for current screen without clearing UI
      if (onManualRefresh) {
        await onManualRefresh();
      } else if (refreshData) {
        await refreshData(true);
      }

      // Step 4: Force a full sync in background
      const { performBidirectionalSync } = await import('../utils/offlineSync');
      performBidirectionalSync().catch(err => {
        console.warn('⚠️ Background sync error:', err);
      });

      // Trigger route re-optimization event for Dashboard
      window.dispatchEvent(new CustomEvent('triggerRouteReoptimization'));
      
      console.log('✅ [SmartRefreshIndicator] Manual refresh complete');
    } catch (error) {
      console.error('❌ [SmartRefreshIndicator] Manual refresh failed:', error);
      setHasError(true);
      setTimeout(() => setHasError(false), 3000);
    } finally {
      setTimeout(() => setIsManualRefreshing(false), 1000);
    }
  };

  // Entity labels
  const entityLabels = {
    appUsers: 'A',
    patients: 'P',
    deliveries: 'D',
    stores: 'S',
    locations: 'L'
  };

  const entityColors = {
    appUsers: 'bg-blue-500',
    patients: 'bg-purple-500',
    deliveries: 'bg-emerald-500',
    stores: 'bg-orange-500',
    locations: 'bg-cyan-500'
  };

  // Inline version for stats card header
  if (inline) {
    const currentEntity = hasUpdates ? recentUpdates[currentDisplayIndex] : null;
    
    return (
      <div className="flex items-center gap-1">
        <button
          onClick={handleManualRefresh}
          disabled={isPaused}
          className={`w-7 h-7 rounded-full flex items-center justify-center transition-all hover:scale-110 relative ${
            hasError ? 'bg-red-500' : 
            isActive && !isPaused ? 'bg-emerald-500' : 
            isPaused ? 'bg-yellow-100' : 
            'bg-slate-200 hover:bg-slate-300'
          }`}
          title={hasError ? 'Refresh error' : !isOnline ? 'Offline' : isPaused ? 'Refresh paused' : 'Click to refresh'}>
          
          {isActive && !isPaused ? (
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 1, repeat: Infinity, ease: "linear" }}>
              <RefreshCw className="w-3 h-3 text-white" />
            </motion.div>
          ) : isPaused ? (
            <div className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
          ) : hasError ? (
            <RefreshCw className="w-3 h-3 text-white" />
          ) : (
            <RefreshCw className={`w-3 h-3 ${!isOnline ? 'text-white' : 'text-slate-500'}`} />
          )}
          
          {/* Show entity badge on top of spinner */}
          <AnimatePresence mode="wait">
            {hasUpdates && currentEntity && (
              <motion.div
                key={currentEntity}
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className={`absolute inset-0 rounded-full text-[9px] font-bold text-white flex items-center justify-center ${entityColors[currentEntity] || 'bg-slate-500'}`}
                title={currentEntity}>
                {entityLabels[currentEntity] || '?'}
              </motion.div>
            )}
          </AnimatePresence>
        </button>
      </div>
    );
  }

  // Original vertical version for fixed position
  const currentEntity = hasUpdates ? recentUpdates[currentDisplayIndex] : null;
  
  return (
    <div className="flex flex-col items-center gap-1 z-[601]">
      <button
        onClick={handleManualRefresh}
        disabled={isPaused}
        className={`w-6 h-6 rounded-full flex items-center justify-center transition-all hover:scale-110 relative ${
          hasError ? 'bg-red-500' : 
          isActive && !isPaused ? 'bg-emerald-500' : 
          isPaused ? 'bg-yellow-100 cursor-not-allowed' : 
          !isOnline ? 'bg-red-500' : 
          'bg-slate-100 hover:bg-slate-200'
        }`}
        title={hasError ? 'Refresh error - click to retry' : !isOnline ? 'Offline - changes will sync when online' : isPaused ? 'Smart refresh paused' : 'Click to refresh'}>

        {hasError ? (
          <RefreshCw className="w-3.5 h-3.5 text-white" />
        ) : !isOnline ? (
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 1, repeat: Infinity, ease: "linear" }}>
            <RefreshCw className="w-3.5 h-3.5 text-white" />
          </motion.div>
        ) : isActive && !isPaused ? (
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 1, repeat: Infinity, ease: "linear" }}>
            <RefreshCw className="w-3.5 h-3.5 text-white" />
          </motion.div>
        ) : isPaused ? (
          <div className="w-2 h-2 rounded-full bg-yellow-500" />
        ) : (
          <RefreshCw className="w-3.5 h-3.5 text-slate-400" />
        )}
        
        {/* Show entity badge on top of spinner */}
        <AnimatePresence mode="wait">
          {hasUpdates && currentEntity && (
            <motion.div
              key={currentEntity}
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className={`absolute inset-0 rounded-full text-[10px] font-bold text-white flex items-center justify-center ${entityColors[currentEntity] || 'bg-slate-500'}`}
              title={currentEntity}>
              {entityLabels[currentEntity] || '?'}
            </motion.div>
          )}
        </AnimatePresence>
      </button>
    </div>);

}