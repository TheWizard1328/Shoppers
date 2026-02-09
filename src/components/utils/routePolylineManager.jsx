// routePolylineManager.js - Manages Google Directions API calls and polyline storage

import { base44 } from "@/api/base44Client";
import { format } from "date-fns";
import { queueEntityRequest } from "./requestQueue";

/**
 * Configuration for route polyline management
 */
const POLYLINE_CONFIG = {
  EXPIRY_MINUTES: 10, // How long a polyline is considered fresh
  MIN_DISTANCE_CHANGE_METERS: 1000, // Minimum distance change to trigger new route fetch (1km)
  COORDINATE_PRECISION: 6 // Decimal places for coordinate comparison
};

/**
 * Calculates distance between two coordinates in meters (Haversine formula)
 */
const calculateDistanceBetweenCoords = (lat1, lon1, lat2, lon2) => {
  const R = 6371e3; // Earth's radius in meters
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c / 1000; // Distance in kilometers
};

/**
 * Rounds coordinates to specified precision for comparison
 */
const roundCoordinate = (coord, precision = POLYLINE_CONFIG.COORDINATE_PRECISION) => {
  return parseFloat(coord.toFixed(precision));
};

/**
 * Checks if a stored polyline is still fresh (not expired)
 */
const isPolylineFresh = (polyline) => {
  if (!polyline?.expires_at) return false;
  
  const expiryTime = new Date(polyline.expires_at);
  const now = new Date();
  
  return now < expiryTime;
};

/**
 * Checks if coordinates have changed significantly
 */
const hasCoordinatesChanged = (oldLat, oldLon, newLat, newLon) => {
  if (!oldLat || !oldLon || !newLat || !newLon) return true;
  
  const distance = calculateDistanceBetweenCoords(oldLat, oldLon, newLat, newLon);
  return distance > (POLYLINE_CONFIG.MIN_DISTANCE_CHANGE_METERS / 1000); // Convert to km
};

/**
 * Fetches route from Google Directions API
 * 
 * @param {number} startLat
 * @param {number} startLon
 * @param {number} endLat
 * @param {number} endLon
 * @param {string} googleApiKey - Google Maps API key
 * @returns {Promise<Object>} Route data with encoded polyline
 */
const fetchGoogleDirections = async (startLat, startLon, endLat, endLon, googleApiKey) => {
  console.log('🗺️ [RoutePolyline] Fetching route from Google Directions API via backend:', {
    origin: `${startLat.toFixed(6)},${startLon.toFixed(6)}`,
    destination: `${endLat.toFixed(6)},${endLon.toFixed(6)}`
  });

  try {
    const response = await base44.functions.invoke('getGoogleDirections', {
      origin_lat: startLat,
      origin_lon: startLon,
      dest_lat: endLat,
      dest_lon: endLon
    });

    if (!response.data) {
      throw new Error('No data returned from backend function');
    }

    return {
      encoded_polyline: response.data.encoded_polyline,
      distance_km: response.data.distance_km,
      duration_seconds: response.data.duration_seconds
    };
  } catch (error) {
    console.error('❌ [RoutePolyline] Error fetching Google Directions:', error);
    throw error;
  }
};

/**
 * Finds existing polyline in database
 * 
 * @param {string} driverId - Driver's ID
 * @param {string} deliveryDate - Date in yyyy-MM-dd format
 * @param {string} routeType - Type of route segment
 * @param {number} startLat - Optional start latitude for coordinate matching
 * @param {number} startLon - Optional start longitude for coordinate matching
 * @param {number} endLat - Optional end latitude for coordinate matching
 * @param {number} endLon - Optional end longitude for coordinate matching
 * @returns {Promise<Object|null>} Existing polyline or null
 */
