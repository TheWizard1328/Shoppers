/**
 * Dynamic Polyline Manager
 * Fetches and manages polylines between route segments based on current route state
 */

const getStopCoords = (stop, patients = [], stores = []) => {
  if (!stop) return null;
  if (stop.patient_id) {
    const patient = patients.find((p) => p && p.id === stop.patient_id);
    if (patient?.latitude && patient?.longitude) {
      return { lat: Number(patient.latitude), lon: Number(patient.longitude) };
    }
  }
  const store = stores.find((s) => s && s.id === stop.store_id);
  if (store?.latitude && store?.longitude) {
    return { lat: Number(store.latitude), lon: Number(store.longitude) };
  }
  return null;
};

const decodeGooglePolyline = (encoded) => {
  if (!encoded || typeof encoded !== 'string') return [];
  let index = 0, lat = 0, lng = 0;
  const coordinates = [];
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coordinates.push([lat / 1e5, lng / 1e5]);
  }
  return coordinates;
};

import { base44 } from '@/api/base44Client';
import { format } from 'date-fns';
import { normalizeTravelMode } from '@/components/dashboard/travelModeHelpers';

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

  if (incompleteDeliveries.length === 0 && completedDeliveries.length > 0) {
    const lastCompleted = completedDeliveries[completedDeliveries.length - 1];
    const lastCoords = getStopCoords(lastCompleted, patients, stores);
    if (!lastCoords || !driver?.home_latitude || !driver?.home_longitude) return null;
    return {
      originLat: lastCoords.lat,
      originLon: lastCoords.lon,
      destLat: Number(driver.home_latitude),
      destLon: Number(driver.home_longitude),
      segmentType: 'last_to_home',
      routePoints: [
        { lat: lastCoords.lat, lon: lastCoords.lon },
        { lat: Number(driver.home_latitude), lon: Number(driver.home_longitude) }
      ]
    };
  }

  if (incompleteDeliveries.length > 0) {
    const nextStop = incompleteDeliveries[0];
    const nextCoords = getStopCoords(nextStop, patients, stores);
    if (!nextCoords) return null;

    const lastCompleted = completedDeliveries.length > 0 ? completedDeliveries[completedDeliveries.length - 1] : null;
    const lastCompletedCoords = getStopCoords(lastCompleted, patients, stores);
    const homeCoords = driver?.home_latitude && driver?.home_longitude
      ? { lat: Number(driver.home_latitude), lon: Number(driver.home_longitude) }
      : null;

    const routePoints = [
      ...(lastCompletedCoords ? [lastCompletedCoords] : homeCoords ? [homeCoords] : []),
      ...incompleteDeliveries.map((stop) => getStopCoords(stop, patients, stores)).filter(Boolean)
    ];

    if (routePoints.length < 2) return null;

    return {
      originLat: routePoints[0].lat,
      originLon: routePoints[0].lon,
      destLat: routePoints[1].lat,
      destLon: routePoints[1].lon,
      segmentType: lastCompletedCoords ? 'type1_with_type2' : 'home_to_type1_with_type2',
      routePoints
    };
  }

  return null;
};

export const fetchPolylineForSegment = async (originLat, originLon, destLat, destLon, options = {}) => {
  const routePoints = Array.isArray(options.routePoints) ? options.routePoints.filter(Boolean) : [];
  const transportMode = normalizeTravelMode(options.transportMode || 'driving');

  try {
    if (routePoints.length < 2) return null;

    const response = await base44.functions.invoke('getHereDirections', {
      origin: { lat: Number(routePoints[0].lat), lng: Number(routePoints[0].lon) },
      destination: { lat: Number(routePoints[routePoints.length - 1].lat), lng: Number(routePoints[routePoints.length - 1].lon) },
      waypoints: routePoints.slice(1, -1).map((point) => ({ lat: Number(point.lat), lng: Number(point.lon) })),
      routeContext: routePoints.map((point) => ({ lat: Number(point.lat), lng: Number(point.lon) })),
      transportMode
    });

    const polylines = response?.data?.polylines;
    if (!Array.isArray(polylines) || polylines.length === 0) return null;

    const merged = polylines.flatMap((encoded, index) => {
      const coords = decodeGooglePolyline(encoded);
      if (!Array.isArray(coords) || coords.length === 0) return [];
      return index === 0 ? coords : coords.slice(1);
    });

    return merged.length > 1 ? merged : null;
  } catch (error) {
    console.error('❌ [DynamicPolylineManager] Failed to fetch HERE polyline:', error);
    return null;
  }
};