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

    // CRITICAL: Skip optimization if no in-transit deliveries
    // This preserves pickup order based on delivery_time_start until route actually starts
    try {
      const inTransitDeliveries = await base44.entities.Delivery.filter({
        driver_id: selectedDriverId,
        delivery_date: selectedDate,
        status: 'in_transit'
      });
      
      if (!inTransitDeliveries || inTransitDeliveries.length === 0) {
        console.log('⏸️ [RealTimeRouteOptimizer] No in-transit deliveries - skipping to preserve pickup order');
        return;
      }
    } catch (error) {
      console.error('Error checking in-transit deliveries:', error);
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
        
        if (data.routeChanged && data.optimizedRoute?.length > 0) {
          const now = new Date();
          let cumulativeMinutes = now.getHours() * 60 + now.getMinutes();

          for (const stop of data.optimizedRoute) {
            cumulativeMinutes += stop.travelMinutes;
            const etaHours = Math.floor(cumulativeMinutes / 60) % 24;
            const etaMinutes = cumulativeMinutes % 60;
            const etaString = `${etaHours.toString().padStart(2, '0')}:${etaMinutes.toString().padStart(2, '0')}`;

            await base44.entities.Delivery.update(stop.deliveryId, {
              delivery_time_eta: etaString
            });
            
            cumulativeMinutes += stop.serviceMinutes;
          }

          setNotification({
            id: Date.now(),
            updates: data.optimizedRoute,
            totalStops: data.optimizedRoute.length
          });

          setTimeout(() => setNotification(null), 6000);

          if (onRouteOptimized) {
            onRouteOptimized(data.optimizedRoute);
          }

          window.dispatchEvent(new CustomEvent('routeOptimized', {
            detail: {
              driverId: selectedDriverId,
              updates: data.optimizedRoute
            }
          }));
        }
      }
    } catch (error) {
      console.error('❌ [RealTimeRouteOptimizer] Error:', error);
    }
  };

  useEffect(() => {
    // Listen for manual optimization triggers
    const handleTriggerOptimization = () => {
      console.log('🎯 [RealTimeRouteOptimizer] Manual trigger received');
      optimizeRoute();
    };

    window.addEventListener('triggerRouteOptimization', handleTriggerOptimization);

    return () => {
      window.removeEventListener('triggerRouteOptimization', handleTriggerOptimization);
    };
  }, [selectedDriverId, selectedDate, currentUser, isActive, onRouteOptimized]);

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
          <div className="rounded-xl shadow-2xl p-4 border-2 bg-blue-50 border-blue-500">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 bg-blue-100">
                <Route className="w-5 h-5 text-blue-600" />
              </div>

              <div className="flex-1 min-w-0">
                <h4 className="font-bold text-sm mb-1 text-blue-900">
                  Route Optimized
                </h4>
                
                <p className="text-sm text-slate-700 mb-2">
                  {notification.updates.length} stop{notification.updates.length !== 1 ? 's' : ''} resequenced based on current traffic
                </p>

                <div className="flex items-center gap-2 text-xs text-blue-700">
                  <CheckCircle className="w-4 h-4" />
                  <span className="font-semibold">Estimated time saved</span>
                </div>
              </div>

              <button
                onClick={() => setNotification(null)}
                className="text-slate-400 hover:text-slate-600 transition-colors flex-shrink-0"
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