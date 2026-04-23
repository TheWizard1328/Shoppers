import React, { useEffect, useRef, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { isMobileDevice } from '../utils/deviceUtils';
import { userHasRole } from '../utils/userRoles';
import { motion, AnimatePresence } from 'framer-motion';
import { Route, TrendingUp, CheckCircle } from 'lucide-react';
import { smartRefreshManager } from '../utils/smartRefreshManager';

const getGlobalOptimizationState = () => {
  if (typeof window === 'undefined') return null;
  if (!window.__rxdeliverRealtimeOptimizationState) {
    window.__rxdeliverRealtimeOptimizationState = { activeKey: null };
  }
  return window.__rxdeliverRealtimeOptimizationState;
};

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
      const dayDeliveries = await base44.entities.Delivery.filter({
        driver_id: selectedDriverId,
        delivery_date: selectedDate
      });
      const activeDeliveries = (dayDeliveries || []).filter((delivery) =>
        delivery && ['in_transit', 'en_route'].includes(delivery.status)
      );
      
      if (!activeDeliveries || activeDeliveries.length === 0) {
        console.log('⏸️ [RealTimeRouteOptimizer] No active deliveries (in_transit/en_route) - skipping');
        return;
      }
      console.log(`✅ [RealTimeRouteOptimizer] Found ${activeDeliveries.length} active stops - running optimization`);
    } catch (error) {
      console.error('Error checking active deliveries:', error);
      return;
    }

    const optimizationKey = `${selectedDriverId}:${selectedDate}`;
    const globalOptimizationState = getGlobalOptimizationState();
    if (activeOptimizationKeyRef.current === optimizationKey || globalOptimizationState?.activeKey === optimizationKey) {
      console.log('⏭️ [RealTimeRouteOptimizer] Skipping duplicate optimization request');
      return;
    }
    activeOptimizationKeyRef.current = optimizationKey;
    if (globalOptimizationState) globalOptimizationState.activeKey = optimizationKey;

    console.log('🔄 [RealTimeRouteOptimizer] Triggering route optimization for driver:', selectedDriverId);
    smartRefreshManager.pause();
    if (showUIRef.current) {
      window.dispatchEvent(new CustomEvent('routeOptimizationStarted', {
        detail: { driverId: selectedDriverId, deliveryDate: selectedDate, source: 'realTimeRouteOptimizer', showUI: true }
      }));
    }

    try {
      const response = await base44.functions.invoke('optimizeRouteRealTime', {
        driverId: selectedDriverId,
        deliveryDate: selectedDate,
      });

      const data = response?.data || response;

      if (data?.success) {
        base44.analytics.track({
          eventName: "route_optimization_run",
          properties: {
            source: "realtime_optimizer",
            success: true,
            route_changed: Boolean(data.routeChanged),
            optimized_stop_count: Number(data.optimizedCount || data.totalStops || data.optimizedRoute?.length || 0)
          }
        });
        console.log(`✅ [RealTimeRouteOptimizer] Route ${data.routeChanged ? 'OPTIMIZED' : 'unchanged'}`);
        
        if (data.routeChanged) {
          if (Array.isArray(data.optimizedRoute) && data.optimizedRoute.length > 0) {
            window.dispatchEvent(new CustomEvent('etaUpdated', {
              detail: {
                driverId: selectedDriverId,
                updates: data.optimizedRoute.map((stop) => ({
                  deliveryId: stop.deliveryId || stop.delivery_id,
                  newEta: stop.newETA || stop.eta
                })).filter((stop) => stop.deliveryId && stop.newEta)
              }
            }));
          }

          // CRITICAL: Backend has already updated stop_order and ETAs
          // Just show notification and force UI refresh
          if (showUIRef.current) {
            setNotification({
              id: Date.now(),
              updates: data.optimizedRoute || [],
              totalStops: data.totalStops || 0
            });
            setTimeout(() => setNotification(null), 6000);
          }

          if (onRouteOptimized) {
            onRouteOptimized(data.optimizedRoute);
          }

          // CRITICAL: Force UI refresh to show new stop orders and ETAs
          window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
            detail: {
              driverId: selectedDriverId,
              deliveryDate: selectedDate,
              triggeredBy: 'realTimeRouteOptimizer',
              alreadyOptimized: true
            }
          }));
          // Also signal downstream layers to invalidate polylines for this driver/date
          window.dispatchEvent(new CustomEvent('routeReordered', {
            detail: { driverId: selectedDriverId, deliveryDate: selectedDate, source: 'realTimeRouteOptimizer' }
          }));
          window.dispatchEvent(new CustomEvent('routeOptimizationComplete', {
            detail: { driverId: selectedDriverId, deliveryDate: selectedDate, source: 'realTimeRouteOptimizer', showUI: showUIRef.current }
          }));
        }
      }
    } catch (error) {
      base44.analytics.track({
        eventName: "route_optimization_run",
        properties: {
          source: "realtime_optimizer",
          success: false
        }
      });
      console.error('❌ [RealTimeRouteOptimizer] Error:', error);
    } finally {
      showUIRef.current = false;
      const globalOptimizationState = getGlobalOptimizationState();
      if (globalOptimizationState?.activeKey === optimizationKey) globalOptimizationState.activeKey = null;
      activeOptimizationKeyRef.current = null;
      smartRefreshManager.resume();
    }
  };

  // Track when optimization is in progress to prevent duplicate runs
  const isOptimizingRef = useRef(false);
  const lastOptimizationTimeRef = useRef(0);
  const OPTIMIZATION_COOLDOWN = 15000; // 15 seconds (balanced smoothing)
  const showUIRef = useRef(false);
  const activeOptimizationKeyRef = useRef(null);

  useEffect(() => {
    // Listen for manual optimization triggers
    const handleTriggerOptimization = () => {
      console.log('🎯 [RealTimeRouteOptimizer] Manual trigger received');
      showUIRef.current = true;
      optimizeRoute();
    };

    // CRITICAL: Listen for deliveriesUpdated events and check if already optimized
    const handleDeliveriesUpdated = (event) => {
      const { alreadyOptimized, triggeredBy, driverId, deliveryDate } = event.detail || {};
      
      // Only run for explicit triggers (assign/accept all, start, or explicit FAB/manual)
      const normalizedTrigger = String(triggeredBy || '').trim();
      const allowedTriggers = new Set([
        'assignAll',
        'acceptAll',
        'assign_all',
        'accept_all',
        'assign all',
        'accept all',
        'reoptimizeRoute',
        'manualOptimize'
      ]);
      if (!allowedTriggers.has(normalizedTrigger)) {
        return;
      }
      const uiTriggers = new Set([
        'assignAll',
        'acceptAll',
        'assign_all',
        'accept_all',
        'assign all',
        'accept all',
        'reoptimizeRoute',
        'manualOptimize'
      ]);
      showUIRef.current = uiTriggers.has(normalizedTrigger);
      
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

    const handleSignificantDelayDetected = (event) => {
      const { driverId, deliveryDate } = event.detail || {};
      if (driverId !== selectedDriverId || deliveryDate !== selectedDate) return;
      if (isOptimizingRef.current) return;
      const timeSinceLastOptimization = Date.now() - lastOptimizationTimeRef.current;
      if (timeSinceLastOptimization < OPTIMIZATION_COOLDOWN) return;
      showUIRef.current = false;
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
    window.addEventListener('significantDelayDetected', handleSignificantDelayDetected);
    window.addEventListener('routeOptimizationComplete', handleOptimizationComplete);

    return () => {
      window.removeEventListener('triggerRouteOptimization', handleTriggerOptimization);
      window.removeEventListener('deliveriesUpdated', handleDeliveriesUpdated);
      window.removeEventListener('significantDelayDetected', handleSignificantDelayDetected);
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