/**
 * Calculate distance between two coordinates using Haversine formula
 * Returns distance in meters
 */
// Consolidated into geoUtils — identical math, single source of truth.
import { haversineMeters } from './geoUtils';
export const calculateHaversineDistance = (lat1, lon1, lat2, lon2) => haversineMeters(lat1, lon1, lat2, lon2);