const getStoredPolyline = async (driverId, deliveryDate, routeType, startLat = null, startLon = null, endLat = null, endLon = null) => {
   try {
     const polylines = await queueEntityRequest(
       () => base44.entities.DriverRoutePolyline.filter({
         driver_id: driverId,
         delivery_date: deliveryDate,
         route_type: routeType
       }),
       'DriverRoutePolyline filter [getStoredPolyline]'
     );

    if (!polylines || polylines.length === 0) {
      return null;
    }

    // If coordinates provided, find exact match
    if (startLat !== null && startLon !== null && endLat !== null && endLon !== null) {
      const roundedStartLat = roundCoordinate(startLat);
      const roundedStartLon = roundCoordinate(startLon);
      const roundedEndLat = roundCoordinate(endLat);
      const roundedEndLon = roundCoordinate(endLon);

      const matchingPolyline = polylines.find((p) => {
        const pStartLat = roundCoordinate(p.segment_start_lat);
        const pStartLon = roundCoordinate(p.segment_start_lon);
        const pEndLat = roundCoordinate(p.segment_end_lat);
        const pEndLon = roundCoordinate(p.segment_end_lon);

        return (
          pStartLat === roundedStartLat &&
          pStartLon === roundedStartLon &&
          pEndLat === roundedEndLat &&
          pEndLon === roundedEndLon
        );
      });

      return matchingPolyline || null;
    }

    // Otherwise return most recent
    const sortedPolylines = polylines.sort((a, b) => 
      new Date(b.generated_at) - new Date(a.generated_at)
    );
    
    return sortedPolylines[0];
  } catch (error) {
    console.error('❌ [RoutePolyline] Error finding polyline:', error);
    return null;
  }
};

/**
 * Saves or updates a route polyline in the database
 */
const savePolyline = async ({
  driverId,
  deliveryDate,
  routeType,
  startLat,
  startLon,
  endLat,
  endLon,
  encodedPolyline,
  estimatedDistanceKm,
  estimatedDurationSeconds
}) => {
  const now = new Date();
  const todayStr = format(now, 'yyyy-MM-dd');
  
  // Set expiry to next day at midnight (date only)
  const expiresAt = new Date(now);
  expiresAt.setDate(expiresAt.getDate() + 1);
  expiresAt.setHours(0, 0, 0, 0);

  try {
    // CRITICAL: Check if ALL required fields are populated for a complete polyline
    const isCompletePolyline = !!(
      encodedPolyline &&
      startLat != null &&
      startLon != null &&
      endLat != null &&
      endLon != null &&
      estimatedDistanceKm != null &&
      estimatedDurationSeconds != null
    );

    // Check for existing polyline to update
    const existing = await getStoredPolyline(driverId, deliveryDate, routeType, startLat, startLon, endLat, endLon);

    // Get any polyline for this driver to check daily count
    const allPolylinesForDriver = await queueEntityRequest(
      () => base44.entities.DriverRoutePolyline.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      }),
      'DriverRoutePolyline filter'
    );
    
    // Check if we need to reset the daily counter
    let dailyCount = 0;
    
    // CRITICAL: Only increment counter if this is a COMPLETE polyline
    if (isCompletePolyline) {
      if (allPolylinesForDriver && allPolylinesForDriver.length > 0) {
        const latestPolyline = allPolylinesForDriver.sort((a, b) => 
          new Date(b.last_generated_at || b.created_date) - new Date(a.last_generated_at || a.created_date)
        )[0];
        
        dailyCount = (latestPolyline.daily_generation_count || 0) + 1;
        console.log(`🔄 [RoutePolyline] Incrementing daily count to ${dailyCount} (complete polyline)`);
      } else {
        // First polyline of the day
        dailyCount = 1;
        console.log('🔄 [RoutePolyline] First complete polyline, setting counter to 1');
      }
    } else {
      // Incomplete polyline - keep existing count
      if (existing) {
        dailyCount = existing.daily_generation_count || 0;
        console.log(`⏭️ [RoutePolyline] Incomplete polyline - keeping existing count: ${dailyCount}`);
      } else {
        dailyCount = 0;
        console.log('⚠️ [RoutePolyline] Incomplete polyline - setting count to 0');
      }
    }

    const polylineData = {
      driver_id: driverId,
      delivery_date: deliveryDate,
      segment_origin_lat: startLat,
      segment_origin_lon: startLon,
      segment_dest_lat: endLat,
      segment_dest_lon: endLon,
      encoded_polyline: encodedPolyline,
      route_type: routeType,
      estimated_distance_km: estimatedDistanceKm,
      estimated_duration_minutes: estimatedDurationSeconds ? Math.round(estimatedDurationSeconds / 60) : null,
      last_generated_at: now.toISOString(),
      daily_generation_count: dailyCount
    };
    
    if (existing) {
      console.log('🔄 [RoutePolyline] Updating existing polyline:', existing.id, '- Daily count:', dailyCount);
      await base44.entities.DriverRoutePolyline.update(existing.id, polylineData);
      console.log('✅ [RoutePolyline] Polyline updated successfully');
    } else {
      console.log('➕ [RoutePolyline] Creating new polyline - Daily count:', dailyCount);
      await base44.entities.DriverRoutePolyline.create(polylineData);
      console.log('✅ [RoutePolyline] Polyline created successfully');
    }
  } catch (error) {
    console.error('❌ [RoutePolyline] Error saving polyline:', error);
    throw error;
  }
};

