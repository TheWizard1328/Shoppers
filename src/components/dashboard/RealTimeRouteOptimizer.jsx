import React, { useEffect, useRef, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { isMobileDevice } from '../utils/deviceUtils';
import { userHasRole } from '../utils/userRoles';
import { motion, AnimatePresence } from 'framer-motion';
import { Route, TrendingUp, CheckCircle } from 'lucide-react';

/**
 * Real-time route optimization service
 * ONLY runs on driver's mobile device
 * Triggers only on specific events (not automatic interval)
 */
export default function RealTimeRouteOptimizer({ 
  selectedDriverId, 
  selectedDate, 
  currentUser,
  isActive = true,
  onRouteOptimized 
}) {
  const [notification, setNotification] = useState(null);

  const optimizeRoute = async () => {
    // CRITICAL: Only run on driver's mobile device
    const isMobile = isMobileDevice();
    const isDriver = currentUser && userHasRole(currentUser, 'driver');
    const isCurrentDriver = currentUser && currentUser.id === selectedDriverId;

    if (!isMobile || !isDriver || !isCurrentDriver) {
      console.log('⏸️ [RealTimeRouteOptimizer] Skipping - not driver\'s mobile device');
      return;
    }

    // CRITICAL: Only run when driver is on duty (not off_duty or on_break)
    if (currentUser.driver_status !== 'on_duty') {
      console.log('⏸️ [RealTimeRouteOptimizer] Skipping - driver not on duty (status:', currentUser.driver_status, ')');
      return;
    }

    if (!isActive || !selectedDriverId || selectedDriverId === 'all' || !selectedDate) {
      return;
    }

    // CRITICAL: Only optimize TODAY's date - skip past and future dates
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    if (selectedDate !== todayStr) {
      console.log('⏸️ [RealTimeRouteOptimizer] Skipping - not today\'s date (selected:', selectedDate, ', today:', todayStr, ')');
      return;
    }

    // CRITICAL: Only optimize when route has active stops (in_transit or en_route)
    // Skip if all stops are pending, staged, completed, failed, etc.
    try {
      const activeDeliveries = await base44.entities.Delivery.filter({
        driver_id: selectedDriverId,
        delivery_date: selectedDate,
        status: { $in: ['in_transit', 'en_route'] }
      });
      
      if (!activeDeliveries || activeDeliveries.length === 0) {
        console.log('⏸️ [RealTimeRouteOptimizer] No active deliveries (in_transit/en_route) - skipping');
        return;
      }
      console.log(`✅ [RealTimeRouteOptimizer] Found ${activeDeliveries.length} active stops - running optimization`);
    } catch (error) {
      console.error('Error checking active deliveries:', error);
      return;
    }

    console.log('🔄 [RealTimeRouteOptimizer] Triggering route optimization for driver:', selectedDriverId);

    try {
      const response = await base44.functions.invoke('optimizeRouteRealTime', {
        driverId: selectedDriverId,
        deliveryDate: selectedDate,
      });

      const data = response?.data || response;

      if (data?.success) {
        console.log(`✅ [RealTimeRouteOptimizer] Route ${data.routeChanged ? 'OPTIMIZED' : 'unchanged'}`);
        
        if (data.routeChanged) {
          // CRITICAL: Backend has already updated stop_order and ETAs
          // Just show notification and force UI refresh
          setNotification({
            id: Date.now(),
            updates: data.optimizedRoute || [],
            totalStops: data.totalStops || 0
          });

          setTimeout(() => setNotification(null), 6000);

          if (onRouteOptimized) {
            onRouteOptimized(data.optimizedRoute);
          }

          // CRITICAL: Force UI refresh to show new stop orders and ETAs
          window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
            detail: {
              driverId: selectedDriverId,
              deliveryDate: selectedDate,
              triggeredBy: 'realTimeRouteOptimizer'
            }
          }));
        }
      }
    } catch (error) {
      console.error('❌ [RealTimeRouteOptimizer] Error:', error);
    }
  };

  // Track when optimization is in progress to prevent duplicate runs
  const isOptimizingRef = useRef(false);
  const lastOptimizationTimeRef = useRef(0);
  const OPTIMIZATION_COOLDOWN = 10000; // 10 seconds

  useEffect(() => {
    // Listen for manual optimization triggers
    const handleTriggerOptimization = () => {
      console.log('🎯 [RealTimeRouteOptimizer] Manual trigger received');
      optimizeRoute();
    };

    // CRITICAL: Listen for deliveriesUpdated events and check if already optimized
    const handleDeliveriesUpdated = (event) => {
      const { alreadyOptimized, triggeredBy, driverId, deliveryDate } = event.detail || {};
      
      // Skip if data is already optimized (came from backend optimization)
      if (alreadyOptimized) {
        console.log(`⏭️ [RealTimeRouteOptimizer] Skipping - data already optimized by ${triggeredBy}`);
        return;
      }

      // Skip if optimization is already in progress
      if (isOptimizingRef.current) {
        console.log('⏭️ [RealTimeRouteOptimizer] Skipping - optimization already in progress');
        return;
      }

      // Skip if optimized recently (within cooldown period)
      const timeSinceLastOptimization = Date.now() - lastOptimizationTimeRef.current;
      if (timeSinceLastOptimization < OPTIMIZATION_COOLDOWN) {
        const remainingSeconds = Math.ceil((OPTIMIZATION_COOLDOWN - timeSinceLastOptimization) / 1000);
        console.log(`⏭️ [RealTimeRouteOptimizer] Skipping - cooldown (${remainingSeconds}s remaining)`);
        return;
      }

      // Skip if not for current driver/date
      if (driverId !== selectedDriverId || deliveryDate !== selectedDate) {
        return;
      }

      console.log(`🔄 [RealTimeRouteOptimizer] Event-triggered optimization for ${triggeredBy}`);
      isOptimizingRef.current = true;
      lastOptimizationTimeRef.current = Date.now();
      
      optimizeRoute().finally(() => {
        isOptimizingRef.current = false;
      });
    };

    // Listen for route optimization completion to prevent duplicate runs
    const handleOptimizationComplete = (event) => {
      const { source } = event.detail || {};
      console.log(`✅ [RealTimeRouteOptimizer] Optimization complete from ${source} - resetting state`);
      isOptimizingRef.current = false;
      lastOptimizationTimeRef.current = Date.now();
    };

    window.addEventListener('triggerRouteOptimization', handleTriggerOptimization);
    window.addEventListener('deliveriesUpdated', handleDeliveriesUpdated);
    window.addEventListener('routeOptimizationComplete', handleOptimizationComplete);

    return () => {
      window.removeEventListener('triggerRouteOptimization', handleTriggerOptimization);
      window.removeEventListener('deliveriesUpdated', handleDeliveriesUpdated);
      window.removeEventListener('routeOptimizationComplete', handleOptimizationComplete);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDriverId, selectedDate, currentUser, isActive, onRouteOptimized]);

  // REMOVED: Automatic optimization on page load
  // This was causing excessive Google Maps API hits on app refresh
  // Optimization now only runs on manual trigger events

  return (
    <AnimatePresence>
      {notification && (
        <motion.div
          initial={{ opacity: 0, y: -50, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -50, scale: 0.95 }}
          className="fixed top-20 left-4 right-4 z-[10000] mx-auto max-w-md"
          style={{ transform: 'none' }}
        >
          <div 
            className="rounded-xl shadow-2xl p-4 border-2"
            style={{ 
              background: 'var(--bg-white)', 
              borderColor: 'var(--border-slate-300)',
              boxShadow: '0 25px 50px -12px var(--shadow-color)'
            }}
          >
            <div className="flex items-start gap-3">
              <div 
                className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
                style={{ background: 'var(--bg-slate-100)' }}
              >
                <Route className="w-5 h-5 text-blue-600" />
              </div>

              <div className="flex-1 min-w-0">
                <h4 className="font-bold text-sm mb-1" style={{ color: 'var(--text-slate-900)' }}>
                  Route Optimized
                </h4>
                
                <p className="text-sm mb-2" style={{ color: 'var(--text-slate-600)' }}>
                  {notification.updates.length} stop{notification.updates.length !== 1 ? 's' : ''} resequenced based on current traffic
                </p>

                <div className="flex items-center gap-2 text-xs text-blue-600">
                  <CheckCircle className="w-4 h-4" />
                  <span className="font-semibold">Estimated time saved</span>
                </div>
              </div>

              <button
                onClick={() => setNotification(null)}
                className="transition-colors flex-shrink-0"
                style={{ color: 'var(--text-slate-400)' }}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}