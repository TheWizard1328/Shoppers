// routePolylineManager.js - Manages route polylines (HERE only) and polyline storage

import { base44 } from "@/api/base44Client";
import { format } from "date-fns";
import { queueEntityRequest } from "./requestQueue";
import { offlineDB } from "./offlineDatabase";

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

const findLatestExactStoredSegment = (rows, startLat, startLon, endLat, endLon) => {
  const originLat = Number(startLat.toFixed(5));
  const originLon = Number(startLon.toFixed(5));
  const destLat = Number(endLat.toFixed(5));
  const destLon = Number(endLon.toFixed(5));

  return (rows || [])
    .filter((row) => row?.encoded_polyline &&
      Number(row.segment_origin_lat)?.toFixed(5) === originLat.toFixed(5) &&
      Number(row.segment_origin_lon)?.toFixed(5) === originLon.toFixed(5) &&
      Number(row.segment_dest_lat)?.toFixed(5) === destLat.toFixed(5) &&
      Number(row.segment_dest_lon)?.toFixed(5) === destLon.toFixed(5)
    )
    .sort((a, b) => new Date(b.last_generated_at || b.updated_date || 0).getTime() - new Date(a.last_generated_at || a.updated_date || 0).getTime())[0] || null;
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
 * Fetches route from HERE (backend)
 * 
 * @param {number} startLat
 * @param {number} startLon
 * @param {number} endLat
 * @param {number} endLon
 * @param {string} googleApiKey - Google Maps API key
 * @returns {Promise<Object>} Route data with encoded polyline
 */
const fetchGoogleDirections = async (startLat, startLon, endLat, endLon, googleApiKey) => {
  console.log('🗺️ [RoutePolyline] Fetching route from HERE via backend:', {
    origin: `${startLat.toFixed(6)},${startLon.toFixed(6)}`,
    destination: `${endLat.toFixed(6)},${endLon.toFixed(6)}`
  });

  try {
    const response = await base44.functions.invoke('getHereDirections', {
      origin: { lat: startLat, lng: startLon },
      destination: { lat: endLat, lng: endLon }
    });

    if (!response.data) {
      throw new Error('No data returned from backend function');
    }

    const coords = Array.isArray(response.data.coordinates) ? response.data.coordinates : [];
    if (!coords.length) {
      throw new Error('No coordinates returned from HERE');
    }

    // Inline Google polyline encoder to store a compact string (no Google APIs used)
    const encodeSigned = (value) => {
      let sgn = value << 1;
      if (value < 0) sgn = ~sgn;
      let encoded = '';
      while (sgn >= 0x20) {
        encoded += String.fromCharCode((0x20 | (sgn & 0x1f)) + 63);
        sgn >>= 5;
      }
      encoded += String.fromCharCode(sgn + 63);
      return encoded;
    };
    const encodePolyline = (points) => {
      let lastLat = 0, lastLng = 0;
      let out = '';
      for (const [lat, lng] of points) {
        const latE5 = Math.round(lat * 1e5);
        const lngE5 = Math.round(lng * 1e5);
        out += encodeSigned(latE5 - lastLat);
        out += encodeSigned(lngE5 - lastLng);
        lastLat = latE5; lastLng = lngE5;
      }
      return out;
    };

    const normalized = coords.map(p => [p.lat ?? p.latitude, p.lng ?? p.longitude]);
    const encoded = encodePolyline(normalized);

    return {
      encoded_polyline: encoded,
      distance_km: response.data.estimated_distance_km,
      duration_seconds: (response.data.estimated_duration_minutes || 0) * 60
    };
  } catch (error) {
    console.error('❌ [RoutePolyline] Error fetching HERE route:', error);
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
    const offlineRows = await offlineDB.getAll(offlineDB.STORES.DRIVER_ROUTE_POLYLINES);
    const offlineMatch = findLatestExactStoredSegment(offlineRows, startLat, startLon, endLat, endLon);
    if (offlineMatch) return offlineMatch;

    const rounded = (n) => Number(n.toFixed(5));
    const recs = await base44.entities.DriverRoutePolyline.filter({
      driver_id: driverId,
      delivery_date,
      segment_origin_lat: rounded(startLat),
      segment_origin_lon: rounded(startLon),
      segment_dest_lat: rounded(endLat),
      segment_dest_lon: rounded(endLon)
    }, '-updated_date', 1);
    const rec = Array.isArray(recs) ? recs[0] : null;
    if (rec) {
      await offlineDB.bulkSave(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, [rec]);
    }
    return rec || null;
  } catch (e) {
    console.log('⏭️ [RoutePolyline] getStoredPolyline lookup failed', e?.message || e);
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
  try {
    const rounded = (n) => Number(n.toFixed(5));
    const exists = await base44.entities.DriverRoutePolyline.filter({
      driver_id: driverId,
      delivery_date,
      segment_origin_lat: rounded(startLat),
      segment_origin_lon: rounded(startLon),
      segment_dest_lat: rounded(endLat),
      segment_dest_lon: rounded(endLon)
    }, '-updated_date', 1);

    const payload = {
      driver_id: driverId,
      delivery_date: deliveryDate,
      encoded_polyline: encodedPolyline,
      segment_origin_lat: rounded(startLat),
      segment_origin_lon: rounded(startLon),
      segment_dest_lat: rounded(endLat),
      segment_dest_lon: rounded(endLon),
      estimated_distance_km: estimatedDistanceKm,
      estimated_duration_minutes: Math.round((estimatedDurationSeconds || 0) / 60),
      last_generated_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + POLYLINE_CONFIG.EXPIRY_MINUTES * 60000).toISOString()
    };

    let savedRecord = null;

    if (Array.isArray(exists) && exists.length) {
      savedRecord = await base44.entities.DriverRoutePolyline.update(exists[0].id, payload);
    } else {
      savedRecord = await base44.entities.DriverRoutePolyline.create(payload);
    }

    if (savedRecord) {
      await offlineDB.bulkSave(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, [savedRecord]);
    }
  } catch (e) {
    console.log('⏭️ [RoutePolyline] savePolyline failed', e?.message || e);
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
        existingPolyline.segment_origin_lat,
        existingPolyline.segment_origin_lon,
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
    const offlineRows = await offlineDB.getByIndex(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, 'delivery_date', deliveryDate);
    const offlineMatch = (offlineRows || [])
      .filter((row) => row?.driver_id === driverId && row?.encoded_polyline)
      .sort((a, b) => new Date(b.last_generated_at || b.updated_date || 0).getTime() - new Date(a.last_generated_at || a.updated_date || 0).getTime())[0] || null;

    if (offlineMatch?.encoded_polyline) {
      return decodePolyline(offlineMatch.encoded_polyline).map((p) => ({ lat: p.lat, lng: p.lng }));
    }

    const recs = await base44.entities.DriverRoutePolyline.filter({ driver_id: driverId, delivery_date: deliveryDate }, '-updated_date', 20);
    if (!Array.isArray(recs) || !recs.length) return null;

    await offlineDB.bulkSave(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, recs);

    const rec = recs[0];
    if (!rec?.encoded_polyline) return null;
    return decodePolyline(rec.encoded_polyline).map((p) => ({ lat: p.lat, lng: p.lng }));
  } catch (e) {
    console.log('⏭️ [RoutePolyline] getStoredRouteCoordinates failed', e?.message || e);
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