/**
 * Get or generate the active route polyline from current position to next stop
 * CRITICAL: Only fetches polyline AFTER delivery completion (onlyAfterDeliveryComplete flag)
 * Only updates the entity if the current user is the driver
 * Smart refresh based on distance, time, and coordinate changes
 */
export const getCurrentToNextStopPolyline = async ({
  driverId,
  deliveryDate,
  currentDriverLocation, // { latitude, longitude } - driver's live GPS
  lastCompletedStopLocation, // { lat, lon } - last completed stop
  nextStopLocation, // { lat, lon } - next stop
  googleApiKey,
  isCurrentUserTheDriver = false, // Only true if current user IS this driver
  onlyAfterDeliveryComplete = true // CRITICAL: Only fetch polyline after delivery is marked complete
}) => {
  try {
    console.log('🗺️ [getCurrentToNextStopPolyline] Starting...', {
      driverId,
      deliveryDate,
      hasCurrentLocation: !!currentDriverLocation,
      hasLastCompleted: !!lastCompletedStopLocation,
      hasNextStop: !!nextStopLocation,
      isCurrentUserTheDriver,
      onlyAfterDeliveryComplete
    });

    // CRITICAL: Skip polyline generation if not after delivery completion
    if (onlyAfterDeliveryComplete) {
      console.log('⏭️ [getCurrentToNextStopPolyline] Skipping - not yet after delivery completion');
      return null;
    }

    if (!nextStopLocation?.lat || !nextStopLocation?.lon) {
      console.log('⚠️ No next stop location provided');
      return null;
    }

    // Determine start point: prefer current driver location if >1km from last completed
    let startPoint = lastCompletedStopLocation || currentDriverLocation;
    let useDriverLocation = false;

    if (currentDriverLocation && lastCompletedStopLocation) {
      const distanceFromLastStop = calculateDistanceBetweenCoords(
        lastCompletedStopLocation.lat,
        lastCompletedStopLocation.lon,
        currentDriverLocation.latitude,
        currentDriverLocation.longitude
      );

      if (distanceFromLastStop > 1.0) {
        console.log(`📍 Driver >1km from last stop (${distanceFromLastStop.toFixed(2)}km), using driver location`);
        startPoint = { lat: currentDriverLocation.latitude, lon: currentDriverLocation.longitude };
        useDriverLocation = true;
      }
    } else if (currentDriverLocation && !lastCompletedStopLocation) {
      startPoint = { lat: currentDriverLocation.latitude, lon: currentDriverLocation.longitude };
      useDriverLocation = true;
    }

    if (!startPoint) {
      console.log('⚠️ No valid start point');
      return null;
    }

    // Check for existing polyline
    const existingPolyline = await getStoredPolyline(
      driverId,
      deliveryDate,
      'to_next_stop',
      startPoint.lat,
      startPoint.lon,
      nextStopLocation.lat,
      nextStopLocation.lon
    );

    const now = new Date();

    // Determine regeneration reason
    let regenerationReason = null;

    // Check if existing polyline is still valid
    if (existingPolyline && existingPolyline.encoded_polyline) {
      const isFresh = isPolylineFresh(existingPolyline);
      const generatedAt = new Date(existingPolyline.generated_at);
      const ageMinutes = (now - generatedAt) / (1000 * 60);

      console.log('📦 Found existing polyline:', {
        isFresh,
        ageMinutes: ageMinutes.toFixed(1),
        expiresAt: existingPolyline.expires_at
      });

      // Use cached if fresh AND less than 5 minutes old
      if (isFresh && ageMinutes < 5) {
        console.log('✅ Using cached polyline');
        return decodePolyline(existingPolyline.encoded_polyline);
      }

      // Determine why we're regenerating
      if (!isFresh) {
        regenerationReason = 'Polyline has expired';
      } else if (ageMinutes >= 5) {
        regenerationReason = `Polyline age exceeds 5 minutes (${ageMinutes.toFixed(1)} min old)`;
      }

      console.log('🔄 Cached polyline expired or too old, refreshing...');
    } else if (!existingPolyline) {
      regenerationReason = 'No existing polyline found';
    } else if (!existingPolyline.encoded_polyline) {
      regenerationReason = 'Existing polyline missing encoded data';
    }

    // Check if driver location has changed significantly
    if (existingPolyline && useDriverLocation && currentDriverLocation) {
      const distanceChanged = calculateDistanceBetweenCoords(
        existingPolyline.segment_start_lat,
        existingPolyline.segment_start_lon,
        currentDriverLocation.latitude,
        currentDriverLocation.longitude
      );

      if (distanceChanged > (POLYLINE_CONFIG.MIN_DISTANCE_CHANGE_METERS / 1000)) {
        regenerationReason = `Significant driver distance change (${distanceChanged.toFixed(2)}km)`;
      }
    }

    // Only the driver can update the polyline
    if (!isCurrentUserTheDriver) {
      console.log('⏭️ Not the driver, using cached or returning null');
      return existingPolyline ? decodePolyline(existingPolyline.encoded_polyline) : null;
    }

    // Generate new polyline from Google Directions API
    console.log('🌐 [RoutePolyline] Generating new route polyline...');
    if (regenerationReason) {
      console.log(`🔍 [RoutePolyline] Reason: ${regenerationReason}`);
    }
    const routeData = await fetchGoogleDirections(
      startPoint.lat,
      startPoint.lon,
      nextStopLocation.lat,
      nextStopLocation.lon,
      googleApiKey
    );

    if (!routeData || !routeData.encoded_polyline) {
      console.log('❌ Failed to fetch route from Google');
      return existingPolyline ? decodePolyline(existingPolyline.encoded_polyline) : null;
    }

    // Save the new polyline
    await savePolyline({
      driverId,
      deliveryDate,
      routeType: 'to_next_stop',
      startLat: startPoint.lat,
      startLon: startPoint.lon,
      endLat: nextStopLocation.lat,
      endLon: nextStopLocation.lon,
      encodedPolyline: routeData.encoded_polyline,
      estimatedDistanceKm: routeData.distance_km,
      estimatedDurationSeconds: routeData.duration_seconds
    });

    console.log('✅ New polyline generated and saved');
    return decodePolyline(routeData.encoded_polyline);

  } catch (error) {
    console.error('[getCurrentToNextStopPolyline] Error:', error);
    return null;
  }
};

