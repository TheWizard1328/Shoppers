import React, { useState, useEffect, useRef } from 'react';
import { WifiOff, RefreshCw, CheckCircle, AlertTriangle, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { smartRefreshManager } from '../utils/smartRefreshManager';

/**
 * Banner that appears when connection issues are detected
 * Shows recovery status and allows manual retry
 */
export default function ConnectionRecoveryBanner() {
  const [isVisible, setIsVisible] = useState(false);
  const [status, setStatus] = useState('error'); // 'error', 'recovering', 'restored'
  const [errorCount, setErrorCount] = useState(0);
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const [maxAttempts, setMaxAttempts] = useState(5);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [dismissed, setDismissed] = useState(false);
  
  // CRITICAL: Track when we entered recovering state to auto-timeout
  const recoveringStartTime = useRef(null);
  const recoveryTimeoutRef = useRef(null);

  useEffect(() => {
    // Listen for connection errors
    const handleConnectionError = (event) => {
      const { errorCount: count, willRetryIn } = event.detail || {};
      setErrorCount(count || 0);
      setStatus('error');
      setIsVisible(true);
      setDismissed(false);
    };

    // Listen for recovery attempts
    const handleRecoveryAttempt = (event) => {
      const { attempt, maxAttempts: max } = event.detail || {};
      setRecoveryAttempt(attempt || 0);
      setMaxAttempts(max || 5);
      setStatus('recovering');
      setIsVisible(true);
      
      // CRITICAL: Track when recovery started
      if (!recoveringStartTime.current) {
        recoveringStartTime.current = Date.now();
      }
    };

    // Listen for connection restored
    const handleConnectionRestored = async () => {
      setStatus('restored');
      recoveringStartTime.current = null;
      
      // CRITICAL: Trigger full data reload with validation to ensure complete data
      console.log('🔄 [ConnectionRecoveryBanner] Starting validated data recovery...');
      
      try {
        // STEP 1: Import all required utilities
        const { getData, invalidate } = await import('../utils/dataManager');
        const { clearUserCache } = await import('../utils/auth');
        const { base44 } = await import('@/api/base44Client');
        
        // STEP 2: Validate we can actually reach the backend
        try {
          await base44.entities.City.list();
          console.log('✅ [Recovery] Backend connection verified');
        } catch (healthError) {
          console.error('❌ [Recovery] Backend still unreachable:', healthError);
          throw new Error('Backend connection not ready');
        }
        
        // STEP 3: Clear ALL backend caches to force fresh fetch
        console.log('🧹 [Recovery] Clearing all backend caches...');
        clearUserCache();
        invalidate('Delivery');
        invalidate('Patient');
        invalidate('AppUser');
        invalidate('Store');
        invalidate('User');
        invalidate('City');
        
        // STEP 4: CRITICAL - Completely purge offline database to remove stale data
        console.log('🗑️ [Recovery] COMPLETELY PURGING offline database...');
        const { offlineDB } = await import('../utils/offlineDatabase');
        
        // Delete ALL stores from offline DB
        const stores = [
          offlineDB.STORES.DELIVERIES,
          offlineDB.STORES.PATIENTS,
          offlineDB.STORES.APP_USERS,
          offlineDB.STORES.STORES,
          offlineDB.STORES.USERS,
          offlineDB.STORES.CITIES
        ];
        
        for (const store of stores) {
          try {
            await offlineDB.clearStore(store);
            console.log(`✅ [Recovery] Cleared offline store: ${store}`);
          } catch (clearError) {
            console.warn(`⚠️ [Recovery] Failed to clear ${store}:`, clearError.message);
          }
        }
        
        // STEP 5: CRITICAL - Refresh ALL critical data from backend
        console.log('📥 [Recovery] Fetching fresh data from backend...');
        try {
          const [freshAppUsers, freshDeliveries, freshPatients, freshStores, freshCities] = await Promise.all([
            base44.entities.AppUser.list(),
            base44.entities.Delivery.list(),
            base44.entities.Patient.list(),
            base44.entities.Store.list(),
            base44.entities.City.list()
          ]);
          
          console.log(`✅ [Recovery] Fetched fresh data: ${freshAppUsers.length} users, ${freshDeliveries.length} deliveries, ${freshPatients.length} patients, ${freshStores.length} stores, ${freshCities.length} cities`);
          
          // STEP 6: Resync all fresh data to offline DB
          console.log('💾 [Recovery] Resyncing all fresh data to offline DB...');
          await Promise.all([
            offlineDB.bulkSave(offlineDB.STORES.APP_USERS, freshAppUsers),
            offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries),
            offlineDB.bulkSave(offlineDB.STORES.PATIENTS, freshPatients),
            offlineDB.bulkSave(offlineDB.STORES.STORES, freshStores),
            offlineDB.bulkSave(offlineDB.STORES.CITIES, freshCities)
          ]);
          
          console.log('✅ [Recovery] All data resynced to offline DB - duplicate driver IDs purged');
        } catch (fetchError) {
          console.error('❌ [Recovery] Failed to fetch fresh data:', fetchError.message);
          throw fetchError;
        }
        
        // STEP 7: Wait a moment for resync to settle
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // STEP 8: Trigger full UI refresh with newly synced data
        console.log('🔄 [Recovery] Triggering full UI refresh...');
        window.dispatchEvent(new CustomEvent('forceDataRefresh'));
        
        // STEP 9: Force refresh stats immediately
        window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
        
        // Auto-hide after 3 seconds when restored
        setTimeout(() => {
          setIsVisible(false);
        }, 3000);
      } catch (error) {
        console.error('❌ [Recovery] Data recovery failed:', error);
        // Stay visible with error state
        setStatus('error');
      }
    };

    // Listen for browser online/offline events
    const handleOnline = () => {
      setIsOnline(true);
      // Trigger full data refresh when browser comes back online
      window.dispatchEvent(new CustomEvent('forceDataRefresh'));
    };

    const handleOffline = () => {
      setIsOnline(false);
      setStatus('error');
      setIsVisible(true);
      setDismissed(false);
    };

    window.addEventListener('connectionError', handleConnectionError);
    window.addEventListener('recoveryAttempt', handleRecoveryAttempt);
    window.addEventListener('connectionRestored', handleConnectionRestored);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Check initial online status
    if (!navigator.onLine) {
      setIsOnline(false);
      setStatus('error');
      setIsVisible(true);
    }

    return () => {
      window.removeEventListener('connectionError', handleConnectionError);
      window.removeEventListener('recoveryAttempt', handleRecoveryAttempt);
      window.removeEventListener('connectionRestored', handleConnectionRestored);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);
  
  // CRITICAL: Auto-recovery check - if we're in "recovering" state but browser is online,
  // verify connection and auto-hide if actually connected
  useEffect(() => {
    if (!isVisible || status !== 'recovering') {
      // Clear any pending timeout
      if (recoveryTimeoutRef.current) {
        clearTimeout(recoveryTimeoutRef.current);
        recoveryTimeoutRef.current = null;
      }
      return;
    }
    
    // CRITICAL: Auto-verify connection after 15 seconds in recovering state
    // If we're actually online, hide the banner
    recoveryTimeoutRef.current = setTimeout(async () => {
      if (!navigator.onLine) {
        // Still offline, keep showing banner
        return;
      }
      
      // Try a simple fetch to verify actual connectivity
      try {
        const response = await fetch('/api/health', { method: 'HEAD', cache: 'no-store' });
        // If we get here, connection is working
        console.log('✅ [ConnectionRecoveryBanner] Connection verified - auto-hiding banner');
        setStatus('restored');
        recoveringStartTime.current = null;
        window.dispatchEvent(new CustomEvent('forceDataRefresh'));
        setTimeout(() => setIsVisible(false), 2000);
      } catch (e) {
        // Still having issues, but check if smartRefreshManager thinks we're OK
        if (!smartRefreshManager._isInRecoveryMode && smartRefreshManager.consecutiveErrors === 0) {
          console.log('✅ [ConnectionRecoveryBanner] SmartRefresh reports OK - auto-hiding banner');
          setStatus('restored');
          recoveringStartTime.current = null;
          setTimeout(() => setIsVisible(false), 2000);
        } else {
          // Extend timeout and retry
          console.log('⏳ [ConnectionRecoveryBanner] Still recovering, will check again...');
        }
      }
    }, 15000);
    
    return () => {
      if (recoveryTimeoutRef.current) {
        clearTimeout(recoveryTimeoutRef.current);
        recoveryTimeoutRef.current = null;
      }
    };
  }, [isVisible, status]);
  
  // CRITICAL: If browser comes back online while in recovering state, fast-track recovery
  useEffect(() => {
    if (isOnline && isVisible && status === 'recovering') {
      // Give smartRefreshManager a moment to detect the connection
      const fastRecoveryTimeout = setTimeout(async () => {
        // Check if smartRefreshManager has successfully recovered
        if (!smartRefreshManager._isInRecoveryMode && smartRefreshManager.consecutiveErrors === 0) {
          console.log('✅ [ConnectionRecoveryBanner] Fast recovery - connection restored');
          setStatus('restored');
          recoveringStartTime.current = null;
          window.dispatchEvent(new CustomEvent('forceDataRefresh'));
          setTimeout(() => setIsVisible(false), 2000);
        }
      }, 5000);
      
      return () => clearTimeout(fastRecoveryTimeout);
    }
  }, [isOnline, isVisible, status]);

  const handleRetry = () => {
    setStatus('recovering');
    window.dispatchEvent(new CustomEvent('forceDataRefresh'));
  };

  const handleDismiss = () => {
    setDismissed(true);
    setIsVisible(false);
  };

  // Don't show if dismissed or not visible
  if (!isVisible || dismissed) return null;

  const getStatusConfig = () => {
    if (!isOnline) {
      return {
        icon: WifiOff,
        bgColor: 'bg-red-500',
        textColor: 'text-white',
        message: 'You are offline. Data will sync when connection is restored.',
        showRetry: false
      };
    }

    switch (status) {
      case 'error':
        return {
          icon: AlertTriangle,
          bgColor: 'bg-amber-500',
          textColor: 'text-white',
          message: `Connection issues detected (${errorCount} errors). Attempting to reconnect...`,
          showRetry: true
        };
      case 'recovering':
        return {
          icon: RefreshCw,
          bgColor: 'bg-blue-500',
          textColor: 'text-white',
          message: `Reconnecting... (attempt ${recoveryAttempt}/${maxAttempts})`,
          showRetry: false,
          iconSpin: true
        };
      case 'restored':
        return {
          icon: CheckCircle,
          bgColor: 'bg-green-500',
          textColor: 'text-white',
          message: 'Connection restored! Data is being refreshed.',
          showRetry: false
        };
      default:
        return {
          icon: AlertTriangle,
          bgColor: 'bg-amber-500',
          textColor: 'text-white',
          message: 'Connection issues detected.',
          showRetry: true
        };
    }
  };

  const config = getStatusConfig();
  const Icon = config.icon;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -50 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -50 }}
        transition={{ duration: 0.3 }}
        className={`fixed top-0 left-0 right-0 z-[10002] ${config.bgColor} ${config.textColor} px-4 py-2 shadow-lg`}
      >
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Icon 
              className={`w-5 h-5 flex-shrink-0 ${config.iconSpin ? 'animate-spin' : ''}`} 
            />
            <span className="text-sm font-medium">{config.message}</span>
          </div>
          
          <div className="flex items-center gap-2">
            {config.showRetry && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleRetry}
                className="h-7 px-3 bg-white/20 border-white/30 text-white hover:bg-white/30"
              >
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                Retry Now
              </Button>
            )}
            
            {status !== 'recovering' && (
              <button
                onClick={handleDismiss}
                className="p-1 hover:bg-white/20 rounded transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}