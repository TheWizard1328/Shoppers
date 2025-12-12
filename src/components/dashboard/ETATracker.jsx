import React, { useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { isMobileDevice } from '../utils/deviceUtils';
import { userHasRole } from '../utils/userRoles';

/**
 * Background ETA tracking service
 * ONLY runs on driver's mobile device - not on dispatchers or desktop
 * Automatically calculates and updates ETAs every 2 minutes
 */
export default function ETATracker({ 
  selectedDriverId, 
  selectedDate, 
  currentUser,
  isActive = true,
  onETAUpdate 
}) {
  const intervalRef = useRef(null);

  useEffect(() => {
    // CRITICAL: Only run on driver's mobile device
    const isMobile = isMobileDevice();
    const isDriver = currentUser && userHasRole(currentUser, 'driver');
    const isCurrentDriver = currentUser && currentUser.id === selectedDriverId;

    if (!isMobile || !isDriver || !isCurrentDriver) {
      console.log('⏸️ [ETATracker] Skipping - not driver\'s mobile device');
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    // CRITICAL: Only run when driver is on duty (not off_duty or on_break)
    if (currentUser.driver_status !== 'on_duty') {
      console.log('⏸️ [ETATracker] Skipping - driver not on duty (status:', currentUser.driver_status, ')');
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

    const updateETAs = async () => {
      try {
        // Get travel durations from backend
        const response = await base44.functions.invoke('calculateRealTimeETA', {
          driverId: selectedDriverId,
          deliveryDate: selectedDate
        });

        const data = response?.data || response;

        if (data?.success && data?.durationUpdates?.length > 0) {
          // Calculate local ETAs from durations on device
          const now = new Date();
          const currentHours = now.getHours();
          const currentMinutes = now.getMinutes();
          const currentTotalMinutes = currentHours * 60 + currentMinutes;

          const etaUpdates = [];
          
          // Apply durations to current local time
          for (const update of data.durationUpdates) {
            const etaTotalMinutes = currentTotalMinutes + update.cumulativeMinutes;
            const etaHours = Math.floor(etaTotalMinutes / 60) % 24;
            const etaMinutes = etaTotalMinutes % 60;
            const etaString = `${etaHours.toString().padStart(2, '0')}:${etaMinutes.toString().padStart(2, '0')}`;

            etaUpdates.push({
              deliveryId: update.deliveryId,
              delivery_id: update.delivery_id,
              newEta: etaString,
              travelMinutes: update.travelMinutes,
              serviceMinutes: update.serviceMinutes
            });

            // Update database with calculated local ETA
            await base44.entities.Delivery.update(update.deliveryId, {
              delivery_time_eta: etaString
            });
          }

          console.log(`✅ [ETATracker] Updated ${etaUpdates.length} ETAs using device local time`);
          
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

    // Update ETAs immediately
    updateETAs();

    // Then update every 10 minutes (600 seconds) - reduced frequency to limit API usage
    intervalRef.current = setInterval(updateETAs, 600000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [selectedDriverId, selectedDate, currentUser, isActive, onETAUpdate]);

  // Render nothing - this is a background service
  return null;
}