/**
 * Decodes a Google encoded polyline string into array of LatLng coordinates
 * Implementation of Google's polyline encoding algorithm
 * 
 * @param {string} encoded - Encoded polyline string from Google
 * @returns {Array<{lat: number, lng: number}>} Array of coordinates
 */
export const decodePolyline = (encoded) => {
  if (!encoded) return [];

  const poly = [];
  let index = 0;
  const len = encoded.length;
  let lat = 0;
  let lng = 0;

  while (index < len) {
    let b;
    let shift = 0;
    let result = 0;

    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);

    const dlat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lat += dlat;

    shift = 0;
    result = 0;

    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);

    const dlng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lng += dlng;

    poly.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }

  return poly;
};

// In-memory cache for polyline queries to prevent rate limits
const polylineQueryCache = new Map();
const POLYLINE_CACHE_DURATION = 5000; // 5 seconds

/**
 * Fetches and decodes a stored polyline for display
 * This should be called from any device to display the route
 * 
 * @param {string} driverId - Driver's ID
 * @param {string} deliveryDate - Date in yyyy-MM-dd format
 * @param {string} routeType - Type of route segment
 * @returns {Promise<Array<{lat: number, lng: number}>|null>} Decoded coordinates or null
 */
export const getStoredRouteCoordinates = async (driverId, deliveryDate, routeType) => {
  try {
    const cacheKey = `${driverId}_${deliveryDate}_${routeType}`;
    const now = Date.now();
    
    // Check cache first
    const cached = polylineQueryCache.get(cacheKey);
    if (cached && (now - cached.timestamp) < POLYLINE_CACHE_DURATION) {
      return cached.data;
    }

    console.log('📍 [RoutePolyline] Fetching stored route coordinates:', {
      driverId,
      deliveryDate,
      routeType
    });

    // CRITICAL FIX: Don't filter by route_type as backend optimizer doesn't set it
     // Instead, filter by driver_id and delivery_date only
     const polylines = await queueEntityRequest(
       () => base44.entities.DriverRoutePolyline.filter({
         driver_id: driverId,
         delivery_date: deliveryDate
       }),
       `DriverRoutePolyline filter [${driverId}, ${deliveryDate}]`
     );

    if (!polylines || polylines.length === 0) {
      console.log('📍 [RoutePolyline] No stored polyline found');
      return null;
    }

    // Get the most recently updated polyline (use updated_date since last_generated_at may not be set)
    const sortedPolylines = polylines.sort((a, b) => {
      const aDate = a.last_generated_at || a.updated_date || a.created_date;
      const bDate = b.last_generated_at || b.updated_date || b.created_date;
      return new Date(bDate) - new Date(aDate);
    });
    
    const latestPolyline = sortedPolylines[0];

    // Check if the polyline has encoded data
    if (!latestPolyline.encoded_polyline) {
      console.log('📍 [RoutePolyline] Polyline exists but has no encoded data');
      return null;
    }

    console.log('✅ [RoutePolyline] Found polyline, decoding:', {
      id: latestPolyline.id,
      hasEncodedPolyline: !!latestPolyline.encoded_polyline,
      lastGenerated: latestPolyline.last_generated_at,
      originLat: latestPolyline.segment_origin_lat,
      originLon: latestPolyline.segment_origin_lon,
      destLat: latestPolyline.segment_dest_lat,
      destLon: latestPolyline.segment_dest_lon
    });

    // Decode the polyline
    const coordinates = decodePolyline(latestPolyline.encoded_polyline);

    console.log('✅ [RoutePolyline] Decoded', coordinates.length, 'coordinate points');

    // Cache the result
    polylineQueryCache.set(cacheKey, {
      timestamp: now,
      data: coordinates
    });

    return coordinates;
  } catch (error) {
    // Handle rate limit errors gracefully
    if (error.response?.status === 429 || error.message?.includes('429')) {
      console.warn('⚠️ [RoutePolyline] Rate limit hit - using cached data');
      const cached = polylineQueryCache.get(cacheKey);
      return cached?.data || null;
    }
    console.error('❌ [RoutePolyline] Error getting stored route coordinates:', error);
    return null;
  }
};

