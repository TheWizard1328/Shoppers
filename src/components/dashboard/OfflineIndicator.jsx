import React, { useState, useEffect } from 'react';
import { offlineManager } from '../utils/offlineManager';
import { WifiOff, Wifi, Upload } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export default function OfflineIndicator() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pendingCount, setPendingCount] = useState(0);
  const [showSyncSuccess, setShowSyncSuccess] = useState(false);

  useEffect(() => {
    const unsubscribe = offlineManager.subscribe((online) => {
      setIsOnline(online);
      
      // Show sync success message when coming back online
      if (online && pendingCount > 0) {
        setShowSyncSuccess(true);
        setTimeout(() => setShowSyncSuccess(false), 3000);
      }
    });

    // Update pending count every second
    const interval = setInterval(() => {
      setPendingCount(offlineManager.getPendingActionsCount());
    }, 1000);

    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, [pendingCount]);

  if (isOnline && pendingCount === 0 && !showSyncSuccess) {
    return null;
  }

  return (
    <AnimatePresence>
      {!isOnline || pendingCount > 0 || showSyncSuccess ? (
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          className={`fixed top-2 left-1/2 -translate-x-1/2 z-[10020] ${
            showSyncSuccess ? 'bg-emerald-500' : !isOnline ? 'bg-red-500' : 'bg-amber-500'
          } text-white px-4 py-2 rounded-lg shadow-lg flex items-center gap-2`}
        >
          {showSyncSuccess ? (
            <>
              <Wifi className="w-4 h-4" />
              <span className="text-sm font-medium">
                Synced {pendingCount} changes
              </span>
            </>
          ) : !isOnline ? (
            <>
              <WifiOff className="w-4 h-4" />
              <span className="text-sm font-medium">Offline Mode</span>
              {pendingCount > 0 && (
                <span className="bg-white/20 px-2 py-0.5 rounded text-xs">
                  {pendingCount} pending
                </span>
              )}
            </>
          ) : (
            <>
              <Upload className="w-4 h-4 animate-pulse" />
              <span className="text-sm font-medium">
                Syncing {pendingCount} changes...
              </span>
            </>
          )}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}