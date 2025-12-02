import React, { useState, useEffect } from 'react';
import { useAppData } from "../utils/AppDataContext";
import { RefreshCw } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { isAppOwner } from '../utils/userRoles';
import { useUser } from '../utils/UserContext';

/**
 * Smart Refresh Indicator - Shows app owners when smart refresh is active
 * and which entities were updated (A=AppUser, P=Patient, D=Delivery, S=Store)
 */
export default function SmartRefreshIndicator() {
  const { smartRefreshActivity, isEntityUpdating } = useAppData();
  const { currentUser } = useUser();
  const [recentUpdates, setRecentUpdates] = useState([]);

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

  // Only show for app owners
  if (!currentUser || !isAppOwner(currentUser)) {
    return null;
  }

  const isActive = smartRefreshActivity?.active;
  const isPaused = isEntityUpdating;
  const hasUpdates = recentUpdates.length > 0;

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
    <div className="flex flex-col items-center gap-1">
      {/* Spinning icon when active, paused indicator, or static when idle */}
      <div 
        className={`w-6 h-6 rounded-full flex items-center justify-center transition-colors ${
          isPaused ? 'bg-yellow-100' : isActive ? 'bg-blue-100' : 'bg-slate-100'
        }`}
        title={isPaused ? 'Smart refresh paused' : isActive ? 'Smart refresh active' : 'Smart refresh idle'}
      >
        {isActive && !isPaused ? (
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
          >
            <RefreshCw className="w-3.5 h-3.5 text-blue-500" />
          </motion.div>
        ) : isPaused ? (
          <div className="w-2 h-2 rounded-full bg-yellow-500" />
        ) : (
          <RefreshCw className="w-3.5 h-3.5 text-slate-400" />
        )}
      </div>

      {/* Updated entities badges - vertical stack */}
      <AnimatePresence>
        {hasUpdates && (
          <motion.div
            initial={{ opacity: 0, y: -5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            className="flex flex-col gap-0.5"
          >
            {recentUpdates.map((entity) => (
              <motion.div
                key={entity}
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                exit={{ scale: 0 }}
                className={`w-5 h-5 rounded text-[10px] font-bold text-white flex items-center justify-center ${entityColors[entity] || 'bg-slate-500'}`}
                title={entity}
              >
                {entityLabels[entity] || '?'}
              </motion.div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}