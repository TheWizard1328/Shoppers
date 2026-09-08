import { haversineMeters } from './geoUtils';
// Consolidated into geoUtils (Sep 6 2026) — METERS (previous semantics).
export const calculateDistance = (lat1, lon1, lat2, lon2) => haversineMeters(lat1, lon1, lat2, lon2);

// Consolidated into geoUtils — identical math, single source of truth.
export const calculateDistanceInMeters = (lat1, lon1, lat2, lon2) => haversineMeters(lat1, lon1, lat2, lon2);