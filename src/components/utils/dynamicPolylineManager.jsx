/**
 * Dynamic Polyline Manager
 * Fetches and manages polylines between route segments based on current route state
 */

import { base44 } from '@/api/base44Client';
import { format } from 'date-fns';

/**
 * Determine which polyline segment to show based on route state
 * @returns {Object} { originLat, originLon, destLat, destLon, segmentType }
 */
export const determinePolylineSegment = (filteredDeliveries, driver, patients, stores) => {
  if (!filteredDeliveries || filteredDeliveries.length === 0) {
    return null;
  }

  const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
  const completedDeliveries = filteredDeliveries
    .filter(d => finishedStatuses.includes(d.status) && d.actual_delivery_time)
    .sort((a, b) => new Date(a.actual_delivery_time) - new Date(b.actual_delivery_time));
  
  const incompleteDeliveries = filteredDeliveries
    .filter(d => !finishedStatuses.includes(d.status))
    .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

  let originLat, originLon, destLat, destLon, segmentType;

  // CASE 1: All stops completed - show last stop to home
  if (incompleteDeliveries.length === 0 && completedDeliveries.length > 0) {
    segmentType = 'last_to_home';
    
    const lastCompleted = completedDeliveries[completedDeliveries.length - 1];
    
    // Get last stop coordinates
    if (lastCompleted.patient_id) {
      const patient = patients.find(p => p && p.id === lastCompleted.patient_id);
      originLat = patient?.latitude;
      originLon = patient?.longitude;
    } else {
      const store = stores.find(s => s && s.id === lastCompleted.store_id);
      originLat = store?.latitude;
      originLon = store?.longitude;
    }
    
    // Get home coordinates
    destLat = driver?.home_latitude;
    destLon = driver?.home_longitude;
  }
  // CASE 2: Has incomplete stops - show segment to next stop
  else if (incompleteDeliveries.length > 0) {
    const nextStop = incompleteDeliveries[0];
    
    // Get next stop coordinates
    if (nextStop.patient_id) {
      const patient = patients.find(p => p && p.id === nextStop.patient_id);
      destLat = patient?.latitude;
      destLon = patient?.longitude;
    } else {
      const store = stores.find(s => s && s.id === nextStop.store_id);
      destLat = store?.latitude;
      destLon = store?.longitude;
    }
    
    // Origin: Use driver's current location if available, otherwise last completed stop or home
    if (completedDeliveries.length > 0) {
      segmentType = 'current_to_next';
      
      // CRITICAL: Always use driver's current location when available (prevents bouncing)
      if (driver?.current_latitude && driver?.current_longitude && driver?.location_updated_at) {
        originLat = driver.current_latitude;
        originLon = driver.current_longitude;
      } else {
        // Fallback to last completed stop
        const lastCompleted = completedDeliveries[completedDeliveries.length - 1];
        
        if (lastCompleted.patient_id) {
          const patient = patients.find(p => p && p.id === lastCompleted.patient_id);
          originLat = patient?.latitude;
          originLon = patient?.longitude;
        } else {
          const store = stores.find(s => s && s.id === lastCompleted.store_id);
          originLat = store?.latitude;
          originLon = store?.longitude;
        }
      }
    } else {
      segmentType = 'home_to_first';
      
      // Use current location if available, otherwise home
      if (driver?.current_latitude && driver?.current_longitude && driver?.location_updated_at) {
        originLat = driver.current_latitude;
        originLon = driver.current_longitude;
      } else {
        originLat = driver?.home_latitude;
        originLon = driver?.home_longitude;
      }
    }
  }

  // Return null if missing coordinates
  if (!originLat || !originLon || !destLat || !destLon) {
    return null;
  }

  return { originLat, originLon, destLat, destLon, segmentType };
};

/**
 * Fetch polyline from Google Directions API
 * DISABLED: Currently using straight dotted line while testing route optimization
 * Re-enable by removing the early return below
 */
export const fetchPolylineForSegment = async (originLat, originLon, destLat, destLon) => {
  // DISABLED: Return null to use straight dotted line instead of Google Directions polyline
  // Remove this return statement to re-enable actual route polylines
  return null;
  
  try {
    const response = await base44.functions.invoke('getGoogleDirections', {
      origin: { lat: originLat, lon: originLon },
      destination: { lat: destLat, lon: destLon }
    });

    if (response?.data?.polyline) {
      return response.data.polyline;
    }
    return null;
  } catch (error) {
    console.error('❌ [Polyline Fetch] Error:', error);
    return null;
  }
};