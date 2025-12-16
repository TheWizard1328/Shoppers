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
      console.log('⏸️ [ETATracker] Skipping - not driver\'s mobile device');
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
        const now = Date.now();
        const currentLocation = currentUser?.current_latitude && currentUser?.current_longitude
          ? { lat: currentUser.current_latitude, lon: currentUser.current_longitude }
          : null;

        if (!currentLocation) {
          console.log('⏸️ [ETATracker] No driver location available');
          return;
        }

        // Check if location changed by more than 500m
        let shouldUpdate = false;
        
        if (!lastLocationRef.current) {
          // First run - update
          shouldUpdate = true;
          console.log('🚀 [ETATracker] Initial ETA update');
        } else {
          const distance = calculateDistance(
            lastLocationRef.current.lat,
            lastLocationRef.current.lon,
            currentLocation.lat,
            currentLocation.lon
          );

          // Update if driver moved >500m (0.5km)
          if (distance >= 0.5) {
            shouldUpdate = true;
            console.log(`🚗 [ETATracker] Driver in motion - moved ${(distance * 1000).toFixed(0)}m`);
          }
        }

        if (!shouldUpdate) {
          console.log('⏸️ [ETATracker] Driver stationary (<500m) - skipping update');
          return;
        }

        // Store current location for next comparison
        lastLocationRef.current = currentLocation;
        lastUpdateTimeRef.current = now;

        console.log('🔄 [ETATracker] Updating ETAs...');

        // Get travel durations from backend
        const response = await base44.functions.invoke('calculateRealTimeETA', {
          driverId: selectedDriverId,
          deliveryDate: selectedDate
        });

        const data = response?.data || response;

        if (data?.success && data?.durationUpdates?.length > 0) {
          // CRITICAL: Backend now returns actual clock time ETAs - use them directly
          const etaUpdates = [];
          
          for (const update of data.durationUpdates) {
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

          console.log(`✅ [ETATracker] Updated ${etaUpdates.length} ETAs based on driver motion`);
          
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

    // Check for updates every 30 seconds (scan for location changes)
    intervalRef.current = setInterval(updateETAs, 30000);

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