/**
 * Generic function to get or generate a route polyline between any two points
 * Simplified interface for common use cases
 */
export const getOrGenerateRoutePolyline = async ({
  driverId,
  deliveryDate,
  startPoint, // { lat, lon }
  endPoint, // { lat, lon }
  routeType = 'to_next_stop',
  googleApiKey,
  forceRefresh = false
}) => {
  try {
    if (!startPoint?.lat || !startPoint?.lon || !endPoint?.lat || !endPoint?.lon) {
      console.log('⚠️ [RoutePolyline] Invalid start or end point');
      return null;
    }

    // Check for existing polyline if not forcing refresh
    if (!forceRefresh) {
      const existingPolyline = await getStoredPolyline(
        driverId,
        deliveryDate,
        routeType,
        startPoint.lat,
        startPoint.lon,
        endPoint.lat,
        endPoint.lon
      );

      if (existingPolyline && isPolylineFresh(existingPolyline)) {
        console.log('✅ [RoutePolyline] Using cached polyline');
        return decodePolyline(existingPolyline.encoded_polyline);
      }
    }

    // Generate new polyline
    console.log('🌐 [RoutePolyline] Generating new route polyline...');
    const routeData = await fetchGoogleDirections(
      startPoint.lat,
      startPoint.lon,
      endPoint.lat,
      endPoint.lon,
      googleApiKey
    );

    if (!routeData || !routeData.encoded_polyline) {
      console.log('❌ [RoutePolyline] Failed to fetch route');
      return null;
    }

    // Save the new polyline
    await savePolyline({
      driverId,
      deliveryDate,
      routeType,
      startLat: startPoint.lat,
      startLon: startPoint.lon,
      endLat: endPoint.lat,
      endLon: endPoint.lon,
      encodedPolyline: routeData.encoded_polyline,
      estimatedDistanceKm: routeData.distance_km,
      estimatedDurationSeconds: routeData.duration_seconds
    });

    console.log('✅ [RoutePolyline] New polyline generated and saved');
    return decodePolyline(routeData.encoded_polyline);

  } catch (error) {
    console.error('[getOrGenerateRoutePolyline] Error:', error);
    return null;
  }
};

export default {
  getCurrentToNextStopPolyline,
  getStoredRouteCoordinates,
  getOrGenerateRoutePolyline,
  decodePolyline
};