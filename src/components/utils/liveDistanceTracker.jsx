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
    // NOTE: dutyStartTime/totalTimeOnDuty are legacy in-memory fields — no longer used.
    // Duty time is now derived exclusively from DB activity_segments.

    console.log('🚀 [LiveDistanceTracker] Started tracking for', user.user_name || user.full_name || user.id);

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

    console.log('🛑 [LiveDistanceTracker] Stopped tracking');
  }

  /**
   * Get or create DriverDailyActivity record for today.
   * Uses activity_segments array — each segment is one continuous on-duty window.
   */
  async getOrCreateDailyActivity(driverId) {
    const todayStr = new Date().toISOString().split('T')[0];

    const existing = await base44.entities.DriverDailyActivity.filter({
      driver_id: driverId,
      activity_date: todayStr
    });

    if (existing && existing.length > 0) return existing[0];

    const driverName = this.currentUser?.user_name || this.currentUser?.full_name || '';
    const newRecord = await base44.entities.DriverDailyActivity.create({
      driver_id: driverId,
      driver_name: driverName,
      activity_date: todayStr,
      activity_segments: []
    });

    console.log('📅 [LiveDistanceTracker] Created new DriverDailyActivity for', todayStr);
    return newRecord;
  }

  /**
   * Update driver status and record on-duty segments.
   *
   * On Duty  → push a new open segment { start_time: now, end_time: null, tot: null }
   *            (also closes any dangling open segment first — crash recovery)
   * On Break / Off Duty → close the open segment: set end_time + tot
   */
  async updateDriverStatus(newStatus) {
    const previousStatus = this.currentUser?.driver_status;

    if (!this.currentUser) return;

    this.currentUser.driver_status = newStatus;

    try {
      const dailyActivity = await this.getOrCreateDailyActivity(this.currentUser.id);

      if (!dailyActivity) {
        console.error('❌ [LiveDistanceTracker] Could not get/create DriverDailyActivity');
        return;
      }

      const segments = Array.isArray(dailyActivity.activity_segments)
        ? [...dailyActivity.activity_segments]
        : [];

      const now = new Date().toISOString();
      const nowMs = Date.now();

      if (newStatus === 'on_duty' && previousStatus !== 'on_duty') {
        // ── Crash-recovery: close any dangling open segment before pushing a new one ──
        const openIdx = segments.findIndex(s => s.start_time && !s.end_time);
        if (openIdx !== -1) {
          const danglingStartMs = new Date(segments[openIdx].start_time).getTime();
          const danglingTot = Math.max(0, Math.round((nowMs - danglingStartMs) / 60000));
          segments[openIdx] = { ...segments[openIdx], end_time: now, tot: danglingTot };
          console.log(`🔧 [LiveDistanceTracker] Closed dangling segment (${danglingTot} min)`);
        }

        // Push new open segment
        segments.push({ start_time: now, end_time: null, tot: null });
        await base44.entities.DriverDailyActivity.update(dailyActivity.id, { activity_segments: segments });
        console.log('⏱️ [LiveDistanceTracker] New on-duty segment opened');

      } else if ((newStatus === 'on_break' || newStatus === 'off_duty') && previousStatus === 'on_duty') {
        // ── Close the open segment ──
        const openIdx = segments.findIndex(s => s.start_time && !s.end_time);
        if (openIdx !== -1) {
          const startMs = new Date(segments[openIdx].start_time).getTime();
          const tot = Math.max(0, Math.round((nowMs - startMs) / 60000));
          segments[openIdx] = { ...segments[openIdx], end_time: now, tot };
          await base44.entities.DriverDailyActivity.update(dailyActivity.id, { activity_segments: segments });
          console.log(`⏸️ [LiveDistanceTracker] Segment closed — ${tot} min on duty`);
        }

      } else if (newStatus === 'on_duty' && previousStatus === 'on_break') {
        // Returning from break — same as fresh on_duty (open a new segment)
        const openIdx = segments.findIndex(s => s.start_time && !s.end_time);
        if (openIdx !== -1) {
          // Shouldn't exist, but close defensively
          const startMs = new Date(segments[openIdx].start_time).getTime();
          segments[openIdx] = { ...segments[openIdx], end_time: now, tot: Math.max(0, Math.round((nowMs - startMs) / 60000)) };
        }
        segments.push({ start_time: now, end_time: null, tot: null });
        await base44.entities.DriverDailyActivity.update(dailyActivity.id, { activity_segments: segments });
        console.log('⏱️ [LiveDistanceTracker] Return-from-break segment opened');
      }

    } catch (error) {
      console.error('❌ [LiveDistanceTracker] Error updating driver status:', error);
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

      // STEP 3: Only update travel_dist if driver is on_duty AND has moved AND first stop is completed
      if (this.currentUser.driver_status !== 'on_duty') {
        console.log(`⏭️ [LiveDistanceTracker] Driver is ${this.currentUser.driver_status}, skipping travel_dist update`);
        return;
      }

      if (distanceMoved === 0) {
        console.log('⏭️ [LiveDistanceTracker] No movement detected, skipping update');
        return;
      }

      // CRITICAL: Check if at least one stop has been completed before tracking distance
      const todayStr = new Date().toISOString().split('T')[0];
      const allTodayDeliveries = await base44.entities.Delivery.filter({
        driver_id: this.currentUser.id,
        delivery_date: todayStr
      });
      
      const finishedStatuses = ['completed', 'failed', 'cancelled'];
      const hasCompletedStops = allTodayDeliveries.some(d => 
        d && finishedStatuses.includes(d.status)
      );
      
      if (!hasCompletedStops) {
        console.log('⏭️ [LiveDistanceTracker] No completed stops yet - mileage tracking starts after first stop');
        return;
      }

      // STEP 4: Add distance to accumulated total
      this.accumulatedDistance += distanceMoved;
      console.log(`📊 [LiveDistanceTracker] Accumulated distance: ${this.accumulatedDistance.toFixed(3)} km`);

      // STEP 5: Find the next delivery (isNextDelivery = true)
      const nextDeliveries = allTodayDeliveries.filter(d => d && d.isNextDelivery === true);

      const nextDelivery = nextDeliveries?.[0];

      if (!nextDelivery || !nextDelivery.id) {
        console.log('⏭️ [LiveDistanceTracker] No next delivery found or missing ID');
        return;
      }

      // STEP 6: Update the next delivery's travel_dist
      const currentTravelDist = nextDelivery.travel_dist || 0;
      const newTravelDist = currentTravelDist + distanceMoved;

      console.log(`📏 [LiveDistanceTracker] Updating ${nextDelivery.patient_name || nextDelivery.delivery_id}: ${currentTravelDist.toFixed(3)} + ${distanceMoved.toFixed(3)} = ${newTravelDist.toFixed(3)} km`);

      await base44.entities.Delivery.update(nextDelivery.id, {
        travel_dist: Math.round(newTravelDist * 1000) / 1000 // Round to 3 decimals
      });

      // STEP 7: Calculate total accumulated distance (all completed + current in-progress)
      // Use allTodayDeliveries already fetched in STEP 3
      const completedDeliveries = allTodayDeliveries.filter(d => 
        d && finishedStatuses.includes(d.status)
      );
      
      // Sum up travel_dist from all completed deliveries
      const completedDistance = completedDeliveries.reduce((sum, d) => 
        sum + (d.travel_dist || 0), 0
      );
      
      const totalDistance = completedDistance + newTravelDist;
      
      console.log(`📊 [LiveDistanceTracker] Total distance: ${completedDistance.toFixed(3)} km (completed) + ${newTravelDist.toFixed(3)} km (in-progress) = ${totalDistance.toFixed(3)} km`);

      // STEP 8: Dispatch event to update UI with total accumulated distance
      window.dispatchEvent(new CustomEvent('travelDistUpdated', {
        detail: {
          deliveryId: nextDelivery.id,
          travel_dist: newTravelDist,
          distanceMoved: distanceMoved,
          totalAccumulatedDistance: totalDistance, // Total: completed + in-progress
          completedDistance: completedDistance,
          inProgressDistance: newTravelDist
        }
      }));

      // STEP 8: Calculate and dispatch time on duty (first stop to now, minus breaks)
      await this.updateTimeOnDuty();

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
   * Calculate time on duty
   * - If active stops remain: use live calculation (now - first stop - breaks)
   * - If all stops done: dispatch null to use backend value (last - first - breaks)
   */
  async updateTimeOnDuty() {
    try {
      if (!this.currentUser) return;

      const todayStr = new Date().toISOString().split('T')[0];
      const todayDeliveries = await base44.entities.Delivery.filter({
        driver_id: this.currentUser.id,
        delivery_date: todayStr
      });

      const finishedStatuses = ['completed', 'failed', 'cancelled'];
      const completedStops = todayDeliveries
        .filter(d => d && finishedStatuses.includes(d.status) && d.actual_delivery_time)
        .sort((a, b) => new Date(a.actual_delivery_time) - new Date(b.actual_delivery_time));

      // CRITICAL: Count ALL active stops (patient deliveries + pickups)
      const activeStops = todayDeliveries.filter(d => 
        d && !finishedStatuses.includes(d.status) && d.status !== 'pending'
      );

      // If no completed stops yet, time is 0
      if (completedStops.length === 0) {
        window.dispatchEvent(new CustomEvent('timeOnDutyUpdated', {
          detail: { totalMinutes: 0, formattedTime: '00:00' }
        }));
        return;
      }

      // If all stops are done, use backend value (null triggers fallback)
      if (activeStops.length === 0) {
        console.log('⏭️ [LiveDistanceTracker] All stops complete - using backend value');
        window.dispatchEvent(new CustomEvent('timeOnDutyUpdated', {
          detail: { totalMinutes: null, formattedTime: null }
        }));
        return;
      }

      // Active stops remain - calculate live time (now - first stop - breaks)
      const extractLocalMinutes = (timeStr) => {
        const match = timeStr?.match(/T(\d{2}):(\d{2})/);
        return match ? parseInt(match[1], 10) * 60 + parseInt(match[2], 10) : null;
      };

      const firstStopMinutes = extractLocalMinutes(completedStops[0].actual_delivery_time);
      if (firstStopMinutes === null) return;

      const now = new Date();
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      let elapsedMinutes = currentMinutes - firstStopMinutes;
      if (elapsedMinutes < 0) elapsedMinutes += 24 * 60;

      const dailyActivities = await base44.entities.DriverDailyActivity.filter({
        driver_id: this.currentUser.id,
        activity_date: todayStr
      });
      const segments = dailyActivities?.[0]?.activity_segments || [];
      const nowMs = Date.now();

      // Sum closed segments + live-compute any open segment
      const totalOnDutyMinutes = segments.reduce((sum, seg) => {
        if (!seg?.start_time) return sum;
        if (seg.end_time && typeof seg.tot === 'number') return sum + seg.tot;
        if (!seg.end_time) {
          // Open segment — driver currently on duty
          return sum + Math.max(0, Math.round((nowMs - new Date(seg.start_time).getTime()) / 60000));
        }
        return sum;
      }, 0);

      console.log(`⏱️ [LiveDistanceTracker] Live on-duty: ${totalOnDutyMinutes} min (${activeStops.length} active stops)`);

      window.dispatchEvent(new CustomEvent('timeOnDutyUpdated', {
        detail: {
          totalMinutes: totalOnDutyMinutes,
          formattedTime: this.formatDutyTime(totalOnDutyMinutes)
        }
      }));

    } catch (error) {
      console.error('❌ [LiveDistanceTracker] Time calculation error:', error);
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
   * Instant poll - calculate and dispatch current total distance and time on duty
   * Called on app refresh/mount to immediately show stats
   */
  async instantPoll() {
    if (!this.currentUser) {
      console.log('⏭️ [LiveDistanceTracker] Instant poll - no user');
      return;
    }

    try {
      console.log('⚡ [LiveDistanceTracker] INSTANT POLL - calculating current stats...');

      const todayStr = new Date().toISOString().split('T')[0];
      
      // Fetch all today's deliveries for driver
      const allTodayDeliveries = await base44.entities.Delivery.filter({
        driver_id: this.currentUser.id,
        delivery_date: todayStr
      });

      // Calculate total distance: sum of all completed deliveries + current in-progress
      const finishedStatuses = ['completed', 'failed', 'cancelled'];
      const completedDeliveries = allTodayDeliveries.filter(d => 
        d && finishedStatuses.includes(d.status)
      );
      
      const completedDistance = completedDeliveries.reduce((sum, d) => 
        sum + (d.travel_dist || 0), 0
      );
      
      // Find next delivery to get in-progress distance
      const nextDelivery = allTodayDeliveries.find(d => d && d.isNextDelivery === true);
      const inProgressDistance = nextDelivery?.travel_dist || 0;
      
      const totalDistance = completedDistance + inProgressDistance;
      
      console.log(`📊 [Instant Poll] Distance: ${completedDistance.toFixed(3)} km (completed) + ${inProgressDistance.toFixed(3)} km (in-progress) = ${totalDistance.toFixed(3)} km`);

      // Dispatch distance update
      window.dispatchEvent(new CustomEvent('travelDistUpdated', {
        detail: {
          deliveryId: nextDelivery?.id || null,
          travel_dist: inProgressDistance,
          distanceMoved: 0,
          totalAccumulatedDistance: totalDistance,
          completedDistance: completedDistance,
          inProgressDistance: inProgressDistance
        }
      }));

      // Calculate and dispatch time on duty
      await this.updateTimeOnDuty();

      console.log('✅ [Instant Poll] Stats dispatched to UI');

    } catch (error) {
      console.error('❌ [LiveDistanceTracker] Instant poll error:', error);
    }
  }
}

export const liveDistanceTracker = new LiveDistanceTracker();