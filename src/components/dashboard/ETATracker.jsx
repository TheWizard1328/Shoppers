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
        const response = await base44.functions.invoke('calculateRealTimeETA', {
          driverId: selectedDriverId,
          deliveryDate: selectedDate
        });

        const data = response?.data || response;

        if (data?.success && data?.etaUpdates?.length > 0) {
          console.log(`✅ [ETATracker] Updated ${data.etaUpdates.length} ETAs`);
          
          if (onETAUpdate) {
            onETAUpdate(data.etaUpdates);
          }

          // Dispatch custom event for other components to listen
          window.dispatchEvent(new CustomEvent('etaUpdated', {
            detail: {
              driverId: selectedDriverId,
              updates: data.etaUpdates
            }
          }));
        }
      } catch (error) {
        console.error('❌ [ETATracker] Error updating ETAs:', error);
      }
    };

    // Update ETAs immediately
    updateETAs();

    // Then update every 2 minutes (120 seconds)
    intervalRef.current = setInterval(updateETAs, 120000);

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