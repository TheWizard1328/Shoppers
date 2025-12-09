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
  const { smartRefreshActivity, isEntityUpdating, refreshData } = useAppData();
  const { currentUser } = useUser();
  const [recentUpdates, setRecentUpdates] = useState([]);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const [currentDisplayIndex, setCurrentDisplayIndex] = useState(0);

  // Track which entities were updated and reset index
  useEffect(() => {
    if (smartRefreshActivity?.updatedEntities && smartRefreshActivity.updatedEntities.length > 0) {
      setRecentUpdates(smartRefreshActivity.updatedEntities);
      setCurrentDisplayIndex(0);
      
      // Clear after 3 seconds (regardless of number of entities)
      const timer = setTimeout(() => {
        setRecentUpdates([]);
        setCurrentDisplayIndex(0);
      }, 3000);
      
      return () => clearTimeout(timer);
    }
  }, [smartRefreshActivity]);

  // Cycle through entities - show each for 1 second
  useEffect(() => {
    if (recentUpdates.length <= 1) return;
    
    const interval = setInterval(() => {
      setCurrentDisplayIndex(prev => (prev + 1) % recentUpdates.length);
    }, 1000);
    
    return () => clearInterval(interval);
  }, [recentUpdates.length]);

  // Subscribe to online/offline status
  useEffect(() => {
    const unsubscribe = offlineManager.subscribe((online) => {
      setIsOnline(online);
    });
    return unsubscribe;
  }, []);

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
      // Reset all refresh timers to force immediate refresh
      smartRefreshManager.lastRefreshTimes = {
        driverLocation: 0,
        activeDeliveries: 0,
        todayDeliveries: 0,
        appUsers: 0,
        patients: 0,
        stores: 0
      };

      // Trigger the callback if provided (Dashboard uses this)
      if (onManualRefresh) {
        await onManualRefresh();
      } else if (refreshData) {
        await refreshData(true);
      }
      
      // Notify that refresh is complete for UI updates
      window.dispatchEvent(new CustomEvent('manualRefreshComplete'));
    } catch (error) {
      console.error('❌ [SmartRefreshIndicator] Manual refresh failed:', error);
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
          className="w-7 h-7 rounded-full flex items-center justify-center transition-all hover:scale-110 bg-slate-200 hover:bg-slate-300 relative"
          title={!isOnline ? 'Offline' : isPaused ? 'Refresh paused' : 'Click to refresh'}>
          
          {isActive && !isPaused ? (
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 1, repeat: Infinity, ease: "linear" }}>
              <RefreshCw className="w-3 h-3 text-slate-500" />
            </motion.div>
          ) : isPaused ? (
            <div className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
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
        !isOnline ? 'bg-red-500' : isPaused ? 'bg-yellow-100 cursor-not-allowed' : isActive ? 'bg-emerald-500' : 'bg-slate-100 hover:bg-slate-200'}`
        }
        title={!isOnline ? 'Offline - changes will sync when online' : isPaused ? 'Smart refresh paused' : 'Click to refresh'}>

        {!isOnline ? (
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