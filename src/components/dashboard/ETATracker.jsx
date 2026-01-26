import React, { useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { isMobileDevice } from '../utils/deviceUtils';
import { userHasRole } from '../utils/userRoles';

/**
 * Background ETA tracking service
 * ONLY runs on driver's mobile device - not on dispatchers or desktop
 * Updates ETAs when:
 * 1. Driver is in motion (location changed by >500m)
 * 2. Driver is On Duty (paused when Off Duty or On Break)
 */
export default function ETATracker({ 
  selectedDriverId, 
  selectedDate, 
  currentUser,
  isActive = true,
  onETAUpdate 
}) {
  const intervalRef = useRef(null);
  const lastLocationRef = useRef(null);
  const lastUpdateTimeRef = useRef(0);

  useEffect(() => {
    // CRITICAL: Only run on driver's mobile device
    const isMobile = isMobileDevice();
    const isDriver = currentUser && userHasRole(currentUser, 'driver');
    const isCurrentDriver = currentUser && currentUser.id === selectedDriverId;

    if (!isMobile || !isDriver || !isCurrentDriver) {
      // Only log once when first skipping, not on every render
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    // CRITICAL: Only run when driver is On Duty (pause when Off Duty or On Break)
    if (currentUser.driver_status !== 'on_duty') {
      console.log('⏸️ [ETATracker] Paused - driver not on duty (status:', currentUser.driver_status, ')');
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    if (!isActive || !selectedDriverId || selectedDriverId === 'all' || !selectedDate) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    console.log('🕐 [ETATracker] Starting ETA tracking for driver:', selectedDriverId);

    // Helper: Check if there are any in-transit deliveries
    const hasInTransitDeliveries = async () => {
      try {
        const deliveries = await base44.entities.Delivery.filter({
          driver_id: selectedDriverId,
          delivery_date: selectedDate,
          status: 'in_transit'
        });
        return deliveries && deliveries.length > 0;
      } catch (error) {
        console.error('Error checking in-transit deliveries:', error);
        return false;
      }
    };

    // Helper: Calculate distance between two coordinates (Haversine formula)
    const calculateDistance = (lat1, lon1, lat2, lon2) => {
      const R = 6371; // Earth's radius in km
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return R * c; // Distance in km
    };

    const updateETAs = async () => {
      try {
        // CRITICAL: Skip ETA updates if no in-transit deliveries
        // This preserves pickup order based on delivery_time_start until route actually starts
        const hasActiveDeliveries = await hasInTransitDeliveries();
        if (!hasActiveDeliveries) {
          console.log('⏸️ [ETATracker] No in-transit deliveries - skipping ETA update to preserve pickup order');
          return;
        }

        console.log('🔄 [ETATracker] Updating ETAs...');

        // Get travel durations from backend - CRITICAL: Pass local time as HH:mm string
        const currentTime = new Date();
        const localTimeString = `${String(currentTime.getHours()).padStart(2, '0')}:${String(currentTime.getMinutes()).padStart(2, '0')}`;

        const response = await base44.functions.invoke('calculateRealTimeETA', {
          driverId: selectedDriverId,
          deliveryDate: selectedDate,
          currentLocalTime: localTimeString // Send as HH:mm to avoid UTC conversion
        });

        const data = response?.data || response;

        if (data?.success && data?.durationUpdates?.length > 0) {
          // CRITICAL: Backend now returns actual clock time ETAs - use them directly
          // Filter out completed/failed/cancelled deliveries from updates
          const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];
          const activeUpdates = data.durationUpdates.filter(update => 
            !FINISHED_STATUSES.includes(update.status)
          );
          
          const etaUpdates = [];
          
          for (const update of activeUpdates) {
            // Backend returns eta as HH:mm clock time, not cumulative minutes
            const etaString = update.eta;

            etaUpdates.push({
              deliveryId: update.deliveryId,
              delivery_id: update.delivery_id,
              newEta: etaString,
              travelMinutes: update.travelMinutes,
              serviceMinutes: update.serviceMinutes
            });

            // Update database with backend-calculated ETA
            await base44.entities.Delivery.update(update.deliveryId, {
              delivery_time_eta: etaString
            });
          }

          console.log(`✅ [ETATracker] Updated ${etaUpdates.length} active ETAs (filtered ${data.durationUpdates.length - activeUpdates.length} finished)`);
          
          if (onETAUpdate) {
            onETAUpdate(etaUpdates);
          }

          // Dispatch custom event for other components to listen
          window.dispatchEvent(new CustomEvent('etaUpdated', {
            detail: {
              driverId: selectedDriverId,
              updates: etaUpdates
            }
          }));
        }
      } catch (error) {
        console.error('❌ [ETATracker] Error updating ETAs:', error);
      }
    };

    // Listen for events that should trigger ETA updates
    const handleETAUpdateEvent = () => {
      console.log('🔔 [ETATracker] Event received - updating ETAs');
      updateETAs();
    };

    // CRITICAL: Listen for status changes, route optimization, and pending->in_transit transitions
    window.addEventListener('deliveryStatusChanged', handleETAUpdateEvent);
    window.addEventListener('routeOptimizationComplete', handleETAUpdateEvent);
    window.addEventListener('pendingToInTransit', handleETAUpdateEvent);

    // REMOVED: Automatic ETA update on mount/refresh - causing excessive Google Maps API hits
    // ETAs now only update on specific events (status changes, route optimization)

    return () => {
      window.removeEventListener('deliveryStatusChanged', handleETAUpdateEvent);
      window.removeEventListener('routeOptimizationComplete', handleETAUpdateEvent);
      window.removeEventListener('pendingToInTransit', handleETAUpdateEvent);
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  // CRITICAL: Only depend on stable values to prevent re-running on every render
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDriverId, selectedDate, currentUser?.id, currentUser?.driver_status, isActive]);

  // Render nothing - this is a background service
  return null;
}