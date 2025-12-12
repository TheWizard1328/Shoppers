import React, { useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { Clock } from 'lucide-react';

/**
 * Background ETA tracking service
 * Automatically calculates and updates ETAs for active drivers
 */
export default function ETATracker({ 
  selectedDriverId, 
  selectedDate, 
  isActive = true,
  onETAUpdate 
}) {
  const intervalRef = useRef(null);

  useEffect(() => {
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
        // Get device's current local time to use as reference
        const now = new Date();
        const currentLocalTime = now.toTimeString().slice(0, 5); // HH:mm in device's local timezone

        const response = await base44.functions.invoke('calculateRealTimeETA', {
          driverId: selectedDriverId,
          deliveryDate: selectedDate,
          currentLocalTime: currentLocalTime
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
  }, [selectedDriverId, selectedDate, isActive, onETAUpdate]);

  // Render nothing - this is a background service
  return null;
}