import { base44 } from '@/api/base44Client';

/**
 * Live Distance Tracker
 * 
 * Tracks driver movement in real-time and updates travel_dist on the next delivery.
 * Also tracks time on duty continuously.
 * 
 * Logic:
 * - Every 15-30 seconds, calculate distance moved since last position
 * - Add that distance to the current next delivery's travel_dist
 * - When driver changes next stop (Start button), transfer accumulated distance to new stop
 * - Track time on duty as long as driver is on_duty (not off_duty or on_break)
 */

class LiveDistanceTracker {
  constructor() {
    this.isTracking = false;
    this.currentUser = null;
    this.lastPosition = null;
    this.updateInterval = 20000; // 20 seconds (middle of 15-30 range)
    this.intervalId = null;
    this.accumulatedDistance = 0; // Distance accumulated for current next delivery
    this.dutyStartTime = null; // When driver went on_duty
    this.totalTimeOnDuty = 0; // Total minutes on duty
  }

  /**
   * Calculate distance between two GPS coordinates (Haversine formula)
   * Returns distance in kilometers
   */
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth's radius in kilometers
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // Distance in kilometers
  }

  /**
   * Start tracking for a given user
   */
  async start(user) {
    if (!user) {
      console.error('❌ [LiveDistanceTracker] Cannot start - no user provided');
      return;
    }

    if (this.isTracking) {
      console.log('⏭️ [LiveDistanceTracker] Already tracking');
      return;
    }

    this.currentUser = user;
    this.isTracking = true;
    this.lastPosition = null;
    this.accumulatedDistance = 0;
    
    // Initialize duty time tracking
    if (user.driver_status === 'on_duty') {
      this.dutyStartTime = Date.now();
      this.totalTimeOnDuty = 0;
    } else {
      this.dutyStartTime = null;
      this.totalTimeOnDuty = 0;
    }

    console.log('🚀 [LiveDistanceTracker] Started tracking for', user.user_name);

    // Start periodic updates
    this.intervalId = setInterval(() => {
      this.updateDistanceAndTime();
    }, this.updateInterval);

    // Run first update immediately
    this.updateDistanceAndTime();
  }

  /**
   * Stop tracking
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.isTracking = false;
    this.currentUser = null;
    this.lastPosition = null;
    this.accumulatedDistance = 0;
    this.dutyStartTime = null;
    this.totalTimeOnDuty = 0;

    console.log('🛑 [LiveDistanceTracker] Stopped tracking');
  }

  /**
   * Update driver status (for duty time tracking)
   */
  updateDriverStatus(newStatus) {
    const previousStatus = this.currentUser?.driver_status;
    
    if (!this.currentUser) return;
    
    this.currentUser.driver_status = newStatus;

    // Handle duty time tracking state changes
    if (newStatus === 'on_duty' && previousStatus !== 'on_duty') {
      // Started duty - start timer
      this.dutyStartTime = Date.now();
      console.log('⏱️ [LiveDistanceTracker] Duty timer started');
    } else if (newStatus !== 'on_duty' && previousStatus === 'on_duty') {
      // Stopped duty - calculate and store total time
      if (this.dutyStartTime) {
        const elapsedMs = Date.now() - this.dutyStartTime;
        this.totalTimeOnDuty += Math.floor(elapsedMs / 60000); // Convert to minutes
        this.dutyStartTime = null;
        console.log(`⏱️ [LiveDistanceTracker] Duty timer stopped - Total: ${this.totalTimeOnDuty} minutes`);
      }
    }
  }

  /**
   * Main update loop - called every 15-30 seconds
   */
  async updateDistanceAndTime() {
    if (!this.isTracking || !this.currentUser) {
      return;
    }

    try {
      // STEP 1: Get current GPS position from currentUser (updated by locationTracker)
      const currentLat = this.currentUser.current_latitude;
      const currentLon = this.currentUser.current_longitude;

      if (!currentLat || !currentLon) {
        console.log('⏭️ [LiveDistanceTracker] No GPS coordinates available');
        return;
      }

      // STEP 2: Calculate distance moved since last position (if we have one)
      let distanceMoved = 0;
      
      if (this.lastPosition) {
        distanceMoved = this.calculateDistance(
          this.lastPosition.lat,
          this.lastPosition.lon,
          currentLat,
          currentLon
        );
        
        console.log(`📏 [LiveDistanceTracker] Moved ${(distanceMoved * 1000).toFixed(0)}m since last check`);
      }

      // Update last position for next iteration
      this.lastPosition = { lat: currentLat, lon: currentLon };

      // STEP 3: Only update travel_dist if driver is on_duty AND has moved
      if (this.currentUser.driver_status !== 'on_duty') {
        console.log(`⏭️ [LiveDistanceTracker] Driver is ${this.currentUser.driver_status}, skipping travel_dist update`);
        return;
      }

      if (distanceMoved === 0) {
        console.log('⏭️ [LiveDistanceTracker] No movement detected, skipping update');
        return;
      }

      // STEP 4: Add distance to accumulated total
      this.accumulatedDistance += distanceMoved;
      console.log(`📊 [LiveDistanceTracker] Accumulated distance: ${this.accumulatedDistance.toFixed(3)} km`);

      // STEP 5: Find the next delivery (isNextDelivery = true)
      const todayStr = new Date().toISOString().split('T')[0];
      const nextDeliveries = await base44.entities.Delivery.filter({
        driver_id: this.currentUser.id,
        delivery_date: todayStr,
        isNextDelivery: true
      });

      const nextDelivery = nextDeliveries?.[0];

      if (!nextDelivery) {
        console.log('⏭️ [LiveDistanceTracker] No next delivery found');
        return;
      }

      // STEP 6: Update the next delivery's travel_dist
      const currentTravelDist = nextDelivery.travel_dist || 0;
      const newTravelDist = currentTravelDist + distanceMoved;

      console.log(`📏 [LiveDistanceTracker] Updating ${nextDelivery.patient_name || nextDelivery.delivery_notes}: ${currentTravelDist.toFixed(3)} + ${distanceMoved.toFixed(3)} = ${newTravelDist.toFixed(3)} km`);

      await base44.entities.Delivery.update(nextDelivery.id, {
        travel_dist: Math.round(newTravelDist * 1000) / 1000 // Round to 3 decimals
      });

      // STEP 7: Dispatch event to update UI
      window.dispatchEvent(new CustomEvent('travelDistUpdated', {
        detail: {
          deliveryId: nextDelivery.id,
          travel_dist: newTravelDist,
          distanceMoved: distanceMoved
        }
      }));

      // STEP 8: Update time on duty (if currently on_duty)
      if (this.dutyStartTime) {
        const elapsedMs = Date.now() - this.dutyStartTime;
        const currentTotalMinutes = Math.floor(elapsedMs / 60000);
        
        // Dispatch event to update UI with current time on duty
        window.dispatchEvent(new CustomEvent('timeOnDutyUpdated', {
          detail: {
            totalMinutes: currentTotalMinutes,
            formattedTime: this.formatDutyTime(currentTotalMinutes)
          }
        }));
      }

    } catch (error) {
      console.error('❌ [LiveDistanceTracker] Update error:', error);
    }
  }

  /**
   * Transfer accumulated distance when next stop changes
   * Called by handleStartDelivery
   */
  async transferDistance(oldNextDeliveryId, newNextDeliveryId) {
    try {
      console.log(`🔄 [LiveDistanceTracker] Transferring distance from ${oldNextDeliveryId} to ${newNextDeliveryId}`);
      console.log(`   Accumulated distance: ${this.accumulatedDistance.toFixed(3)} km`);

      // Reset accumulated distance counter
      this.accumulatedDistance = 0;

      // Note: The actual transfer happens in handleStartDelivery function
      // This method just resets our internal counter
      
      console.log('✅ [LiveDistanceTracker] Distance counter reset');
    } catch (error) {
      console.error('❌ [LiveDistanceTracker] Transfer error:', error);
    }
  }

  /**
   * Format duty time as HH:MM
   */
  formatDutyTime(totalMinutes) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  /**
   * Get current time on duty
   */
  getTimeOnDuty() {
    if (!this.dutyStartTime) {
      return this.formatDutyTime(this.totalTimeOnDuty);
    }

    const elapsedMs = Date.now() - this.dutyStartTime;
    const currentTotalMinutes = this.totalTimeOnDuty + Math.floor(elapsedMs / 60000);
    return this.formatDutyTime(currentTotalMinutes);
  }
}

export const liveDistanceTracker = new LiveDistanceTracker();