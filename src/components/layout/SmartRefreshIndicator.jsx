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
  
  // Track which manager is active
  const [activeManager, setActiveManager] = useState(null); // 'smart', 'offline', 'polling'
  const [isSmartRefreshActive, setIsSmartRefreshActive] = useState(false);
  const [isOfflineSyncActive, setIsOfflineSyncActive] = useState(false);
  const [isPollingActive, setIsPollingActive] = useState(false);
  
  // CRITICAL: Track smartRefreshManager.isRefreshing directly
  const isRefreshingRef = React.useRef(false);

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

  // Track smart refresh, offline sync, and polling manager states
  useEffect(() => {
    if (typeof window !== 'undefined') {
      // CRITICAL: Track smart refresh state by polling isRefreshing flag every 50ms
      const checkSmartRefresh = () => {
        const isRefreshing = smartRefreshManager?.isRefreshing || false;
        
        // Update state only when it changes to prevent re-renders
        if (isRefreshing !== isRefreshingRef.current) {
          isRefreshingRef.current = isRefreshing;
          setIsSmartRefreshActive(isRefreshing);
          
          if (isRefreshing) {
            console.log('🟢 [Indicator] Smart refresh STARTED - showing green spinner');
          } else {
            console.log('⚪ [Indicator] Smart refresh ENDED - hiding green spinner');
          }
        }
      };
      
      // Track offline sync state
      const handleOfflineSyncStart = () => setIsOfflineSyncActive(true);
      const handleOfflineSyncComplete = () => setIsOfflineSyncActive(false);
      
      // Track polling manager state  
      const handlePollingStart = () => setIsPollingActive(true);
      const handlePollingComplete = () => setIsPollingActive(false);
      
      // Check smart refresh every 50ms for responsive updates
      const smartRefreshInterval = setInterval(checkSmartRefresh, 50);
      
      window.addEventListener('offlineSyncStarted', handleOfflineSyncStart);
      window.addEventListener('offlineSyncComplete', handleOfflineSyncComplete);
      window.addEventListener('driverLocationPollingStarted', handlePollingStart);
      window.addEventListener('driverLocationPollingComplete', handlePollingComplete);
      
      return () => {
        clearInterval(smartRefreshInterval);
        window.removeEventListener('offlineSyncStarted', handleOfflineSyncStart);
        window.removeEventListener('offlineSyncComplete', handleOfflineSyncComplete);
        window.removeEventListener('driverLocationPollingStarted', handlePollingStart);
        window.removeEventListener('driverLocationPollingComplete', handlePollingComplete);
      };
    }
  }, []);

  // Determine active manager and color
  useEffect(() => {
    if (isSmartRefreshActive) {
      setActiveManager('smart');
    } else if (isOfflineSyncActive) {
      setActiveManager('offline');
    } else if (isPollingActive) {
      setActiveManager('polling');
    } else {
      setActiveManager(null);
    }
  }, [isSmartRefreshActive, isOfflineSyncActive, isPollingActive]);

  // Real-time sync broadcasts removed

  // Show for all users (removed app owner restriction)
  if (!currentUser) {
    return null;
  }

  const isActive = smartRefreshActivity?.active || isManualRefreshing || activeManager !== null;
  const isPaused = isEntityUpdating;
  const hasUpdates = recentUpdates.length > 0;
  
  // Determine spinner color based on active manager
  const getSpinnerColor = () => {
    if (hasError) return 'bg-red-500';
    if (isPaused) return 'bg-yellow-100';
    if (!isOnline) return 'bg-red-500';
    
    switch (activeManager) {
      case 'smart': return 'bg-emerald-500'; // Green for smart refresh
      case 'offline': return 'bg-purple-500'; // Purple for offline sync
      case 'polling': return 'bg-blue-500'; // Blue for polling
      default: return isActive ? 'bg-emerald-500' : 'bg-slate-200 hover:bg-slate-300';
    }
  };

  // Handle manual refresh click - Targeted refresh for Dashboard
  const handleManualRefresh = async () => {
    if (isManualRefreshing || isPaused) return;

    const currentPath = window.location.pathname;
    console.log(`🔄 [SmartRefreshIndicator] Manual refresh triggered on ${currentPath}`);
    setIsManualRefreshing(true);

    try {
      // CRITICAL: Use targetedRefresh for Dashboard, fallback to page-specific for others
      if (currentPath.includes('/dashboard') || currentPath === '/') {
        console.log('🎯 [Manual Refresh] Using targeted refresh for Dashboard');
        
        // Trigger pull-to-sync programmatically (silent mode - no overlay)
        window.dispatchEvent(new CustomEvent('triggerPullToSync', {
          detail: { silent: true }
        }));
        
        console.log('✅ [Manual Refresh] Triggered targeted refresh');
      } else {
        // Fallback: page-specific sync for non-Dashboard pages
        const { offlineDB } = await import('../utils/offlineDatabase');
        const { base44 } = await import('@/api/base44Client');
        
        const entitiesToSync = [];
        
        if (currentPath.includes('/deliveries')) {
          entitiesToSync.push('Delivery', 'Patient', 'Store', 'AppUser');
        } else if (currentPath.includes('/patients')) {
          entitiesToSync.push('Patient', 'Store');
        } else if (currentPath.includes('/stores')) {
          entitiesToSync.push('Store');
        } else if (currentPath.includes('/users') || currentPath.includes('/app-users')) {
          entitiesToSync.push('AppUser');
        } else if (currentPath.includes('/payroll')) {
          entitiesToSync.push('Delivery', 'AppUser', 'Payroll');
        } else {
          entitiesToSync.push('Delivery', 'Patient', 'AppUser', 'Store');
        }
        
        console.log(`   📊 Syncing entities for current page: ${entitiesToSync.join(', ')}`);
        
        window.dispatchEvent(new CustomEvent('offlineSyncStarted'));
        
        for (const entityName of entitiesToSync) {
          try {
            console.log(`   🔄 Syncing ${entityName}...`);
            
            // CRITICAL: Wait 2 seconds between each entity to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            const data = await base44.entities[entityName].list();
            await offlineDB.bulkSave(offlineDB.STORES[entityName.toUpperCase() + 'S'] || entityName.toLowerCase() + 's', data);
            console.log(`   ✅ Synced ${data.length} ${entityName} records to offline DB`);
            
            window.dispatchEvent(new CustomEvent('offlineSyncProgress', {
              detail: { entity: entityName, count: data.length }
            }));
          } catch (error) {
            console.warn(`   ⚠️ Failed to sync ${entityName}:`, error.message);
          }
        }
        
        window.dispatchEvent(new CustomEvent('offlineSyncComplete'));
        
        if (onManualRefresh) {
          await onManualRefresh();
        } else if (refreshData) {
          await refreshData(true);
        }
      }
      
      console.log('✅ [SmartRefreshIndicator] Manual refresh complete');
    } catch (error) {
      console.error('❌ [SmartRefreshIndicator] Manual refresh failed:', error);
      setHasError(true);
      setTimeout(() => setHasError(false), 3000);
    } finally {
      // CRITICAL: Listen for pull-to-sync completion to stop spinner and refresh payroll stats
      const handleSyncComplete = async () => {
        try {
          // CRITICAL: Dispatch event to Dashboard to trigger payroll stats refresh
          // The event will be caught by Dashboard's useEffect which has access to selectedDriverId and selectedDate
          window.dispatchEvent(new CustomEvent('refreshPayrollStatsAfterSync'));
        } catch (error) {
          console.warn('⚠️ [Manual Refresh] Failed to trigger payroll stats refresh:', error.message);
        }
        
        setIsManualRefreshing(false);
        window.removeEventListener('pullToSyncComplete', handleSyncComplete);
      };
      
      // Add listener for completion
      window.addEventListener('pullToSyncComplete', handleSyncComplete);
      
      // Fallback timeout in case event doesn't fire
      setTimeout(() => {
        handleSyncComplete();
      }, 5000);
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
          data-offline-sync-button
          onClick={handleManualRefresh}
          disabled={isPaused}
          className={`w-7 h-7 rounded-full flex items-center justify-center transition-colors duration-200 hover:scale-110 relative ${getSpinnerColor()} ${isActive && !isPaused ? 'shadow-lg' : ''}`}
          title={hasError ? 'Refresh error' : !isOnline ? 'Offline' : isPaused ? 'Refresh paused' : 
                 activeManager === 'smart' ? 'Smart Refresh active' : 
                 activeManager === 'offline' ? 'Offline Sync active' : 
                 activeManager === 'polling' ? 'Location Polling active' : 
                 'Click to refresh'}>
          
          {isActive && !isPaused ? (
            <motion.div
              key="spinner-active"
              animate={{ rotate: 360 }}
              transition={{ duration: 1, repeat: Infinity, ease: "linear" }}>
              <RefreshCw className="w-3 h-3 text-white drop-shadow-md" />
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
        className={`w-6 h-6 rounded-full flex items-center justify-center transition-colors duration-200 hover:scale-110 relative ${getSpinnerColor()} ${isActive && !isPaused ? 'shadow-xl' : ''}`}
        title={hasError ? 'Refresh error - click to retry' : !isOnline ? 'Offline - changes will sync when online' : isPaused ? 'Smart refresh paused' : 
               activeManager === 'smart' ? 'Smart Refresh active' : 
               activeManager === 'offline' ? 'Offline Sync active' : 
               activeManager === 'polling' ? 'Location Polling active' : 
               'Click to refresh'}>

        {hasError ? (
          <RefreshCw className="w-3.5 h-3.5 text-white" />
        ) : !isOnline ? (
          <motion.div
            key="spinner-offline"
            animate={{ rotate: 360 }}
            transition={{ duration: 1, repeat: Infinity, ease: "linear" }}>
            <RefreshCw className="w-3.5 h-3.5 text-white drop-shadow-lg" />
          </motion.div>
        ) : isActive && !isPaused ? (
          <motion.div
            key="spinner-active"
            animate={{ rotate: 360 }}
            transition={{ duration: 1, repeat: Infinity, ease: "linear" }}>
            <RefreshCw className="w-3.5 h-3.5 text-white drop-shadow-lg" />
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