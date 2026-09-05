import { base44 } from '@/api/base44Client';
import { getEdmontonDate } from './returnDeliveryBuilder';

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
    this.unflushedDistance = 0; // Distance accumulated locally since last server write (Sep 4 2026)
    this.lastFlushAt = 0; // Timestamp of last travel_dist server write
    this.FLUSH_DISTANCE_KM = 0.25; // Flush to server after this much unflushed movement
    this.FLUSH_INTERVAL_MS = 120000; // ...or after this much time (with distance pending)
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
    const todayStr = getEdmontonDate();

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
  /**
   * Update internal driver status state.
   *
   * SINGLE SOURCE OF TRUTH: DriverDailyActivity segments are recorded EXCLUSIVELY
   * by the backend setDriverStatus function. This method only updates internal
   * state so distance tracking and other logic have the correct current status.
   * Do NOT write segments here — that creates duplicate segments and race conditions.
   */
  async updateDriverStatus(newStatus) {
    if (!this.currentUser) return;
    const previousStatus = this.currentUser.driver_status;
    this.currentUser.driver_status = newStatus;
    console.log(`📍 [LiveDistanceTracker] Internal status updated: ${previousStatus} → ${newStatus} (segments handled by backend)`);
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

      // STEP 3: Only track travel_dist while driver is on_duty AND moving
      if (this.currentUser.driver_status !== 'on_duty') {
        this.unflushedDistance = 0; // Distance driven off-duty never counts toward mileage
        return;
      }

      if (distanceMoved === 0) {
        return; // Nothing new to flush — skip server calls entirely on idle ticks
      }

      // STEP 4: Accumulate locally — NO server calls on the 20s tick itself.
      // Sep 4 2026: this tracker previously fetched all today's deliveries and
      // wrote travel_dist to the next delivery on EVERY 20s tick. Each write is
      // a user-scoped entity update → WebSocket broadcast to every dispatcher/
      // admin device, whose realtimeSync handlers then merged + re-rendered —
      // pure churn with no visible benefit between flushes. We now write only
      // when the unflushed distance is meaningful (≥ FLUSH_DISTANCE_KM) or the
      // last write is ≥ FLUSH_INTERVAL_MS old. Total mileage is preserved: the
      // pending distance is added to whichever stop is next at flush time.
      this.accumulatedDistance += distanceMoved;
      this.unflushedDistance += distanceMoved;

      const nowMs = Date.now();
      const flushDueByDistance = this.unflushedDistance >= this.FLUSH_DISTANCE_KM;
      const flushDueByTime = this.unflushedDistance > 0 &&
        (this.lastFlushAt === 0 || (nowMs - this.lastFlushAt) >= this.FLUSH_INTERVAL_MS);
      if (!flushDueByDistance && !flushDueByTime) {
        return; // Keep accumulating silently — no server fetch, no WS broadcast
      }

      // CRITICAL: Check if at least one stop has been completed before tracking distance
      // Edmonton-local date — the UTC date below broke evening mileage tracking:
      // after 18:00 local (UTC date rollover), the filter targeted the wrong day,
      // found no next delivery, and silently discarded pending distance.
      const todayStr = getEdmontonDate();
      const allTodayDeliveries = await base44.entities.Delivery.filter({
        driver_id: this.currentUser.id,
        delivery_date: todayStr
      });

      const finishedStatuses = ['completed', 'failed', 'cancelled'];
      const hasCompletedStops = allTodayDeliveries.some(d =>
        d && finishedStatuses.includes(d.status)
      );

      if (!hasCompletedStops) {
        // Mileage tracking starts after the first stop — discard pre-first-stop distance
        this.unflushedDistance = 0;
        this.lastFlushAt = nowMs;
        return;
      }

      // STEP 5: Find the next delivery (isNextDelivery = true)
      const nextDeliveries = allTodayDeliveries.filter(d => d && d.isNextDelivery === true);

      const nextDelivery = nextDeliveries?.[0];

      if (!nextDelivery || !nextDelivery.id) {
        // No active next delivery — distance driven now can't be attributed; discard
        this.unflushedDistance = 0;
        this.lastFlushAt = nowMs;
        return;
      }

      // STEP 6: Update the next delivery's travel_dist with everything accumulated
      // since the last flush (not just this tick's delta)
      const currentTravelDist = nextDelivery.travel_dist || 0;
      const pendingDistance = this.unflushedDistance;
      const newTravelDist = currentTravelDist + pendingDistance;

      console.log(`📏 [LiveDistanceTracker] Updating ${nextDelivery.patient_name || nextDelivery.delivery_id}: ${currentTravelDist.toFixed(3)} + pending = ${newTravelDist.toFixed(3)} km`);

      await base44.entities.Delivery.update(nextDelivery.id, {
        travel_dist: Math.round(newTravelDist * 1000) / 1000 // Round to 3 decimals
      });

      // Write succeeded — clear the pending buffer only now so a failed write
      // retries with the full pending distance on the next tick.
      this.unflushedDistance = 0;
      this.lastFlushAt = nowMs;

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