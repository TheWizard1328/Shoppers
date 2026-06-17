/**
 * Real-time Location Broadcaster
 * 
 * Ensures AppUser WebSocket updates trigger immediate marker updates
 * by dispatching driverLocationsUpdated events with fromRealtime flag.
 */

export function broadcastRealtimeLocationUpdate(appUserData) {
  if (!appUserData) return;
  
  // Only broadcast if driver has location tracking enabled and coordinates
  if (appUserData.location_tracking_enabled && 
      appUserData.current_latitude && 
      appUserData.current_longitude) {
    
    console.log(`📢 [Realtime Broadcast] ${appUserData.user_name} - dispatching location update`);
    
    window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
      detail: { appUsers: [appUserData], fromRealtime: true }
    }));
  }
}