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

  // Clear updates after 3 seconds
  useEffect(() => {
    if (recentUpdates.length > 0) {
      const timer = setTimeout(() => {
        setRecentUpdates([]);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [recentUpdates]);

  // Track which entities were updated
  useEffect(() => {
    if (smartRefreshActivity?.updatedEntities) {
      setRecentUpdates(smartRefreshActivity.updatedEntities);
    }
  }, [smartRefreshActivity?.updatedEntities]);

  // Subscribe to online/offline status
  useEffect(() => {
    const unsubscribe = offlineManager.subscribe((online) => {
      setIsOnline(online);
    });
    return unsubscribe;
  }, []);

  // Only show for app owners
  if (!currentUser || !isAppOwner(currentUser)) {
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

  return (
    <div className="flex flex-col items-center gap-1 z-[601]">
      {/* Spinning icon when active, paused indicator, or static when idle */}
      <div
        className={`w-6 h-6 rounded-full flex items-center justify-center transition-colors ${
        !isOnline ? 'bg-red-500' : isPaused ? 'bg-yellow-100' : isActive ? 'bg-emerald-500' : 'bg-slate-100'}`
        }
        title={!isOnline ? 'Offline - changes will sync when online' : isPaused ? 'Smart refresh paused' : isActive ? 'Smart refresh active' : 'Smart refresh idle'}>

        {!isOnline ?
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 1, repeat: Infinity, ease: "linear" }}>

            <RefreshCw className="w-3.5 h-3.5 text-white" />
          </motion.div> :
        isActive && !isPaused ?
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 1, repeat: Infinity, ease: "linear" }}>

            <RefreshCw className="w-3.5 h-3.5 text-white" />
          </motion.div> :
        isPaused ?
        <div className="w-2 h-2 rounded-full bg-yellow-500" /> :

        <RefreshCw className="w-3.5 h-3.5 text-slate-400" />
        }
      </div>

      {/* Updated entities badges - vertical stack */}
      <AnimatePresence>
        {hasUpdates &&
        <motion.div
          initial={{ opacity: 0, y: -5 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -5 }}
          className="flex flex-col gap-0.5">

            {recentUpdates.map((entity) =>
          <motion.div
            key={entity}
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0 }}
            className={`w-5 h-5 rounded text-[10px] font-bold text-white flex items-center justify-center ${entityColors[entity] || 'bg-slate-500'}`}
            title={entity}>

                {entityLabels[entity] || '?'}
              </motion.div>
          )}
          </motion.div>
        }
      </AnimatePresence>
    </div>);

}