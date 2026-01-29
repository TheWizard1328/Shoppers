import React, { useState, useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Navigation, Zap, CheckCircle, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { format } from 'date-fns';
import { toast } from 'sonner';

/**
 * Auto Route Optimizer - Automatic AI-powered route optimization for drivers
 * 
 * Features:
 * - Automatically optimizes route when driver moves 100m+ (every 2 minutes)
 * - Visual indicator showing when optimization is active
 * - Real-time ETA updates
 * - Toggle to enable/disable auto-optimization
 */
export default function AutoRouteOptimizer({ 
  currentUser, 
  selectedDriverId,
  selectedDate,
  deliveries,
  driverLocation,
  onRouteOptimized,
  isActive = true
}) {
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [autoOptimizeEnabled, setAutoOptimizeEnabled] = useState(() => {
    const saved = localStorage.getItem('rxdeliver_auto_optimize');
    return saved !== null ? saved === 'true' : true;
  });
  const [lastOptimized, setLastOptimized] = useState(null);
  const [optimizationCount, setOptimizationCount] = useState(0);
  const lastLocationRef = useRef(null);
  const optimizationIntervalRef = useRef(null);

  // Calculate distance between two coordinates (Haversine formula)
  const calculateDistance = (lat1, lon1, lat2, lon2) => {
    const R = 6371; // Earth radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in km
  };

  // Run route optimization
  const optimizeRoute = async () => {
    if (!currentUser || !deliveries || deliveries.length === 0) return;
    
    try {
      setIsOptimizing(true);
      
      // CRITICAL: Pause all sync managers before optimization
      console.log('🔒 [Auto-Optimize] Pausing smart refresh and sync managers...');
      const { smartRefreshManager } = await import('@/components/utils/smartRefreshManager');
      const wasSmartRefreshEnabled = smartRefreshManager._enabled;
      smartRefreshManager._enabled = false;
      
      const dateStr = format(selectedDate, 'yyyy-MM-dd');
      const todayStr = format(new Date(), 'yyyy-MM-dd');
      
      // Only optimize today's routes
      if (dateStr !== todayStr) {
        return;
      }

      // Check if there are incomplete deliveries
      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
      const hasIncompleteStops = deliveries.some(d => 
        d && !finishedStatuses.includes(d.status) && d.status !== 'pending'
      );

      if (!hasIncompleteStops) {
        smartRefreshManager._enabled = wasSmartRefreshEnabled;
        return;
      }

      const now = new Date();
      const localTimeString = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

      console.log('🤖 [Auto-Optimize] Running AI route optimization...');
      
      const response = await base44.functions.invoke('optimizeRouteRealTime', {
        driverId: currentUser.id,
        deliveryDate: dateStr,
        currentLocalTime: localTimeString,
        deviceTime: now.toISOString(),
        generatePolyline: true
      });

      const data = response?.data || response;

      if (data?.success) {
        setLastOptimized(new Date());
        setOptimizationCount(prev => prev + 1);
        
        if (onRouteOptimized) {
          onRouteOptimized(data);
        }

        console.log('✅ [Auto-Optimize] Route optimized successfully');
        
        // CRITICAL: Wait for UI to update, then resume smart refresh and force immediate sync
        console.log('🔓 [Auto-Optimize] Resuming smart refresh and forcing immediate sync...');
        await new Promise(resolve => setTimeout(resolve, 500));
        smartRefreshManager._enabled = wasSmartRefreshEnabled;
        smartRefreshManager.lastRefreshTimes = {
          driverLocation: 0,
          activeDeliveries: 0,
          todayDeliveries: 0,
          appUsers: 0,
          patients: 0,
          stores: 0
        };
      }
    } catch (error) {
      console.warn('⚠️ [Auto-Optimize] Failed:', error.message);
      // Resume smart refresh on error
      const { smartRefreshManager } = await import('@/components/utils/smartRefreshManager');
      smartRefreshManager._enabled = true;
    } finally {
      setIsOptimizing(false);
    }
  };

  // Auto-optimize when driver moves 100m+ (check every 2 minutes)
  useEffect(() => {
    if (!autoOptimizeEnabled || !isActive || !currentUser || !driverLocation?.latitude) {
      return;
    }

    const checkAndOptimize = async () => {
      if (!driverLocation?.latitude || !driverLocation?.longitude) return;

      // Check if driver has moved 100m+ since last optimization
      if (lastLocationRef.current) {
        const distanceMoved = calculateDistance(
          lastLocationRef.current.lat,
          lastLocationRef.current.lon,
          driverLocation.latitude,
          driverLocation.longitude
        ) * 1000; // Convert km to meters

        if (distanceMoved >= 100) {
          console.log(`🚗 [Auto-Optimize] Driver moved ${Math.round(distanceMoved)}m - optimizing route`);
          await optimizeRoute();
          lastLocationRef.current = {
            lat: driverLocation.latitude,
            lon: driverLocation.longitude
          };
        }
      } else {
        // First run - just store location
        lastLocationRef.current = {
          lat: driverLocation.latitude,
          lon: driverLocation.longitude
        };
      }
    };

    // Check immediately
    checkAndOptimize();

    // Then check every 2 minutes
    optimizationIntervalRef.current = setInterval(checkAndOptimize, 120000);

    return () => {
      if (optimizationIntervalRef.current) {
        clearInterval(optimizationIntervalRef.current);
      }
    };
  }, [autoOptimizeEnabled, isActive, currentUser, driverLocation, deliveries]);

  // Save toggle state
  useEffect(() => {
    localStorage.setItem('rxdeliver_auto_optimize', String(autoOptimizeEnabled));
  }, [autoOptimizeEnabled]);

  // Format time since last optimization
  const getTimeSinceOptimization = () => {
    if (!lastOptimized) return null;
    const seconds = Math.floor((new Date() - lastOptimized) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ago`;
  };

  return (
    <div className="fixed top-20 right-4 z-[140] flex flex-col items-end gap-2">
      {/* Auto-Optimize Toggle */}
      <motion.div
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        className="flex items-center gap-2 px-3 py-2 rounded-lg shadow-lg border"
        style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}
      >
        <Zap className={`w-4 h-4 ${autoOptimizeEnabled ? 'text-emerald-600' : 'text-slate-400'}`} />
        <span className="text-xs font-medium" style={{ color: 'var(--text-slate-700)' }}>
          Auto-Optimize
        </span>
        <button
          onClick={() => setAutoOptimizeEnabled(!autoOptimizeEnabled)}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            autoOptimizeEnabled ? 'bg-emerald-600' : 'bg-slate-300'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              autoOptimizeEnabled ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </motion.div>

      {/* Status Indicator */}
      <AnimatePresence>
        {autoOptimizeEnabled && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="px-3 py-2 rounded-lg shadow-lg border"
            style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}
          >
            <div className="flex items-center gap-2">
              {isOptimizing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-emerald-600" />
                  <span className="text-xs font-medium text-slate-700">Optimizing...</span>
                </>
              ) : (
                <>
                  <CheckCircle className="w-4 h-4 text-emerald-600" />
                  <div className="flex flex-col">
                    <span className="text-xs font-medium text-slate-700">Route Optimized</span>
                    {lastOptimized && (
                      <span className="text-[10px] text-slate-500">{getTimeSinceOptimization()}</span>
                    )}
                  </div>
                </>
              )}
            </div>

            {optimizationCount > 0 && (
              <div className="mt-1 text-[10px] text-slate-500 text-center">
                {optimizationCount} optimization{optimizationCount !== 1 ? 's' : ''} today
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Manual Optimize Button */}
      <motion.button
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        onClick={async () => {
          if (isOptimizing) return;
          await optimizeRoute();
          toast.success('Route optimized!');
        }}
        disabled={isOptimizing}
        className={`p-3 rounded-full shadow-2xl transition-all ${
          isOptimizing 
            ? 'bg-amber-500 hover:bg-amber-600' 
            : 'bg-emerald-600 hover:bg-emerald-700'
        }`}
        title="Manually optimize route now"
      >
        {isOptimizing ? (
          <Loader2 className="w-5 h-5 text-white animate-spin" />
        ) : (
          <Navigation className="w-5 h-5 text-white" />
        )}
      </motion.button>
    </div>
  );
}