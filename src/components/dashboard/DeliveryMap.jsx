import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMapEvents, Circle } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { getStoreColor, hexToRgba } from '../utils/colorGenerator';
import { sortUsers } from '../utils/sorting';
import MapModeControl from "./MapModeControl";
import { MapPin, Phone, Clock, Package, Truck, StickyNote, UserRoundSearch, Car, Home, Navigation, Activity } from 'lucide-react';
import { userHasRole, isAppOwner } from '../utils/userRoles';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { format } from 'date-fns';
import { createRoot } from 'react-dom/client';
import { getStoredRouteCoordinates } from '../utils/routePolylineManager';
import { isMobileDevice } from '../utils/deviceUtils';
import MapCrosshair from './MapCrosshair';

// Fix for default icon issue with Webpack
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png'
});

// Driver color palette for "All Drivers" mode - 6 highly visible, contrasting colors
const DRIVER_COLORS = [
  '', // Blank color storage for unused 0 index - will be handled by getDriverColor fallback
  '#F012BE', // Hot Pink (Index 1)
  '#D946EF', // Bright Magenta (Index 2) - needs black text
  '#7FDBFF', // Electric Cyan (Index 3)
  '#0074D9', // Deep Blue (Index 4)
  '#B10DC9', // Royal Purple (Index 5)
  '#001F3F'  // Navy Blue (Index 6)
];

// Helper function to determine text color for driver colors
const getDriverTextColor = (driverColor) => {
  // Electric Cyan needs black text for readability
  if (driverColor === '#7FDBFF') return 'black';
  return 'white';
};

// NEW: Zoom level thresholds for dynamic display
const ZOOM_LEVELS = {
  HIDE_ROUTES: 10, // Below this, hide routes completely
  SIMPLIFY_ROUTES: 12, // Below this, simplify route lines
  HIDE_NUMBERS: 11, // Below this, hide stop numbers
  HIDE_CIRCLES: 11, // Below this, hide pickup circles
  FULL_DETAIL: 13 // At or above this, show full detail
};

// Shared finished statuses array
const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];

// NEW: Simple circle marker for dispatcher view (other stores)
// CRITICAL: Memoized icon cache to prevent re-creation on every render
const simpleCircleIconCache = new Map();

const createSimpleCircleIcon = (status, number, zoomLevel, isMobile = false, borderColor = 'white', isOtherDriver = false) => {
  // Use caching to prevent icon re-creation causing pulsation
  const cacheKey = `${status}_${number}_${zoomLevel}_${isMobile}_${borderColor}_${isOtherDriver}`;
  
  if (simpleCircleIconCache.has(cacheKey)) {
    return simpleCircleIconCache.get(cacheKey);
  }
  
  const statusColors = {
    'pending': '#3B82F6', // Blue
    'Ready For Pickup': '#3B82F6', // Blue
    'in_transit': '#3B82F6', // Blue
    'en_route': '#3B82F6', // Blue
    'completed': '#10B981', // Green
    'delivered': '#10B981', // Green
    'failed': '#EF4444', // Red
    'cancelled': '#EF4444', // Red
    'returned': '#F97316' // Orange
  };

  const statusColor = statusColors[status] || '#94A3B8';
  const driverColor = borderColor; // This is the driver/pin color passed in (background of circle)

  // CRITICAL: Match exact sizing from regular markers
  let baseSize = 24 * 0.75;
  if (zoomLevel >= ZOOM_LEVELS.FULL_DETAIL) {
    baseSize = 28 * 0.75;
  } else if (zoomLevel < ZOOM_LEVELS.SIMPLIFY_ROUTES) {
    baseSize = 20 * 0.75;
  }
  
  // Reduce size for pending status
  if (status === 'pending') {
    baseSize *= 0.75;
  }
  
  // NEW: Reduce size further for other drivers' faded markers
  if (isOtherDriver) {
    baseSize *= 0.75;
  }
  
  if (isMobile) {
    baseSize *= 1.25;
  }

  // Match font size calculation from regular markers (for numbers inside circles)
  const fontSize = 7; // Reduced from 9.5 for smaller circles
  
  // CRITICAL: Determine text color based on the background (driver) color
  // driverColor is the background color of the circle
  const textColor = getDriverTextColor(driverColor);

  const icon = L.divIcon({
    html: `
      <div class="simple-circle-marker" style="
        width: ${baseSize}px;
        height: ${baseSize}px;
        background-color: ${driverColor};
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        padding-top: 1px;
        font-size: ${fontSize}px;
        font-weight: bold;
        color: ${textColor};
        box-shadow: 0 2px 5px rgba(0,0,0,0.3);
        border: 2px solid ${statusColor};
        opacity: ${isOtherDriver ? 0.75 : 1};
      ">
        ${number || ''}
      </div>
    `,
    className: 'custom-simple-circle-icon',
    iconSize: [baseSize, baseSize],
    iconAnchor: [baseSize / 2, baseSize / 2]
  });
  
  // Cache the icon to prevent re-creation
  simpleCircleIconCache.set(cacheKey, icon);
  
  return icon;
};

// Generate consistent driver color based on driver's sort_order
// EXPORT this function so it can be imported by Dashboard.jsx
export const getDriverColor = (driver) => {
  // ENHANCED SAFETY: Check for null/undefined AND valid object type
  if (!driver || typeof driver !== 'object') {
    console.warn('[DeliveryMap] getDriverColor: Invalid driver:', driver);
    return '#607D8B'; // Default blue-grey for invalid
  }

  let index;
  if (driver.sort_order === undefined || driver.sort_order === null) {
    // Fallback to hashing the ID if sort_order is missing
    if (driver.id) {
      let hash = 0;
      const id = driver.id.toString();
      for (let i = 0; i < id.length; i++) {
        hash = id.charCodeAt(i) + ((hash << 5) - hash);
      }
      index = Math.abs(hash) % DRIVER_COLORS.length;
    } else {
      return '#607D8B'; // Default blue-grey for unassigned/unknown
    }
  } else {
    // Use sort_order with modulo to ensure index is within bounds
    index = Math.abs(driver.sort_order) % DRIVER_COLORS.length;
  }

  // Ensure the color is not an empty string if index 0 was hit
  let color = DRIVER_COLORS[index];
  if (!color || color === '') {
    // Fallback to a default color, or the first valid color in the list
    // DRIVER_COLORS[1] is '#2196F3', which is a good default blue
    color = DRIVER_COLORS[1] || '#607D8B';
  }

  return color;
};

// Helper function to get inner symbol color based on status
const getInnerSymbolColor = (status, isPickup = false) => {
  if (isPickup) {
    // Store pickup markers
    if (status === 'completed') return '#10B981'; // Green
    if (status === 'Ready For Pickup') return '#3B82F6'; // Blue
    if (status === 'pending') return '#94A3B8'; // Gray
    if (status === 'cancelled') return '#EF4444'; // Red
    return '#FFFFFF'; // White (in_transit)
  } else {
    // Patient delivery markers
    if (status === 'completed' || status === 'delivered') return '#10B981'; // Green
    if (status === 'failed' || status === 'cancelled') return '#EF4444'; // Red
    if (status === 'returned') return '#F97316'; // Orange
    if (status === 'Ready For Pickup') return '#3B82F6'; // Blue
    if (status === 'pending') return '#94A3B8'; // Gray
    return '#FFFFFF'; // White (in_transit)
  }
};

// Helper function to check if a delivery is a first-time delivery
const isFirstTimeDelivery = (delivery) => {
  // Simply return the first_delivery flag from the database
  return delivery.first_delivery || false;
};

// Helper function to get contrast color for text on a given background
const getContrastColor = (backgroundColor) => {
  // Convert hex to RGB
  const hex = backgroundColor.replace('#', '');
  const r = parseInt(hex.substr(0, 2), 16);
  const g = parseInt(hex.substr(2, 2), 16);
  const b = parseInt(hex.substr(4, 2), 16);

  // Calculate luminance
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

  // Return black or white based on luminance
  return luminance > 0.5 ? '#000000' : '#FFFFFF';
};

// MODIFIED: Create icons with zoom-aware sizing - REMOVED duplicateCount badge
const createStoreIcon = (status, storeColor = '#6B7280', isActive = false, number = null, zoomLevel = 12, duplicateCount = 0, isMobile = false, isHighlighted = false, isNextDelivery = false, hasIncompleteStops = true, isOtherDriver = false) => {
  // CRITICAL: Failed/cancelled/completed takes precedence over next delivery blue
  const isFinished = FINISHED_STATUSES.includes(status);
  const shouldShowNextBlue = isNextDelivery && !isFinished && hasIncompleteStops;
  
  const innerColor = shouldShowNextBlue ? '#3B82F6' : getInnerSymbolColor(status, true);
  const showNumber = zoomLevel >= ZOOM_LEVELS.HIDE_NUMBERS && number;
  const hasDuplicates = duplicateCount > 1;

  // Dynamic sizing based on zoom
  let baseSize = 24 * 0.75;
  if (zoomLevel >= ZOOM_LEVELS.FULL_DETAIL) {
    baseSize = 28 * 0.75;
  } else if (zoomLevel < ZOOM_LEVELS.SIMPLIFY_ROUTES) {
    baseSize = 20 * 0.75;
  }
  
  // Reduce size for pending status
  if (status === 'pending') {
    baseSize *= 0.75;
  }
  
  // NEW: Reduce size further for other drivers' faded markers
  if (isOtherDriver) {
    baseSize *= 0.75;
  }

  // Increase size for mobile devices
  if (isMobile) {
    baseSize *= 1.25;
  }
  
  // REMOVED: Don't enlarge markers when highlighted
  let size = isActive ? baseSize * 1.15 : baseSize;
  
  const numberColor = (status === 'failed' || status === 'cancelled') ? 'white' : (FINISHED_STATUSES.includes(status) ? 'black' : getContrastColor(storeColor));

  return L.divIcon({
    html: `
      <div class="store-marker ${isHighlighted ? 'highlighted' : ''}" style="
        width: ${size}px;
        height: ${size * 1.4}px;
        position: relative;
        cursor: pointer;
        opacity: ${isOtherDriver ? 0.75 : 1};
      ">
        <svg width="${size}" height="${size * 1.4}" viewBox="0 0 24 34" xmlns="http://www.w3.org/2000/svg">
          <!-- Pin shape - rounder, more compact -->
          <path d="M12 0C5.373 0 0 5.373 0 12c0 9 12 22 12 22s12-13 12-22C24 5.373 18.627 0 12 0z" 
                fill="${storeColor}" 
                stroke="#FFFFFF" 
                stroke-width="1.2"
                style="filter: drop-shadow(0 2px 3px rgba(0,0,0,0.3));" />
          
          <!-- Plus symbol - larger and more pronounced -->
          <g transform="translate(12, 9)">
            <!-- Vertical bar - thicker and taller -->
            <rect x="-2" y="-7" width="4" height="14" fill="${innerColor}" rx="1.5" />
            <!-- Horizontal bar - thicker and wider -->
            <rect x="-7" y="-2" width="14" height="4" fill="${innerColor}" rx="1.5" />
          </g>
          
          ${showNumber ? `
            <!-- Stop number below the cross with contrasting color -->
            <text x="12" y="24" 
                  font-family="Arial, sans-serif" 
                  font-size="9.5" 
                  font-weight="bold" 
                  fill="white"
                  text-anchor="middle">${number}</text>
          ` : ''}
        </svg>
        
        ${hasDuplicates && zoomLevel >= ZOOM_LEVELS.HIDE_NUMBERS ? `
          <!-- Red duplicate badge - offset up and to the right -->
          <div style="
            position: absolute;
            top: -2.5px;
            right: -3px;
            background: #EF4444;
            border: 1px solid white;
            border-radius: 50%;
            width: 12px;
            height: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 7px;
            font-weight: bold;
            color: white;
            box-shadow: 0 1px 3px rgba(0,0,0,0.3);
            z-index: 10;
          ">${duplicateCount}</div>
        ` : ''}
      </div>
      <style>
        .store-marker {
          transition: transform 0.15s ease-out;
          will-change: transform;
        }
        .store-marker:hover {
          z-index: 9999 !important;
          transform: scale(1.15);
        }
        .leaflet-marker-icon:has(.store-marker:hover) {
          z-index: 9999 !important;
        }
      </style>
    `,
    className: 'custom-store-icon',
    iconSize: [size, size * 1.4],
    iconAnchor: [size / 2, size * 1.4]
  });
};

// Helper function to create delivery pin markers with circle/square based on PM status
const createDeliveryIcon = (status, storeColor = '#6B7280', isActive = false, number = null, isFirstTime = false, duplicateCount = 0, zoomLevel = 12, isMobile = false, isNextInLine = false, isHighlighted = false, hasIncompleteStops = true, isPM = false, isOtherDriver = false) => {
  // CRITICAL: Failed/cancelled/completed takes precedence over next delivery blue
  const isFinished = FINISHED_STATUSES.includes(status);
  const shouldShowNextBlue = isNextInLine && !isFinished && hasIncompleteStops;
  const isPending = status === 'pending';
  
  const statusColor = shouldShowNextBlue ? '#3B82F6' : getInnerSymbolColor(status, false);
  const hasYellowHalo = isFirstTime && zoomLevel >= ZOOM_LEVELS.SIMPLIFY_ROUTES;
  const hasDuplicates = duplicateCount > 1;
  const showNumber = zoomLevel >= ZOOM_LEVELS.HIDE_NUMBERS && number;

  // Dynamic sizing based on zoom
  let baseSize = 24 * 0.75;
  if (zoomLevel >= ZOOM_LEVELS.FULL_DETAIL) {
    baseSize = 28 * 0.75;
  } else if (zoomLevel < ZOOM_LEVELS.SIMPLIFY_ROUTES) {
    baseSize = 20 * 0.75;
  }
  
  // Reduce size for pending status
  if (status === 'pending') {
    baseSize *= 0.75;
  }

  // NEW: Reduce size further for other drivers' faded markers
  if (isOtherDriver) {
    baseSize *= 0.75;
  }
  
  // Increase size for mobile devices
  if (isMobile) {
    baseSize *= 1.25;
  }
  
  // Keep size consistent - no enlargement on highlight
  const size = isActive ? baseSize * 1.15 : baseSize;
  
  const numberColor = shouldShowNextBlue ? '#FFFFFF' : ((status === 'failed' || status === 'cancelled') ? 'white' : (FINISHED_STATUSES.includes(status) ? 'black' : getContrastColor(statusColor)));

  return L.divIcon({
    html: `
      <div class="delivery-marker ${isHighlighted ? 'highlighted' : ''}" style="
        width: ${size}px;
        height: ${size * 1.4}px;
        position: relative;
        cursor: pointer;
        opacity: ${isOtherDriver ? 0.75 : 1};
      ">
        <svg width="${size}" height="${size * 1.4}" viewBox="0 0 24 34" xmlns="http://www.w3.org/2000/svg">
          <!-- Pin shape with STORE COLOR - rounder, more compact -->
          <path d="M12 0C5.373 0 0 5.373 0 12c0 9 12 22 12 22s12-13 12-22C24 5.373 18.627 0 12 0z" 
                fill="${storeColor}" 
                stroke="#FFFFFF" 
                stroke-width="1.2"
                style="filter: drop-shadow(0 2px 3px rgba(0,0,0,0.3));" />
          
          ${hasYellowHalo ? (isPM ? `
            <!-- Yellow SQUARE halo for PM new/first time deliveries -->
            <rect x="4.5" y="4.5" width="15" height="15" 
                  fill="none" 
                  stroke="#FBBF24" 
                  stroke-width="5.5" 
                  opacity="1" />
          ` : `
            <!-- Yellow halo for new/first time deliveries - wider and brighter -->
            <circle cx="12" cy="12" r="7.5" 
                    fill="none" 
                    stroke="#FBBF24" 
                    stroke-width="5.5" 
                    opacity="1" />
          `) : ''}
          
          ${(isPM && !isPending) || (isPM && isPending) ? `
            <!-- Inner STATUS SQUARE for PM deliveries (including pending PM) -->
            <rect x="4" y="4" width="16" height="16" 
                  fill="${statusColor}" 
                  stroke="${storeColor}" 
                  stroke-width="1.2" />
          ` : `
            <!-- Inner STATUS circle - larger -->
            <circle cx="12" cy="12" r="8" 
                    fill="${statusColor}" 
                    stroke="${storeColor}" 
                    stroke-width="1.2" />
          `}
          
          ${showNumber ? `
            <!-- Stop number with contrasting color -->
            <text x="12" y="15.5" 
                  font-family="Arial, sans-serif" 
                  font-size="9.5" 
                  font-weight="bold" 
                  fill="${numberColor}" 
                  text-anchor="middle">${number}</text>
          ` : ''}
        </svg>
        
        ${hasDuplicates && zoomLevel >= ZOOM_LEVELS.HIDE_NUMBERS ? `
          <!-- Red duplicate badge - offset up and to the right -->
          <div style="
            position: absolute;
            top: -2.5px;
            right: -3px;
            background: #EF4444;
            border: 1px solid white;
            border-radius: 50%;
            width: 12px;
            height: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 7px;
            font-weight: bold;
            color: white;
            box-shadow: 0 1px 3px rgba(0,0,0,0.3);
            z-index: 10;
          ">${duplicateCount}</div>
        ` : ''}
      </div>
      <style>
        .delivery-marker {
          transition: transform 0.15s ease-out;
          will-change: transform;
        }
        .delivery-marker:hover {
          z-index: 9999 !important;
          transform: scale(1.15);
        }
        .leaflet-marker-icon:has(.delivery-marker:hover) {
          z-index: 9999 !important;
        }
      </style>
    `,
    className: 'custom-delivery-icon',
    iconSize: [size, size * 1.4],
    iconAnchor: [size / 2, size * 1.4]
  });
};

const createDriverIcon = (driverStatus = 'on_duty', initial = '', isStaleLocation = false, isOnBreakSelf = false) => {
  const size = 15; // Reduced by 50% from 30 to 15
  
  // Green for on_duty, Orange for on_break, Grey for off_duty
  const statusColors = {
    'on_duty': '#10B981', // Green
    'on_break': '#F97316', // Orange
    'off_duty': '#6B7280' // Grey
  };
  const color = statusColors[driverStatus] || statusColors['on_duty'];
  
  // CRITICAL: Blue ring for viewing own location while on break (from other device)
  // Orange ring for stale location, White ring for fresh location
  let outerRingColor = 'white';
  let outerRingWidth = 2;
  
  if (isOnBreakSelf) {
    outerRingColor = '#3B82F6'; // Blue for on_break self
    outerRingWidth = 3;
  } else if (isStaleLocation) {
    outerRingColor = '#F97316'; // Orange for stale
    outerRingWidth = 3;
  }
  
  return L.divIcon({
    html: `
      <div class="driver-marker" style="
        position: relative;
        width: ${size}px;
        height: ${size}px;
      ">
        <div style="
          background-color: ${color};
          border: ${outerRingWidth}px solid ${outerRingColor};
          border-radius: 50%;
          width: ${size}px;
          height: ${size}px;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 3px 10px rgba(0,0,0,0.4);
          animation: driverPulse 2s infinite;
          cursor: pointer;
          transition: transform 0.2s ease, box-shadow 0.2s ease;
        ">
          <span style="
            font-size: 8px;
            font-weight: bold;
            color: white;
            text-transform: uppercase;
          ">${initial || 'D'}</span>
        </div>
      </div>
      <style>
        @keyframes driverPulse {
          0%, 100% { transform: scale(1); box-shadow: 0 3px 10px rgba(0,0,0,0.4); }
          50% { transform: scale(1.15); box-shadow: 0 3px 15px rgba(0,0,0,0.5); }
        }
        .driver-marker:hover {
          z-index: 9999 !important;
        }
        .driver-marker:hover > div {
          transform: scale(1.2);
          box-shadow: 0 5px 20px rgba(0,0,0,0.6) !important;
        }
        .leaflet-marker-icon:has(.driver-marker:hover) {
          z-index: 9999 !important;
        }
      </style>
    `,
    className: 'custom-driver-icon',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  });
};

// UPDATED: Create a blue dot with LOWER z-index for better touch hierarchy
const createLiveLocationDot = () => {
  const size = 16;

  return L.divIcon({
    html: `
      <div class="live-location-dot" style="
        width: ${size}px;
        height: ${size}px;
        position: relative;
        cursor: pointer;
        z-index: 100 !important;
      ">
        <!-- Outer pulse ring -->
        <div style="
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: ${size * 2}px;
          height: ${size * 2}px;
          background: rgba(59, 130, 246, 0.2);
          border-radius: 50%;
          animation: locationPulse 2s infinite;
        "></div>
        
        <!-- Inner blue dot -->
        <div style="
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: ${size}px;
          height: ${size}px;
          background: #3B82F6;
          border: 3px solid white;
          border-radius: 50%;
          box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        "></div>
      </div>
      <style>
        @keyframes locationPulse {
          0%, 100% { 
            transform: translate(-50%, -50%) scale(1); 
            opacity: 0.6;
          }
          50% { 
            transform: translate(-50%, -50%) scale(1.3); 
            opacity: 0.2;
          }
        }
        .live-location-dot {
          z-index: 100 !important;
          pointer-events: auto;
          transition: transform 0.2s ease;
        }
        .live-location-dot:hover {
          transform: scale(1.15);
        }
      </style>
    `,
    className: 'custom-live-location-icon',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    zIndexOffset: -1000 // CRITICAL: Lower z-index so delivery markers take priority
  });
};

// NEW: Create home location icon with teardrop shape and house icon
const createHomeIcon = (color = '#10B981') => {
  const size = 24 * 0.75; // Same size as other markers

  return L.divIcon({
    html: `
      <div class="home-marker" style="
        width: ${size}px;
        height: ${size * 1.4}px;
        position: relative;
        cursor: pointer;
      ">
        <svg width="${size}" height="${size * 1.4}" viewBox="0 0 24 34" xmlns="http://www.w3.org/2000/svg">
          <!-- Teardrop shape with driver color -->
          <path d="M12 0C5.373 0 0 5.373 0 12c0 9 12 22 12 22s12-13 12-22C24 5.373 18.627 0 12 0z" 
                fill="${color}" 
                stroke="#FFFFFF" 
                stroke-width="1.2"
                style="filter: drop-shadow(0 2px 3px rgba(0,0,0,0.3));" />
          
          <!-- House icon in white -->
          <g transform="translate(12, 12)">
            <!-- Roof -->
            <path d="M-5,-3 L0,-7 L5,-3 Z" 
                  fill="white" 
                  stroke="white" 
                  stroke-width="0.5" 
                  stroke-linejoin="round" />
            <!-- House body -->
            <rect x="-4" y="-3" width="8" height="6" 
                  fill="white" 
                  stroke="white" 
                  stroke-width="0.5" />
            <!-- Door -->
            <rect x="-1.5" y="0" width="3" height="3" 
                  fill="${color}" 
                  stroke="${color}" 
                  stroke-width="0.3" />
          </g>
        </svg>
      </div>
      <style>
        .home-marker {
          transition: transform 0.2s ease;
        }
        .home-marker:hover {
          z-index: 9999 !important;
          transform: scale(1.15);
        }
        .leaflet-marker-icon:has(.home-marker:hover) {
          z-index: 9999 !important;
        }
      </style>
    `,
    className: 'custom-home-icon',
    iconSize: [size, size * 1.4],
    iconAnchor: [size / 2, size * 1.4]
  });
};

export default function DeliveryMap({
  deliveries = [],
  allDeliveriesForDate = [], // NEW PROP: All deliveries for the selected date, regardless of driver
  selectedDriverId = null, // NEW PROP: The ID of the currently selected driver for filtering
  selectedDate = null, // NEW PROP: The selected date (yyyy-MM-dd)
  patients = [],
  stores = [],
  users = [], // This `users` prop is crucial, it contains merged AppUser data
  currentUser,
  driverLocations = [], // Other driver locations - controlled by "Show All" checkbox
  showOtherDriverDeliveries = false, // NEW: Whether to show other drivers' delivery/pickup markers
  currentDriverLocation = null, // NEW: Single driver location for current user
  center = [53.5461, -113.4938],
  zoom = 12,
  shouldFitBounds = null,
  onBoundsFitted = null,
  onMarkerClick,
  mapMode = 'auto-follow',
  onMapModeChange,
  autoFitBounds = true,
  showRoutes = true,
  showLegend = false,
  areCardsVisible = false,
  onLegendInteraction = () => {},
  onMapInteraction = () => {}, // NEW: Callback for any map interaction (zoom, pan, cluster click)
  onDoubleTap = () => {}, // NEW: Callback for double-tap on map
  retractClustersRef, // NEW: Ref to allow parent to retract clusters
  STOP_CARDS_BASE_HEIGHT = 145, // Fixed non-expanded height for map padding
  stopCardsHeight = STOP_CARDS_BASE_HEIGHT + 100, // NEW: Height of the horizontal stop cards for fitBounds padding
  currentToNextPolyline = null, // NEW: Google Maps polyline from current position to next stop
  statsCardPositioning = '', // NEW: CSS classes for stats card positioning
  isStatsCardExpanded = false, // NEW: Whether stats card is expanded
  statsCardRect = null, // NEW: Stats card bounding rect for legend positioning
  highlightedDeliveryId = null, // NEW: ID of delivery to highlight (from card hover/selection)
  areStopCardsVisible = false, // NEW: Whether stop cards are visible
  onDriverRoutesCalculated = () => {}, // NEW: Callback to pass driver routes to parent
  onMapReady = () => {} // NEW: Callback when ALL map elements are rendered
}) {
  const mapRef = useRef(null);
  const [map, setMap] = useState(null);
  const [hoveredMarkerId, setHoveredMarkerId] = useState(null);
  const markerRefs = useRef({});
  const [hasInitialFit, setHasInitialFit] = useState(false);
  const [currentZoom, setCurrentZoom] = useState(zoom);
  const isMobile = useMemo(() => isMobileDevice(), []); // MODIFIED: Use isMobileDevice utility function
  const [googleRouteCoordinates, setGoogleRouteCoordinates] = useState(null);
  const [highlightedRouteId, setHighlightedRouteId] = useState(null);
  const [fannedLocationKey, setFannedLocationKey] = useState(null);
  const legendRef = useRef(null);
  const [legendLeft, setLegendLeft] = useState(null);

  useEffect(() => {
    if (retractClustersRef) {
      retractClustersRef.current = () => setFannedLocationKey(null);
    }
  }, [retractClustersRef]);

  const [showZoomOverlay, setShowZoomOverlay] = useState(false);
  const zoomOverlayTimeoutRef = useRef(null);
  const popupTimeoutRef = useRef(null);
  const [mapCenter, setMapCenter] = useState(center);
  const [visibleBounds, setVisibleBounds] = useState(null);
  const [realtimeAppUsers, setRealtimeAppUsers] = useState(users);

  // Add safety checks for required props - MUST be before useEffect that uses them
  const safeDeliveries = Array.isArray(deliveries) ? deliveries : [];
  const safeAllDeliveriesForDate = Array.isArray(allDeliveriesForDate) ? allDeliveriesForDate : [];
  const safePatients = Array.isArray(patients) ? patients : [];
  const safeStores = Array.isArray(stores) ? stores : [];
  const safeDriverLocations = Array.isArray(driverLocations) ? driverLocations : [];
  const safeUsers = Array.isArray(realtimeAppUsers) ? realtimeAppUsers : [];

  // CRITICAL: Process driverLocations prop into realtimeAppUsers on mount and updates
  useEffect(() => {
    if (safeDriverLocations && safeDriverLocations.length > 0) {
      // Merge driverLocations data into users array (prefer driverLocations for location data)
      const mergedUsers = (users || []).map(user => {
        if (!user) return user;
        const locationData = safeDriverLocations.find(loc => 
          (loc.driver_id || loc.user_id || loc.id) === user.id
        );
        
        if (locationData) {
          return {
            ...user,
            current_latitude: locationData.latitude || locationData.current_latitude || user.current_latitude,
            current_longitude: locationData.longitude || locationData.current_longitude || user.current_longitude,
            location_updated_at: locationData.location_updated_at || user.location_updated_at,
            driver_status: locationData.driver_status || user.driver_status,
            location_tracking_enabled: locationData.location_tracking_enabled ?? user.location_tracking_enabled,
            _isOnBreak: locationData._isOnBreak || false
          };
        }
        
        return user;
      });
      
      // CRITICAL: Only update state if data actually changed
      setRealtimeAppUsers(prev => {
        const prevKey = prev.map(u => `${u?.id}:${u?.current_latitude}:${u?.current_longitude}`).join('|');
        const newKey = mergedUsers.map(u => `${u?.id}:${u?.current_latitude}:${u?.current_longitude}`).join('|');
        return prevKey === newKey ? prev : mergedUsers;
      });
    } else {
      setRealtimeAppUsers(prev => {
        const prevKey = prev.map(u => `${u?.id}:${u?.current_latitude}:${u?.current_longitude}`).join('|');
        const newKey = users.map(u => `${u?.id}:${u?.current_latitude}:${u?.current_longitude}`).join('|');
        return prevKey === newKey ? prev : users;
      });
    }
  }, [users, safeDriverLocations]);

  // State to force re-render of driverRoutes when deliveries update
  const [routeRenderKey, setRouteRenderKey] = useState(0);

  // Listen for real-time driver location updates from SmartRefreshManager
  useEffect(() => {
    const handleDriverLocationUpdate = (event) => {
      const { appUsers } = event.detail;
      if (appUsers && appUsers.length > 0) {
        // CRITICAL: Only update if data actually changed
        setRealtimeAppUsers(prev => {
          const prevKey = prev.map(u => `${u?.id}:${u?.current_latitude}:${u?.current_longitude}`).join('|');
          const newKey = appUsers.map(u => `${u?.id}:${u?.current_latitude}:${u?.current_longitude}`).join('|');
          return prevKey === newKey ? prev : appUsers;
        });
      }
    };

    // NEW: Listen for delivery updates to force complete route recalculation
    const handleDeliveriesUpdate = (event) => {
      console.log('🗺️ [DeliveryMap] Deliveries updated - forcing route line recalculation');
      // CRITICAL: Clear cached routes to force full recalculation
      prevDriverRoutesRef.current = [];
      // Force re-render by incrementing key
      setRouteRenderKey(prev => prev + 1);
    };

    window.addEventListener('driverLocationsUpdated', handleDriverLocationUpdate);
    window.addEventListener('deliveriesUpdated', handleDeliveriesUpdate);
    return () => {
      window.removeEventListener('driverLocationsUpdated', handleDriverLocationUpdate);
      window.removeEventListener('deliveriesUpdated', handleDeliveriesUpdate);
    };
  }, []);

  // CRITICAL: Determine mode BEFORE processing markers - must be defined first
  // Use stable string comparison to prevent unnecessary recalculations
  const isAllDriversMode = useMemo(() => {
    if (!selectedDriverId || selectedDriverId === 'all') return true;
    if (!safeDeliveries || safeDeliveries.length === 0) return false;
    const uniqueDriverIds = new Set(safeDeliveries.map((delivery) => delivery?.driver_id).filter(Boolean));
    return uniqueDriverIds.size > 1;
  }, [selectedDriverId, safeDeliveries.length]);

  // CRITICAL: Use isAllDriversMode calculated above
  const isSingleDriverMode = useMemo(() => !isAllDriversMode, [isAllDriversMode]);

  // CRITICAL: Check if current user is a driver viewing their own route (any date)
  const isDriverViewingSelf = useMemo(() => {
    if (!currentUser || !userHasRole(currentUser, 'driver')) return false;
    if (!selectedDriverId || selectedDriverId === 'all') return false;
    return selectedDriverId === currentUser.id;
  }, [currentUser, selectedDriverId]);

  // Legacy: Keep for backwards compatibility with home route logic (today only)
  const isDriverViewingSelfToday = useMemo(() => {
    if (!isDriverViewingSelf) return false;
    const today = format(new Date(), 'yyyy-MM-dd');
    return selectedDate === today;
  }, [isDriverViewingSelf, selectedDate]);

  const [otherDriverDeliveries, setOtherDriverDeliveries] = useState([]);

  useEffect(() => {
    const fetchOtherDrivers = async () => {
      // CRITICAL: Fetch other drivers for any user with driver role viewing their own route
      const isDriver = currentUser && userHasRole(currentUser, 'driver');
      
      // CRITICAL: Also fetch when showOtherDriverDeliveries is true (checkbox checked)
      if (!isDriver || !isDriverViewingSelf || !selectedDate || !showOtherDriverDeliveries) {
        setOtherDriverDeliveries([]);
        return;
      }

      try {
        const { base44 } = await import('@/api/base44Client');
        const allDeliveries = await base44.entities.Delivery.filter({
          delivery_date: selectedDate
        });
        
        const others = allDeliveries.filter(d => d && d.driver_id && d.driver_id !== currentUser.id);
        setOtherDriverDeliveries(others);
      } catch (error) {
        setOtherDriverDeliveries([]);
      }
    };

    fetchOtherDrivers();
  }, [isDriverViewingSelf, selectedDate, currentUser, showOtherDriverDeliveries]);

  const { pickups, patientDeliveries } = useMemo(() => {
    // CRITICAL: For any driver viewing their own route, show their markers + mini markers for other drivers
    const isDriver = currentUser && userHasRole(currentUser, 'driver');
    
    let deliveriesToShow = safeDeliveries;
    
    // CRITICAL: Include other drivers' deliveries when showOtherDriverDeliveries is true (checkbox checked)
    // AND for any driver viewing their own route (any date)
    if (isDriver && isDriverViewingSelf && showOtherDriverDeliveries && otherDriverDeliveries.length > 0) {
      deliveriesToShow = [...safeDeliveries, ...otherDriverDeliveries];
    }
    
    const pickups = deliveriesToShow.filter((d) => d && !d.patient_id && d.store_id);
    const patientDeliveries = deliveriesToShow.filter((d) => d && d.patient_id);
    return { pickups, patientDeliveries };
  }, [safeDeliveries, isDriverViewingSelf, otherDriverDeliveries, currentUser, showOtherDriverDeliveries]);

  // NEW: Fetch Google route polyline for display
  useEffect(() => {
  const fetchGoogleRoute = async () => {
  // Only fetch if:
  // 1. We have deliveries to display
  // 2. We're in single driver mode
  // 3. showRoutes is enabled
  if (!safeDeliveries.length || !isSingleDriverMode || !showRoutes) {
    setGoogleRouteCoordinates(null);
    return;
  }

  // Get the driver ID from deliveries
  const driverId = safeDeliveries[0]?.driver_id;
  if (!driverId) {
    setGoogleRouteCoordinates(null);
    return;
  }

  // Get delivery date
  const deliveryDate = safeDeliveries[0]?.delivery_date;
  if (!deliveryDate) {
    setGoogleRouteCoordinates(null);
    return;
  }

  // Check if route has started (has in-transit or completed stops)
  const hasStarted = safeDeliveries.some((d) =>
    ['in_transit', ...FINISHED_STATUSES].includes(d.status)
  );

      if (hasStarted) {
        setGoogleRouteCoordinates(null);
        return;
      }

      try {
        const coordinates = await getStoredRouteCoordinates(
          driverId,
          deliveryDate,
          'to_first_stop'
        );

        if (coordinates && coordinates.length > 0) {
          const leafletCoords = coordinates.map((coord) => [coord.lat, coord.lng]);
          setGoogleRouteCoordinates(leafletCoords);
        } else {
          setGoogleRouteCoordinates(null);
        }
      } catch (error) {
        setGoogleRouteCoordinates(null);
      }
    };

    fetchGoogleRoute();
  }, [safeDeliveries, isSingleDriverMode, showRoutes]);

  // Get coordinates for deliveries and pickups - Use backend isNextDelivery flag
  const { deliveryMarkers, groupedDeliveryMarkers, pickupMarkers, groupedPickupMarkers, hasIncompleteStops } = useMemo(() => {
    // Check if route has any incomplete stops
    const hasIncompleteStops = safeDeliveries.some(d => d && !FINISHED_STATUSES.includes(d.status));

    // Process delivery markers
    const deliveryMarkersRaw = patientDeliveries.map((delivery) => {
      if (!delivery) return null;

      const patient = safePatients.find((p) => p && p.id === delivery.patient_id);
      if (!patient?.latitude || !patient?.longitude) return null;

      const driver = safeUsers.find((u) => u && typeof u === 'object' && u.id === delivery.driver_id);
      const store = safeStores.find((s) => s && s.id === delivery.store_id);

      // CRITICAL: Enrich driver data with denormalized driver_name if driver not found
      const enrichedDriver = driver || (delivery.driver_name ? { 
        id: delivery.driver_id, 
        user_name: delivery.driver_name,
        full_name: delivery.driver_name 
      } : null);

      const isFirstTime = isFirstTimeDelivery(delivery);

      const isCurrentUserDispatcher = userHasRole(currentUser, 'dispatcher');
      const isStopInDispatcherStore = isCurrentUserDispatcher && currentUser.store_ids && store && currentUser.store_ids.includes(store.id);
      const useSimpleCircle = isCurrentUserDispatcher && !isStopInDispatcherStore;

      // CRITICAL: Use backend isNextDelivery flag for blue marker circle
      const isNextInLine = delivery.isNextDelivery || false;
      
      // CRITICAL: Track delivery status and isNextDelivery in stable key
      const stableKey = `${delivery.id}:${delivery.status}:${isNextInLine}:${delivery.stop_order}`;

      const hasNoPickup = delivery.patient_id && (!delivery.puid || delivery.puid.trim() === '');

      // CRITICAL: Determine if this marker belongs to another driver when viewing self (any driver)
      const isDriver = userHasRole(currentUser, 'driver');
      const isOtherDriver = isDriver && isDriverViewingSelf && delivery.driver_id !== currentUser?.id;

      // CRITICAL: Determine pin color based on mode - calculate ONCE, before rendering
      let pinColor;
      if (isStopInDispatcherStore) {
        // Dispatcher's own stores - ALWAYS use store colors regardless of driver or PUID
        pinColor = store ? getStoreColor(store) : '#6B7280';
      } else if (hasNoPickup) {
        pinColor = '#FBBF24';
      } else if (isAllDriversMode) {
        // All drivers mode - use driver colors
        pinColor = enrichedDriver && typeof enrichedDriver === 'object' ? getDriverColor(enrichedDriver) : '#607D8B';
      } else {
        // Single driver mode - use store colors
        pinColor = store ? getStoreColor(store) : '#6B7280';
      }

      return {
        ...delivery,
        latitude: patient.latitude,
        longitude: patient.longitude,
        patient,
        driver: enrichedDriver, // Use enriched driver
        store,
        pinColor,
        number: delivery.display_stop_order || delivery.stop_order || 0,
        isFirstTime,
        isNextInLine,
        markerType: 'delivery',
        useSimpleCircle,
        isOtherDriver // NEW
      };
    }).filter(Boolean);

    // Process pickup markers
    const pickupMarkersRaw = pickups.map((pickup) => {
      if (!pickup) return null;

      const store = safeStores.find((s) => s && s.id === pickup.store_id);
      if (!store?.latitude || !store?.longitude) return null;

      // FIXED: Find driver by ID only, don't require user_name in find condition
      const driver = safeUsers.find((u) => u && typeof u === 'object' && u.id === pickup.driver_id);

      // CRITICAL: Enrich driver data with denormalized driver_name if driver not found
      const enrichedDriver = driver || (pickup.driver_name ? { 
        id: pickup.driver_id, 
        user_name: pickup.driver_name,
        full_name: pickup.driver_name 
      } : null);

      // CRITICAL: Pickups should NEVER use simple circles - they always show full store pickup markers
      const useSimpleCircle = false;

      // Store pickups ALWAYS use store colors (both modes)
      const pinColor = getStoreColor(store);

      // CRITICAL: Determine if this marker belongs to another driver when viewing self (any driver)
      const isDriver = userHasRole(currentUser, 'driver');
      const isOtherDriver = isDriver && isDriverViewingSelf && pickup.driver_id !== currentUser?.id;

      // CRITICAL: Pin color for pickups - ALWAYS use store color (never driver color)
      const pickupPinColor = getStoreColor(store);

      return {
        ...pickup,
        latitude: store.latitude,
        longitude: store.longitude,
        store,
        pinColor: pickupPinColor, // CRITICAL: Always store color for pickups
        driver: enrichedDriver, // Use enriched driver
        number: pickup.display_stop_order || pickup.stop_order || 0,
        markerType: 'pickup',
        useSimpleCircle,
        isOtherDriver // NEW
      };
    }).filter(Boolean);
    
    // UNIFIED: Combine all markers for location counting
    const allMarkers = [...deliveryMarkersRaw, ...pickupMarkersRaw];
    
    // Group ALL markers by locationKey (both pickups and deliveries)
    const unifiedGrouped = new Map();
    allMarkers.forEach((marker) => {
      const key = `${marker.latitude.toFixed(6)},${marker.longitude.toFixed(6)}`;
      if (!unifiedGrouped.has(key)) {
        unifiedGrouped.set(key, { deliveries: [], pickups: [] });
      }
      const group = unifiedGrouped.get(key);
      if (marker.markerType === 'delivery') {
        group.deliveries.push(marker);
      } else {
        group.pickups.push(marker);
      }
    });

    // Calculate total count at each location (deliveries + pickups)
    const locationCounts = new Map();
    unifiedGrouped.forEach((group, key) => {
      const totalCount = group.deliveries.length + group.pickups.length;
      locationCounts.set(key, totalCount);
    });

    // Add duplicate count to each marker (unified count)
    const deliveryMarkersWithCounts = deliveryMarkersRaw.map((marker) => {
      const key = `${marker.latitude.toFixed(6)},${marker.longitude.toFixed(6)}`;
      return {
        ...marker,
        duplicateCount: locationCounts.get(key) || 1
      };
    });

    const pickupMarkersWithCounts = pickupMarkersRaw.map((marker) => {
      const key = `${marker.latitude.toFixed(6)},${marker.longitude.toFixed(6)}`;
      return {
        ...marker,
        duplicateCount: locationCounts.get(key) || 1
      };
    });

    // Create separate grouped maps for each type
    const groupedDeliveries = new Map();
    deliveryMarkersWithCounts.forEach((marker) => {
      const key = `${marker.latitude.toFixed(6)},${marker.longitude.toFixed(6)}`;
      if (!groupedDeliveries.has(key)) {
        groupedDeliveries.set(key, []);
      }
      groupedDeliveries.get(key).push(marker);
    });

    const groupedPickups = new Map();
    pickupMarkersWithCounts.forEach((marker) => {
      const key = `${marker.latitude.toFixed(6)},${marker.longitude.toFixed(6)}`;
      if (!groupedPickups.has(key)) {
        groupedPickups.set(key, []);
      }
      groupedPickups.get(key).push(marker);
    });

    return { 
      deliveryMarkers: deliveryMarkersWithCounts, 
      groupedDeliveryMarkers: groupedDeliveries,
      pickupMarkers: pickupMarkersWithCounts,
      groupedPickupMarkers: groupedPickups,
      hasIncompleteStops
    };
  // CRITICAL: Use stable references to prevent re-renders on smart refresh
  // Only recalculate when actual data IDs change, not on every array reference change
  }, [
    // CRITICAL: Track status, isNextDelivery, and stop_order changes for immediate marker updates
    patientDeliveries.map(d => `${d?.id}:${d?.status}:${d?.isNextDelivery}:${d?.stop_order}`).join(','),
    pickups.map(p => `${p?.id}:${p?.status}:${p?.isNextDelivery}:${p?.stop_order}`).join(','),
    // Stable user/store/patient tracking
    safeUsers.map(u => u?.id).join(','),
    safeStores.map(s => s?.id).join(','),
    safePatients.map(p => p?.id).join(','),
    isAllDriversMode,
    currentUser?.id,
    isDriverViewingSelf,
    showOtherDriverDeliveries // CRITICAL: Re-render when checkbox changes
  ]);

  const calculateFannedPosition = useCallback((originalLat, originalLng, markerIndex, totalMarkers, stopOrder) => {
    if (currentZoom < 11 || currentZoom > 18) {
      return [originalLat, originalLng];
    }

    const baseRadius = 0.0008;
    const dynamicRadius = 0.0008;
    const radius = baseRadius + (18 - currentZoom) * dynamicRadius;

    // Calculate arc width based on number of markers
    // More markers = wider arc (up to -90 to +90 degrees from vertical)
    let arcWidth;
    if (totalMarkers <= 2) {
      arcWidth = 90; // ±45 degrees
    } else if (totalMarkers === 3) {
      arcWidth = 120; // ±60 degrees
    } else if (totalMarkers === 4) {
      arcWidth = 140; // ±70 degrees
    } else {
      // For 5+ markers, scale up to maximum 180 degrees (±90)
      arcWidth = Math.min(180, 140 + (totalMarkers - 4) * 10);
    }

    // Convert arc width to radians and calculate start/end angles
    // 90 degrees (π/2) points straight up, so we spread symmetrically around that
    const arcWidthRad = (arcWidth * Math.PI) / 180;
    const startAngle = (Math.PI / 2) - (arcWidthRad / 2); // Left side of arc
    const endAngle = (Math.PI / 2) + (arcWidthRad / 2);   // Right side of arc

    // Calculate angle for this marker based on its index in the sorted array
    let angle;
    if (totalMarkers === 1) {
      angle = Math.PI / 2; // Straight up
    } else {
      const angleStep = (endAngle - startAngle) / (totalMarkers - 1);
      // Reverse the order: lowest stop order (index 0) goes to right (end of arc)
      angle = startAngle + ((totalMarkers - 1 - markerIndex) * angleStep);
    }

    // Calculate new position
    // Note: In geographic coordinates, latitude is Y and longitude is X
    const fannedLat = originalLat + radius * Math.sin(angle);
    const fannedLng = originalLng + radius * Math.cos(angle);

    return [fannedLat, fannedLng];
  }, [currentZoom]);

  // NEW: Handler for marker click to toggle fanning with zoom behavior
  const handleMarkerClickForFanning = useCallback((marker, markerType) => {
    const locationKey = `${marker.latitude.toFixed(6)},${marker.longitude.toFixed(6)}`;
    
    if (marker.duplicateCount > 1) {
      if (onMapInteraction) onMapInteraction();
      
      if (fannedLocationKey === locationKey) {
        // Already fanned - clicking again should retract
        setFannedLocationKey(null);
        return;
      }
      
      const deliveriesAtLocation = groupedDeliveryMarkers.get(locationKey) || [];
      const pickupsAtLocation = groupedPickupMarkers.get(locationKey) || [];
      const markersAtLocation = [...pickupsAtLocation, ...deliveriesAtLocation];
      
      markersAtLocation.sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
      const bounds = L.latLngBounds([marker.latitude, marker.longitude]);
      
      markersAtLocation.forEach((m, index) => {
        const [fannedLat, fannedLng] = calculateFannedPosition(
          marker.latitude,
          marker.longitude,
          index,
          markersAtLocation.length,
          m.stop_order
        );
        bounds.extend([fannedLat, fannedLng]);
      });
      
      if (map) {
        // Center on original cluster location with padding for stop cards
        const fitOptions = { 
          paddingTopLeft: [80, 80],
          paddingBottomRight: [80, stopCardsHeight > 0 ? stopCardsHeight : 80],
          maxZoom: 14,
          animate: true,
          duration: 0.6
        };
        
        // Create bounds around just the original cluster point
        const clusterBounds = L.latLngBounds([
          [marker.latitude, marker.longitude],
          [marker.latitude, marker.longitude]
        ]);
        
        map.fitBounds(clusterBounds, fitOptions);
        
        setTimeout(() => {
          setFannedLocationKey(locationKey);
        }, 650);
      } else {
        setFannedLocationKey(locationKey);
      }
      
      // Don't call onMarkerClick when clicking cluster
      return;
    }
    
    // Retract any expanded cluster and call onMarkerClick for non-clustered markers
    setFannedLocationKey(null);
    
    // CRITICAL: For pending deliveries, select the assigned pickup instead
    if (marker.status === 'pending' && marker.puid) {
      const assignedPickup = pickupMarkers.find(p => p && p.stop_id === marker.puid);
      if (assignedPickup && onMarkerClick) {
        onMarkerClick(assignedPickup);
        return;
      }
    }
    
    if (onMarkerClick) {
      onMarkerClick(marker);
    }
    // Notify parent that map interaction occurred (marker click)
    if (onMapInteraction) {
      onMapInteraction();
    }
  }, [fannedLocationKey, onMarkerClick, currentZoom, map, groupedDeliveryMarkers, groupedPickupMarkers, calculateFannedPosition, onMapInteraction, stopCardsHeight]);

  // NEW: Auto-unfan when zooming below level 11
  useEffect(() => {
    if (currentZoom < 11 && fannedLocationKey) {
      setFannedLocationKey(null);
    }
  }, [currentZoom, fannedLocationKey]);

  // Check if viewing current date (for real-time features) - FIXED: treat null as today
  const isViewingCurrentDate = useMemo(() => {
    const today = format(new Date(), 'yyyy-MM-dd');
    // If no selectedDate, assume we're viewing today
    if (!selectedDate) return true;
    return selectedDate === today;
  }, [selectedDate]);

  // CRITICAL: Process ALL on_duty drivers from realtimeAppUsers, not just from driverLocations prop
  // This ensures shared markers render even when driverLocations prop is empty
  // Use ref to cache previous markers and only update when actual data changes
  const prevDriverLocationMarkersRef = useRef([]);
  
  const driverLocationMarkers = useMemo(() => {
    if (!isViewingCurrentDate) {
      prevDriverLocationMarkersRef.current = [];
      return [];
    }

    const isAdmin = currentUser && userHasRole(currentUser, 'admin');
    const isDriverRole = currentUser && userHasRole(currentUser, 'driver');
    const currentUserCityId = currentUser?.city_id;
    const fiveMinutesInMs = 5 * 60 * 1000;
    const now = Date.now();

    // CRITICAL: Use realtimeAppUsers as the source of truth (contains merged location data)
    const markers = safeUsers.map((user) => {
      if (!user || typeof user !== 'object') return null;
      
      const driverId = user.id || user.user_id;
      if (!driverId) return null;

      const isCurrentUserMarker = driverId === currentUser?.id;

      // CRITICAL: On mobile, ALWAYS skip current user's shared location marker
      // The blue GPS dot already shows their location - no need for duplicate marker
      if (isMobile && isCurrentUserMarker) {
        return null;
      }
      
      // CRITICAL: On desktop, ALWAYS show current user's shared marker if they have location data
      // Don't skip based on on_duty status - if they have location, show it
      
      // Skip inactive users
      if (user.status === 'inactive') {
        return null;
      }
      
      // CRITICAL: Check for location data - skip if missing
      if (!user.current_latitude || !user.current_longitude) {
        return null;
      }
      
      // CRITICAL: Check if on break and viewing self on other device
      const isOnBreak = user.driver_status === 'on_break' && isCurrentUserMarker;
      
      // CRITICAL: Must be on_duty OR on_break (self only) with location_tracking_enabled
      // Others cannot see on_break drivers, but self can always see their own marker
      if (user.driver_status === 'on_break' && !isCurrentUserMarker) {
        return null; // Others cannot see on_break drivers
      }
      if (user.driver_status !== 'on_duty' && user.driver_status !== 'on_break') {
        return null;
      }
      // Location tracking must be enabled, UNLESS it's your own marker (you always see yourself)
      if (user.location_tracking_enabled !== true && !isCurrentUserMarker) {
        return null;
      }

      // Permission filtering - drivers and admins see all shared locations in same city
      if (!isAdmin && !isDriverRole) {
        return null;
      }
      
      if (!isAdmin && currentUserCityId !== user.city_id) {
        return null;
      }

      // Dispatcher filtering - only show drivers with deliveries for dispatcher's stores
      if (currentUser && userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin')) {
        const dispatcherStoreIds = new Set(currentUser.store_ids || []);
        const hasDeliveryInDispatcherStore = safeDeliveries.some(delivery =>
          delivery &&
          delivery.driver_id === driverId &&
          dispatcherStoreIds.has(delivery.store_id)
        );

        if (!hasDeliveryInDispatcherStore) {
          return null;
        }
      }

      // CRITICAL: Determine if location is stale (>5 minutes old)
      let isStaleLocation = false;
      if (user.location_updated_at) {
        const locationAge = now - new Date(user.location_updated_at).getTime();
        isStaleLocation = locationAge > fiveMinutesInMs;
      } else {
        isStaleLocation = true;
      }

      const driverColor = getDriverColor(user);
      const driverName = user.user_name || user.full_name || 'Unknown Driver';
      const driverInitial = driverName.charAt(0).toUpperCase();

      return {
        id: driverId,
        user_id: driverId,
        driver_id: driverId,
        latitude: user.current_latitude,
        longitude: user.current_longitude,
        location_updated_at: user.location_updated_at,
        driver: user,
        driverColor,
        driverName,
        driverInitial,
        isSelf: isCurrentUserMarker,
        driver_status: user.driver_status,
        location_tracking_enabled: user.location_tracking_enabled,
        isStaleLocation,
        isOnBreak
      };
    }).filter(Boolean);

    // CRITICAL: Only update if markers actually changed to prevent blinking
    const newKey = markers.map(m => `${m.id}:${m.latitude?.toFixed(5)}:${m.longitude?.toFixed(5)}:${m.driver_status}:${m.isStaleLocation}`).join('|');
    const prevKey = prevDriverLocationMarkersRef.current.map(m => `${m.id}:${m.latitude?.toFixed(5)}:${m.longitude?.toFixed(5)}:${m.driver_status}:${m.isStaleLocation}`).join('|');
    
    if (newKey === prevKey && prevDriverLocationMarkersRef.current.length > 0) {
      return prevDriverLocationMarkersRef.current;
    }
    
    prevDriverLocationMarkersRef.current = markers;
    return markers;
  // CRITICAL: Use stable references - minimize dependencies to prevent blinking
  }, [
    // Only include essential data that affects marker visibility
    isViewingCurrentDate,
    currentUser?.id,
    isMobile,
    // Track user location data with stable key - round coordinates to prevent micro-changes
    safeUsers.map(u => `${u?.id}:${u?.current_latitude?.toFixed(5)}:${u?.current_longitude?.toFixed(5)}:${u?.driver_status}:${u?.location_tracking_enabled}`).join('|')
  ]);

  // UPDATED: Process current driver's live location for display - ONLY SHOW ON MOBILE, TODAY'S DATE
  const currentDriverMarker = useMemo(() => {
    // CRITICAL: Only show blue dot on mobile devices
    if (!isMobile) {
      return null;
    }

    if (!currentDriverLocation || !currentUser) {
      return null;
    }

    // CRITICAL: Check if viewing today's date - handle null selectedDate as today
    const today = format(new Date(), 'yyyy-MM-dd');
    const isToday = !selectedDate || selectedDate === today;
    
    if (!isToday) {
      return null;
    }

    // CRITICAL: Only show for drivers viewing their own location (not dispatchers)
    const isCurrentUserDriver = userHasRole(currentUser, 'driver');
    const isCurrentUserDispatcher = userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin');
    
    // Dispatchers never see blue dot
    if (isCurrentUserDispatcher && !isCurrentUserDriver) {
      return null;
    }
    
    if (!isCurrentUserDriver) {
      return null;
    }

    if (!currentDriverLocation.latitude || !currentDriverLocation.longitude) {
      return null;
    }

    return {
      ...currentDriverLocation,
      driver: currentUser
    };
  }, [currentDriverLocation, currentUser, isMobile, selectedDate]);

  // NEW: Calculate driver home locations for drivers with active stops - CURRENT DATE ONLY
  const driverHomeMarkers = useMemo(() => {
    if (!showRoutes || !currentUser || !isViewingCurrentDate) return [];

    // CRITICAL: Dispatchers should not see home locations
    if (userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin')) {
      return [];
    }

    // Check if current user is app owner (Base44 platform admin)
    const isCurrentUserDriver = userHasRole(currentUser, 'driver');
    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];

    const driversWithActiveStops = new Set();

    safeDeliveries.forEach((delivery) => {
      if (!delivery) return;
      if (!finishedStatuses.includes(delivery.status) && delivery.driver_id) {
        driversWithActiveStops.add(delivery.driver_id);
      }
    });

    const homeMarkers = [];
    driversWithActiveStops.forEach((driverId) => {
      if (isDriverViewingSelfToday && driverId !== currentUser.id) return;

      // FIXED: Find driver by ID only, don't require user_name in find condition
      const driver = safeUsers.find((u) => u && typeof u === 'object' && u.id === driverId);

      if (!driver?.home_latitude || !driver?.home_longitude) {
        return; // Skip drivers without home coordinates
      }

      // Determine if this home marker should be visible to current user
      const shouldRenderHome =
        isAppOwner(currentUser) || // App owner sees all home markers
        (isCurrentUserDriver && driver.id === currentUser.id); // Driver sees only their own
      const driverName = driver.user_name || driver.full_name || 'Unknown Driver';

      if (shouldRenderHome) {
        const driverColor = getDriverColor(driver);

        homeMarkers.push({
          id: `home-${driverId}`,
          driverId,
          driver,
          latitude: driver.home_latitude,
          longitude: driver.home_longitude,
          driverColor,
          driverName
        });

      }
    });

    return homeMarkers;
  // CRITICAL: Use minimal, stable dependencies to prevent blinking
  }, [
    showRoutes,
    currentUser?.id,
    isViewingCurrentDate,
    isDriverViewingSelfToday,
    // Only track essential data with stable JSON stringify
    JSON.stringify(safeDeliveries.map(d => ({ id: d?.driver_id, status: d?.status }))),
    JSON.stringify(safeUsers.map(u => ({ id: u?.id, hLat: u?.home_latitude, hLon: u?.home_longitude })))
  ]);

  // CRITICAL: Store previous driverRoutes to prevent unnecessary recalculations
  const prevDriverRoutesRef = useRef([]);
  
  // Generate routes for each driver - NOW WITH ZOOM-BASED STYLING, CURRENT DATE ONLY for polylines
  const driverRoutes = useMemo(() => {
    if (!showRoutes || currentZoom < ZOOM_LEVELS.HIDE_ROUTES) {
      prevDriverRoutesRef.current = [];
      return [];
    }
    
    const showLivePolylines = isViewingCurrentDate;
    const isDispatcherNonAdmin = userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin');

    // Use shared finished statuses
    const activeStatuses = ['in_transit']; // NEW

    // Group deliveries by driver
    const routesByDriver = {};

    deliveryMarkers.forEach((delivery) => {
    if (!delivery) return;
    const driverId = delivery.driver_id || 'unassigned';
    if (!routesByDriver[driverId]) {
      const driverForRoute = safeUsers.find((u) => u && typeof u === 'object' && u.id === driverId);

      // CRITICAL: Determine route color based on mode - calculated ONCE before rendering
      const routeColor = isAllDriversMode ?
        // All drivers mode - use driver colors
        (driverForRoute && typeof driverForRoute === 'object' ? getDriverColor(driverForRoute) : '#607D8B')
        :
        // Single driver mode - use first delivery's store color
        delivery.pinColor;

      const driverDisplayName = driverForRoute ? (driverForRoute.user_name || driverForRoute.full_name || 'Unknown') : 'Unassigned';

      routesByDriver[driverId] = {
        driverId,
        driverName: driverDisplayName,
        driver: driverForRoute,
        color: routeColor,
        stops: [],
        sortOrder: driverForRoute?.sort_order ?? Infinity
      };
    }
    routesByDriver[driverId].stops.push(delivery);
    });

    // Sort stops by stop_order and create route lines
    const routes = Object.values(routesByDriver).map((route) => {
    // CRITICAL: Count ONLY stops from safeDeliveries (filtered by current driver selection)
    // This ensures the legend shows accurate counts without including other drivers' stops
    const totalDriverStops = safeDeliveries.filter(d => d && d.driver_id === route.driverId).length;

    // Find ALL pickup locations for this driver
    const driverPickups = pickupMarkers.filter((p) => p.driver_id === route.driverId);

    // Check if all stops (deliveries + pickups) are finished
    const allDeliveriesFinished = route.stops.every((d) => FINISHED_STATUSES.includes(d.status));
    const allPickupsFinished = driverPickups.every((p) => FINISHED_STATUSES.includes(p.status));
    const isRouteCompleted = allDeliveriesFinished && allPickupsFinished;

    const hasActiveStops = route.stops.some((delivery) => delivery && activeStatuses.includes(delivery.status)) ||
      driverPickups.some((p) => p && activeStatuses.includes(p.status));
    const hasCompletedStops = route.stops.some((d) => FINISHED_STATUSES.includes(d.status)) ||
      driverPickups.some((p) => p && FINISHED_STATUSES.includes(p.status));
    const isRouteStarted = hasActiveStops || hasCompletedStops;

      // Show all stops when route is completed, otherwise filter to active only
      let deliveriesToRoute = isRouteCompleted ? route.stops : route.stops.filter((delivery) => delivery && !FINISHED_STATUSES.includes(delivery.status) && delivery.status !== 'pending');
      let pickupsToRoute = isRouteCompleted ? driverPickups : driverPickups.filter((p) => p && !FINISHED_STATUSES.includes(p.status) && p.status !== 'pending');

      // Use isRouteStarted that's already defined above
      const routeHasActuallyStarted = isRouteStarted;

      // Build route coordinates by combining ALL stops and sorting by stop order
      let coordinates = [];
      let lastStopCoordinates = null;
      let shouldShowHomeRoute = false;
      let firstStopCoordinates = null; // NEW: Track first stop for pre-route line
      let startToFirstStopCoordinates = null; // NEW: Track route from start to first stop

      if (pickupsToRoute.length === 0 && deliveriesToRoute.length === 0) {
        coordinates = [];
      } else {
        // Combine pickups and deliveries into a single array with stop order info
        const allStops = [
          ...pickupsToRoute.map((pickup) => ({
            type: 'pickup',
            stop_order: pickup.display_stop_order || pickup.stop_order || 0,
            latitude: pickup.latitude,
            longitude: pickup.longitude,
            store: pickup.store?.name,
            time: pickup.delivery_time_start
          })),
          ...deliveriesToRoute.map((delivery) => ({
            type: 'delivery',
            stop_order: delivery.display_stop_order || delivery.stop_order || 0,
            latitude: delivery.latitude,
            longitude: delivery.longitude,
            patient: delivery.patient?.full_name,
            time: delivery.delivery_time_start
          }))];

        allStops.sort((a, b) => a.stop_order - b.stop_order);
        coordinates = allStops.map((stop) => [stop.latitude, stop.longitude]);

        if (allStops.length > 0) {
          const firstStop = allStops[0];
          firstStopCoordinates = [firstStop.latitude, firstStop.longitude];
        }

        if (allStops.length > 0) {
          const lastStop = allStops[allStops.length - 1];
          lastStopCoordinates = [lastStop.latitude, lastStop.longitude];
          shouldShowHomeRoute = !isRouteCompleted && !isDispatcherNonAdmin;
        }

        // NEW: Determine starting point for visualization (routeHasActuallyStarted defined above)
        // CRITICAL: Skip home-to-first-stop lines for other drivers when viewing self today
        const isOtherDriverRoute = isDriverViewingSelfToday && route.driverId !== currentUser?.id;
        
        if (routeHasActuallyStarted && firstStopCoordinates && route.driver && !isOtherDriverRoute) {
          let startPoint = null;

          if (currentUser && route.driver.id === currentUser.id && currentDriverLocation?.latitude && currentDriverLocation?.longitude) {
            startPoint = [currentDriverLocation.latitude, currentDriverLocation.longitude];
          }
          else if (route.driver.current_latitude && route.driver.current_longitude && route.driver.location_updated_at) {
            const locationAge = Date.now() - new Date(route.driver.location_updated_at).getTime();
            const fiveMinutesInMs = 5 * 60 * 1000;

            if (locationAge < fiveMinutesInMs) {
              startPoint = [route.driver.current_latitude, route.driver.current_longitude];
            }
          }

          if (!startPoint && hasCompletedStops) {
            const completedStopsForDriver = [...route.stops, ...driverPickups]
              .filter((s) => s && FINISHED_STATUSES.includes(s.status) && s.actual_delivery_time)
              .sort((a, b) => new Date(b.actual_delivery_time) - new Date(a.actual_delivery_time));

            if (completedStopsForDriver.length > 0) {
              const lastCompleted = completedStopsForDriver[0];
              startPoint = [lastCompleted.latitude, lastCompleted.longitude];
            }
          }

          if (startPoint) {
            startToFirstStopCoordinates = [startPoint, firstStopCoordinates];
          }
        } else if (!isRouteStarted && firstStopCoordinates && route.driver && !isDispatcherNonAdmin && !isOtherDriverRoute) {
          // CRITICAL: For unstarted routes, only show home-to-first-stop line if NO live location available
          // The blue dashed line from current location to next stop is drawn separately below
          const hasLiveLocation = currentUser && route.driver.id === currentUser.id && currentDriverLocation?.latitude && currentDriverLocation?.longitude;
          
          // Only use home location if no live location is available
          if (!hasLiveLocation && route.driver.home_latitude && route.driver.home_longitude) {
            const startPoint = [route.driver.home_latitude, route.driver.home_longitude];
            startToFirstStopCoordinates = [startPoint, firstStopCoordinates];
          }
          // If live location exists, don't set startToFirstStopCoordinates - the separate blue dashed line handles it
        }
      }

      // NEW: Determine route styling based on zoom
      let routeWeight = 2;
      let routeOpacity = 0.8;
      let showWaypoints = true;

      if (currentZoom < ZOOM_LEVELS.SIMPLIFY_ROUTES) {
        routeWeight = 1.5;
        routeOpacity = 0.6;
        showWaypoints = false;
      } else if (currentZoom >= ZOOM_LEVELS.FULL_DETAIL) {
        routeWeight = 3;
        routeOpacity = 0.9;
      }
      
      // Increase route weight for mobile devices
      if (isMobile) {
        routeWeight *= 1.25;
      }

      // Determine if this is an origin line (bright red) vs pre-route line (dashed)
      const isOriginLine = routeHasActuallyStarted;

      return {
        ...route,
        coordinates,
        lastStopCoordinates, // Add last stop coordinates
        shouldShowHomeRoute: showLivePolylines && shouldShowHomeRoute, // Only show on current date
        startToFirstStopCoordinates: showLivePolylines ? startToFirstStopCoordinates : null, // Only show on current date
        isOriginLine, // NEW: Flag to distinguish origin line from pre-route line
        hasPickup: pickupsToRoute.length > 0,
        isCompleted: isRouteCompleted,
        isRouteStarted, // NEW: Track if route has started
        pickupCount: driverPickups.length,
        totalStops: totalDriverStops, // FIXED: Use total count including deliveries without coordinates
        // NEW: Zoom-based styling
        routeWeight,
        routeOpacity,
        showWaypoints
      };
    });
    
    const sortedRoutes = routes.sort((a, b) => a.sortOrder - b.sortOrder);
    
    // CRITICAL: Only update ref if routes actually changed (deep comparison of driver IDs and stop counts)
    const routesKey = sortedRoutes.map(r => `${r.driverId}:${r.totalStops}`).join('|');
    const prevRoutesKey = prevDriverRoutesRef.current.map(r => `${r.driverId}:${r.totalStops}`).join('|');
    
    if (routesKey === prevRoutesKey) {
      // Routes haven't changed - return cached version to prevent re-render
      return prevDriverRoutesRef.current;
    }
    
    // Routes changed - update cache and return new routes
    prevDriverRoutesRef.current = sortedRoutes;
    return sortedRoutes;
  // CRITICAL: Use stable references for driverRoutes to prevent legend flickering
  }, [
    deliveryMarkers.map(d => `${d?.id}:${d?.stop_order}:${d?.status}`).join(','),
    pickupMarkers.map(p => `${p?.id}:${p?.stop_order}:${p?.status}`).join(','),
    showRoutes,
    isAllDriversMode,
    safeUsers.map(u => u?.id).join(','),
    currentZoom,
    currentUser?.id,
    currentDriverLocation?.latitude,
    currentDriverLocation?.longitude,
    isViewingCurrentDate,
    isDriverViewingSelfToday,
    routeRenderKey // CRITICAL: Force recalculation when deliveries update
  ]);
  
  // Pass driver routes to parent component
  useEffect(() => {
    if (onDriverRoutesCalculated) {
      onDriverRoutesCalculated(driverRoutes);
    }
  }, [driverRoutes, onDriverRoutesCalculated]);

  // CRITICAL: Notify parent when map is ready - simplified to prevent infinite loops
  const hasNotifiedMapReady = useRef(false);

  // Notify parent once when map and markers are ready
  useEffect(() => {
    if (hasNotifiedMapReady.current) return;
    if (!map) return;
    
    const hasMarkers = deliveryMarkers.length > 0 || pickupMarkers.length > 0;
    const isReady = hasMarkers || safeDeliveries.length === 0;
    
    if (isReady && onMapReady) {
      hasNotifiedMapReady.current = true;
      onMapReady();
    }
  }, [map, deliveryMarkers.length, pickupMarkers.length, safeDeliveries.length, onMapReady]);

  // NEW: Calculate legend position centered below stats card (AFTER driverRoutes is defined)
  useEffect(() => {
    if (!statsCardRect) {
      setLegendLeft(null);
      return;
    }

    // Calculate the center of the stats card
    const statsCardCenterX = statsCardRect.left + (statsCardRect.width / 2);
    
    // If legendRef is available, account for legend width, otherwise just use stats card center
    if (legendRef.current) {
      const legendWidth = legendRef.current.offsetWidth;
      const calculatedLeft = statsCardCenterX - (legendWidth / 2);
      setLegendLeft(calculatedLeft);
    } else {
      // Fallback: position at stats card center (will be adjusted on next render when ref is available)
      setLegendLeft(statsCardCenterX);
    }
  }, [statsCardRect, driverRoutes.length, isStatsCardExpanded]);

  // Handle dynamic map center and zoom changes - ONLY when shouldFitBounds is explicitly set
  useEffect(() => {
    if (!map) {
      return;
    }

    // SAFETY: Ensure map is fully loaded before attempting operations
    if (!map.getCenter) {
      return;
    }

    // CRITICAL: Only apply map changes when shouldFitBounds is explicitly set
    // This prevents auto-centering when other props changes
    if (!shouldFitBounds) {
      return;
    }

    try {
      const bounds = L.latLngBounds(shouldFitBounds.bounds);
      
      // CRITICAL: Use padding values directly from Dashboard.js - don't override
      const modifiedOptions = { 
        ...shouldFitBounds.options,
        animate: true,
        duration: 0.8 // Smooth 800ms animation
      };
      
      map.fitBounds(bounds, modifiedOptions);

      if (onBoundsFitted && typeof onBoundsFitted === 'function') {
        onBoundsFitted();
      }
    } catch (error) {}
  }, [map, shouldFitBounds, stopCardsHeight, onBoundsFitted]);

  // Handle marker drag end
  const handleMarkerDragEnd = useCallback((markerId, event, type) => {
    try {
      const newLatLng = event.target.getLatLng();
    } catch (error) {}
  }, []);

  // CRITICAL FIX: Simplified MapController - only sets map reference, no conditional hooks
  // NEW: Track zoom level changes and show overlay AND notify parent of map interactions
  // NEW: Double-tap detection for FAB activation
  function MapController() {
    const lastTapRef = useRef(0);
    const isDraggingRef = useRef(false);
    const hasMovedRef = useRef(false);
    
    const mapInstance = useMapEvents({
      zoomstart: () => {
        // CRITICAL: Check if this is a programmatic zoom (from FAB/auto-center)
        const timeSinceProgrammatic = Date.now() - (window._lastProgrammaticMapMove || 0);
        const isProgrammaticZoom = timeSinceProgrammatic < 1000; // Within 1 second of programmatic move
        
        if (isProgrammaticZoom) {
          console.log('🗺️ [MapController] ZOOM START - PROGRAMMATIC (ignoring)');
          return;
        }
        
        // Real user zoom - notify parent
        console.log('🗺️ [MapController] ZOOM START - USER INTERACTION');
        if (onMapInteraction) {
          onMapInteraction(true); // Pass true for user interaction
        }
      },
      dragstart: () => {
        isDraggingRef.current = true;
        hasMovedRef.current = false;
      },
      drag: () => {
        hasMovedRef.current = true;
      },
      dragend: () => {
        const wasDragging = isDraggingRef.current;
        const didMove = hasMovedRef.current;
        isDraggingRef.current = false;
        hasMovedRef.current = false;
        
        // CRITICAL: Only notify if user actually dragged the map
        if (wasDragging && didMove) {
          const timeSinceProgrammatic = Date.now() - (window._lastProgrammaticMapMove || 0);
          const isProgrammaticDrag = timeSinceProgrammatic < 1000;
          
          if (!isProgrammaticDrag) {
            console.log('🗺️ [MapController] DRAG END - USER INTERACTION');
            if (onMapInteraction) {
              onMapInteraction(true); // Pass true for user interaction
            }
          }
        }
      },
      movestart: () => {
        // CRITICAL: Don't notify on movestart - wait for dragend to confirm real drag
        // This prevents false positives from programmatic map moves
      },
      zoomend: () => {
        const rawZoom = mapInstance.getZoom();
        const roundedZoom = Math.round(rawZoom * 10) / 10; // Round to 1 decimal place
        
        // Only update state if the rounded zoom actually changed
        if (roundedZoom !== currentZoom) {
          setCurrentZoom(roundedZoom);
          
          // CRITICAL: Only show zoom overlay on MANUAL zooms (not programmatic FAB zooms)
          // Check if this was a programmatic zoom (within 500ms of last programmatic move)
          const timeSinceProgrammatic = Date.now() - (window._lastProgrammaticMapMove || 0);
          const isManualZoom = timeSinceProgrammatic > 500;
          
          if (isManualZoom) {
            // Show zoom overlay for 3 seconds on manual zoom only
            if (zoomOverlayTimeoutRef.current) {
              clearTimeout(zoomOverlayTimeoutRef.current);
            }
            setShowZoomOverlay(true);
            zoomOverlayTimeoutRef.current = setTimeout(() => {
              setShowZoomOverlay(false);
            }, 3000);
          }
        }
        
        // Update visible bounds for debug box
        const bounds = mapInstance.getBounds();
        setVisibleBounds(bounds);
      },
      moveend: () => {
        // Update map center for crosshair - use actual center without adjustments
        const center = mapInstance.getCenter();
        setMapCenter([center.lat, center.lng]);
        
        // Update visible bounds for debug box
        const bounds = mapInstance.getBounds();
        setVisibleBounds(bounds);
      },
      click: () => {
        setFannedLocationKey(null);
        
        const now = Date.now();
        const timeSinceLastTap = now - lastTapRef.current;
        
        if (timeSinceLastTap < 300) {
          if (onDoubleTap) onDoubleTap();
        }
        
        lastTapRef.current = now;
      }
    });

    return null;
  }

  // NEW: Enhanced Popup Component with more details
  const DeliveryPopup = ({ delivery, isPickup = false }) => {
    const store = stores.find(s => s && s.id === delivery.store_id);
    const patient = !isPickup ? patients.find(p => p && p.id === delivery.patient_id) : null;
    const driver = users.find(u => u && u.id === delivery.driver_id);

    const getStatusColor = (status) => {
      const statusColors = {
        'pending': 'text-slate-600 bg-slate-100',
        'Ready For Pickup': 'text-amber-700 bg-amber-100',
        'in_transit': 'text-blue-700 bg-blue-100',
        'completed': 'text-emerald-700 bg-emerald-100',
        'failed': 'text-red-700 bg-red-100',
        'cancelled': 'text-red-700 bg-red-100',
        'returned': 'text-orange-700 bg-orange-100'
      };
      return statusColors[status] || 'text-slate-600 bg-slate-100';
    };

    return (
      <div className="min-w-[220px] max-w-[300px]" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-900)' }}>
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-1.5">
            {isPickup ? <Home className="w-4 h-4 text-emerald-600" /> : <Package className="w-4 h-4 text-blue-600" />}
            <h3 className="font-semibold text-sm">
              {isPickup ? store?.name : `Stop #${delivery.number || delivery.stop_order || '?'}`}
              {delivery.isFirstTime && <span className="ml-1 text-yellow-600">⭐</span>}
            </h3>
          </div>
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${getStatusColor(delivery.status)}`}>
            {delivery.status}
          </span>
        </div>

        <div className="space-y-1.5">
          <p className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>
            {isPickup ? store?.address : patient?.full_name}
          </p>

          <p className="text-xs" style={{ color: 'var(--text-slate-600)' }}>
            {isPickup ? store?.address : patient?.address}
            {!isPickup && delivery.unit_number && <span className="ml-1">#{delivery.unit_number}</span>}
          </p>

          {delivery.delivery_time_start && (
            <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-slate-600)' }}>
              <Clock className="w-3.5 h-3.5 flex-shrink-0" />
              <span>
                {delivery.delivery_time_start}
                {delivery.delivery_time_end && ` - ${delivery.delivery_time_end}`}
              </span>
            </div>
          )}

          {delivery.delivery_time_eta && delivery.delivery_time_eta !== delivery.delivery_time_start && (
            <div className="flex items-center gap-1 text-xs text-purple-600 font-medium">
              <Clock className="w-3.5 h-3.5 flex-shrink-0" />
              <span>ETA: {delivery.delivery_time_eta}</span>
            </div>
          )}

          {driver && (
            <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-slate-600)' }}>
              <Truck className="w-3.5 h-3.5 flex-shrink-0" />
              <span>{driver.user_name || driver.full_name}</span>
            </div>
          )}

          {delivery.prescription_number && (
            <div className="text-xs" style={{ color: 'var(--text-slate-600)' }}>
              <span className="font-medium">Rx#</span> {delivery.prescription_number}
            </div>
          )}

          {delivery.tracking_number && (
            <div className="text-xs" style={{ color: 'var(--text-slate-600)' }}>
              <span className="font-medium">TR#</span> {delivery.tracking_number}
            </div>
          )}

          {delivery.cod_total_amount_required > 0 && (
            <div className="flex items-center gap-1 text-xs font-semibold text-emerald-700 bg-emerald-50 px-2 py-1 rounded">
              <span>💵 COD: ${delivery.cod_total_amount_required.toFixed(2)}</span>
            </div>
          )}

          {!isPickup && delivery.delivery_instructions && (
            <div className="text-xs italic border-t pt-1.5 mt-1.5" style={{ color: 'var(--text-slate-500)', borderColor: 'var(--border-slate-200)' }}>
              {delivery.delivery_instructions}
            </div>
          )}

          {delivery.delivery_notes && (
            <div className="text-xs text-blue-600 border-t pt-1.5 mt-1.5" style={{ borderColor: 'var(--border-slate-200)' }}>
              <span className="font-medium">Notes:</span> {delivery.delivery_notes}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="absolute inset-0">
      <MapContainer
        key="delivery-map-container"
        center={center || [53.5461, -113.4938]}
        zoom={zoom || (safeDeliveries.length === 0 ? 11 : 12)}
        maxZoom={18}
        zoomSnap={0}
        zoomDelta={0.1}
        style={{ height: '100%', width: '100%' }}
        zoomControl={false}
        onClick={() => setFannedLocationKey(null)}
        whenReady={(mapInstance) => {
          console.log('[MapCenter] MapContainer whenReady callback fired');
          setMap(mapInstance.target);
          setCurrentZoom(mapInstance.target.getZoom());
          setVisibleBounds(mapInstance.target.getBounds());
        }}> {/* Close fan on map click */}

        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
          url={document.documentElement.classList.contains('dark-theme') || 
               (document.documentElement.classList.contains('auto-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)
               ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
               : "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"}
        />

        <MapController />

        {/* NEW: Draw Google Directions route polyline (if available) - CURRENT DATE ONLY, ONLY if route NOT started */}
        {/* CRITICAL: This is the PRE-ROUTE polyline (before any stops started). Once route starts, we use currentToNextPolyline instead */}
        {isViewingCurrentDate && googleRouteCoordinates && googleRouteCoordinates.length > 1 && !currentToNextPolyline &&
          <Polyline
            positions={googleRouteCoordinates}
            pathOptions={{
              color: '#2563eb',
              weight: 5,
              opacity: 1,
              dashArray: '10, 5',
              lineJoin: 'round',
              lineCap: 'round'
            }} />

        }

        {/* STRAIGHT BLUE DASHED LINE - From driver location (or fallback) to NEXT stop only */}
        {isViewingCurrentDate && (() => {
          const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
          
          // CRITICAL: Only show for current user who is a driver
          if (!currentUser || !userHasRole(currentUser, 'driver')) return null;
          
          // Get all incomplete deliveries for the current driver, sorted by stop_order
          const incompleteDeliveries = deliveryMarkers.filter(d => 
            d && 
            d.driver_id === currentUser?.id &&
            !finishedStatuses.includes(d.status) &&
            d.status !== 'pending'
          ).sort((a, b) => (a.stop_order || 999) - (b.stop_order || 999));
          
          const incompletePickups = pickupMarkers.filter(p => 
            p && 
            p.driver_id === currentUser?.id &&
            !finishedStatuses.includes(p.status) &&
            p.status !== 'pending'
          ).sort((a, b) => (a.stop_order || 999) - (b.stop_order || 999));
          
          // Combine and get the first (next) stop
          const allIncompleteStops = [...incompletePickups, ...incompleteDeliveries]
            .sort((a, b) => (a.stop_order || 999) - (b.stop_order || 999));
          
          const nextStop = allIncompleteStops[0];
          
          if (!nextStop) return null;
          
          // CRITICAL: Determine the starting point for the blue dashed line
          // Priority: 1) Live driver location, 2) Last completed stop, 3) Driver's home location
          let startPoint = null;
          
          // 1) Check for live driver location (blue dot)
          if (currentDriverLocation?.latitude && currentDriverLocation?.longitude) {
            startPoint = [currentDriverLocation.latitude, currentDriverLocation.longitude];
          }
          
          // 2) If no live location, check for shared driver marker (driverLocationMarkers)
          if (!startPoint) {
            const sharedDriverMarker = driverLocationMarkers.find(m => m.driver?.id === currentUser?.id);
            if (sharedDriverMarker?.latitude && sharedDriverMarker?.longitude) {
              startPoint = [sharedDriverMarker.latitude, sharedDriverMarker.longitude];
            }
          }
          
          // 3) If still no location, check for completed stops (use last completed)
          if (!startPoint) {
            const allDriverStops = [...deliveryMarkers, ...pickupMarkers].filter(d => 
              d && d.driver_id === currentUser?.id
            );
            const completedStops = allDriverStops
              .filter(s => finishedStatuses.includes(s.status) && s.actual_delivery_time)
              .sort((a, b) => new Date(b.actual_delivery_time) - new Date(a.actual_delivery_time));
            
            if (completedStops.length > 0) {
              const lastCompleted = completedStops[0];
              startPoint = [lastCompleted.latitude, lastCompleted.longitude];
            }
          }
          
          // 4) If no completed stops, use driver's home location
          if (!startPoint && currentUser?.home_latitude && currentUser?.home_longitude) {
            startPoint = [currentUser.home_latitude, currentUser.home_longitude];
          }
          
          // If we still don't have a start point, don't draw the line
          if (!startPoint) return null;
          
          return (
            <Polyline
              key={`driver-to-next-stop-${nextStop.id}`}
              positions={[
                startPoint,
                [nextStop.latitude, nextStop.longitude]
              ]}
              pathOptions={{
                color: '#3B82F6', // Blue
                weight: 4,
                opacity: 0.7,
                dashArray: '10, 5', // Dashed line
                lineJoin: 'round',
                lineCap: 'round'
              }}
              pane="overlayPane"
            />
          );
        })()}

        {/* Draw Routes - NOW WITH INTERACTIVE HIGHLIGHTING */}
        {showRoutes && driverRoutes.map((route, index) => {
          const isHighlighted = highlightedRouteId === route.driverId;
          const isOtherDriverRoute = isDriverViewingSelfToday && route.driverId !== currentUser?.id; // NEW
          const routeWeight = isHighlighted ? route.routeWeight * 2 : route.routeWeight;
          const routeOpacity = isOtherDriverRoute ? 0.75 : (isHighlighted ? 1 : route.routeOpacity); // NEW: Fade other driver routes

          return [
            // Origin to first stop line - HIDDEN if currentToNextPolyline exists or route is completed
            // CRITICAL: This internal origin line is now DEPRECATED - we use currentToNextPolyline from backend instead
            null,

            // Pre-route line - DEPRECATED - handled by separate blue dashed line section below
            null,

            // Main route line - NOW INTERACTIVE
            route.coordinates.length >= 2 &&
            <Polyline
              key={`route-line-${route.driverId}-${index}`}
              positions={route.coordinates}
              pathOptions={{
                color: route.color,
                weight: routeWeight,
                opacity: routeOpacity,
                dashArray: isOtherDriverRoute ? '5, 5' : (route.hasPickup ? '10, 5' : '10, 10'), // NEW: Dashed for other drivers
                lineJoin: 'round',
                lineCap: 'round'
              }}
              eventHandlers={{
                click: () => setHighlightedRouteId(isHighlighted ? null : route.driverId),
                mouseover: () => setHighlightedRouteId(route.driverId),
                mouseout: () => setHighlightedRouteId(null)
              }}>
              <Popup closeButton={false} className="route-popup">
                <div className="text-xs">
                  <p className="font-semibold" style={{ color: 'var(--text-slate-900)' }}>{route.driverName}</p>
                  <p style={{ color: 'var(--text-slate-600)' }}>{route.totalStops} stops</p>
                  {route.isCompleted && <p className="text-emerald-600 font-medium">✓ Route Complete</p>}
                </div>
              </Popup>
            </Polyline>,

            // Waypoint circles
            ...(route.showWaypoints && route.coordinates.length >= 2 ? route.coordinates.map((coord, idx) => {
              if (idx === 0 || idx === route.coordinates.length - 1) return null;
              return (
                <Circle
                  key={`route-point-${route.driverId}-${idx}`}
                  center={coord}
                  radius={3}
                  pathOptions={{
                    color: route.color,
                    fillColor: route.color,
                    fillOpacity: isHighlighted ? 1 : 0.8,
                    weight: 1
                  }} />);


            }).filter(Boolean) : []),

            // Home route line - INTERACTIVE - HIDE for other drivers when viewing self today
            (() => {
              if (!route.shouldShowHomeRoute || !route.lastStopCoordinates || !route.driver?.home_latitude || !route.driver?.home_longitude) return null;
              
              // NEW: Skip home route for other drivers when viewing self today
              if (isOtherDriverRoute) return null;

              const homeCoordinates = [route.driver.home_latitude, route.driver.home_longitude];
              return (
                <Polyline
                  key={`home-route-${route.driverId}`}
                  positions={[route.lastStopCoordinates, homeCoordinates]}
                  pathOptions={{
                    color: route.color,
                    weight: routeWeight,
                    opacity: (isHighlighted ? 1 : routeOpacity) * 0.75,
                    dashArray: '5, 10',
                    lineJoin: 'round',
                    lineCap: 'round'
                  }}
                  eventHandlers={{
                    click: () => setHighlightedRouteId(isHighlighted ? null : route.driverId),
                    mouseover: () => setHighlightedRouteId(route.driverId),
                    mouseout: () => setHighlightedRouteId(null)
                  }} />);
            })()];

        })}

        {/* NEW: Fanning radius lines (thick, solid, grey) - UNIFIED for all markers */}
        {fannedLocationKey && (() => {
          const pickupsAtLocation = groupedPickupMarkers.get(fannedLocationKey) || [];
          const deliveriesAtLocation = groupedDeliveryMarkers.get(fannedLocationKey) || [];
          const allMarkersAtLocation = [...pickupsAtLocation, ...deliveriesAtLocation]
            .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
          
          return allMarkersAtLocation.map((marker, idx) => {
            const [originalLat, originalLng] = fannedLocationKey.split(',').map(Number);
            const [fannedLat, fannedLng] = calculateFannedPosition(
              originalLat,
              originalLng,
              idx,
              allMarkersAtLocation.length,
              marker.stop_order
            );
            return (
              <Polyline
                key={`radius-${marker.markerType}-${marker.id}-${idx}`}
                positions={[
                  [originalLat, originalLng],
                  [fannedLat, fannedLng]
                ]}
                pathOptions={{
                  color: "#64748b", // slate-500
                  weight: 4,
                  opacity: 1,
                  dashArray: ""
                }}
                pane="overlayPane" // Render on overlay pane for Z-index control
              />
            );
          });
        })()}

        {(() => {
          if (!currentDriverMarker) return null;
          
          return (
            <Marker
              key="current-driver-location"
              position={[currentDriverMarker.latitude, currentDriverMarker.longitude]}
              icon={createLiveLocationDot()}
              zIndexOffset={-1000}
              eventHandlers={{
                click: () => onMarkerClick && onMarkerClick(currentDriverMarker, 'driver'),
                mouseover: (e) => {
                  e.target.openPopup();
                },
                mouseout: (e) => {
                  e.target.closePopup();
                }
              }}>

              <Popup
                autoPan={false}
                closeButton={false}
                offset={[0, -10]}
                className="custom-popup">

                <div className="min-w-[150px]">
                  <div className="flex items-center gap-1.5">
                    <Navigation className="w-3.5 h-3.5 text-blue-600" />
                    <h3 className="font-semibold text-xs">Your Location</h3>
                  </div>
                  <div className="text-[10px] text-blue-600 mt-1 font-medium flex items-center gap-1">
                    <Activity className="w-3 h-3 animate-pulse" />
                    Live GPS
                  </div>
                  {currentDriverMarker.timestamp &&
                    <div className="flex items-center gap-1 mt-1 text-[11px] text-gray-600">
                      <Clock className="w-3 h-3" />
                      Updated: {format(new Date(currentDriverMarker.timestamp), 'HH:mm:ss')}
                    </div>
                  }
                </div>
              </Popup>
            </Marker>
          );
        })()}

        {/* Store Pickup Markers - NOW WITH FANNING AND HIGHLIGHT HALOS */}
        {pickupMarkers.map((pickup, index) => {
          const locationKey = `${pickup.latitude.toFixed(6)},${pickup.longitude.toFixed(6)}`;
          const isClustered = pickup.duplicateCount > 1;
          const isFanned = fannedLocationKey === locationKey;
          const isHighlighted = highlightedDeliveryId === pickup.id;
          
          // Calculate position based on fanning state
          let markerPosition = [pickup.latitude, pickup.longitude];
          let dynamicZIndex;
          
          const isFinished = FINISHED_STATUSES.includes(pickup.status);
          const isPending = pickup.status === 'pending';

          if (isPending) {
            // Rule 0: Pending markers ALWAYS on top (highest z-index)
            dynamicZIndex = 5000 + (500 - (pickup.number || 500));
          } else if (isFinished) {
            // Rule 2: Finished markers are at the bottom.
            // Order them by stop order so #1 is still on top of #2 if both are finished.
            dynamicZIndex = 100 + (500 - (pickup.number || 500));
          } else {
            // Rule 1: Reverse stop order for active markers.
            dynamicZIndex = 1000 + (500 - (pickup.number || 500));
          }
          
          if (isFanned && isClustered) {
            // FIXED: Get ALL markers (pickups AND deliveries) at this location
            const pickupsAtLocation = groupedPickupMarkers.get(locationKey) || [];
            const deliveriesAtLocation = groupedDeliveryMarkers.get(locationKey) || [];
            const allMarkersAtLocation = [...pickupsAtLocation, ...deliveriesAtLocation]
              .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
            
            const clusterIndex = allMarkersAtLocation.findIndex(p => p.id === pickup.id);
            markerPosition = calculateFannedPosition(
              pickup.latitude, 
              pickup.longitude, 
              clusterIndex, 
              allMarkersAtLocation.length,
              pickup.stop_order
            );
            
            // Calculate z-index: incomplete stops first, then by stop_order
            const isFinished = FINISHED_STATUSES.includes(pickup.status);
            const incompleteMarkers = allMarkersAtLocation.filter(p => !FINISHED_STATUSES.includes(p.status));
            
            if (isFinished) {
              // Finished stops get lower z-index
              dynamicZIndex = 2000 - allMarkersAtLocation.length - clusterIndex;
            } else {
              // Incomplete stops: lowest stop_order gets highest z-index
              const incompleteIndex = incompleteMarkers.findIndex(p => p.id === pickup.id);
              dynamicZIndex = 3000 + (incompleteMarkers.length - incompleteIndex);
            }
          }
          
          return [
            currentZoom >= ZOOM_LEVELS.HIDE_CIRCLES && !isFanned &&
            <Circle
              key={`pickup-circle-${pickup.id}`}
              center={[pickup.latitude, pickup.longitude]}
              radius={2500}
              pathOptions={{
                color: pickup.pinColor,
                fillColor: pickup.pinColor,
                fillOpacity: 0.05,
                weight: 2,
                opacity: 0.2
              }} />,
            
            // Tiny pulsating halo for highlighted pickup markers
            isHighlighted && !isFanned &&
            <Circle
              key={`pickup-halo-${pickup.id}`}
              center={[pickup.latitude, pickup.longitude]}
              radius={40}
              pathOptions={{
                color: pickup.pinColor,
                fillColor: 'transparent',
                fillOpacity: 0,
                weight: 2,
                opacity: 0.9,
                className: 'pulsating-halo'
              }} />,

            <Marker
              key={`pickup-${pickup.id}`}
              position={markerPosition}
              icon={pickup.useSimpleCircle ? createSimpleCircleIcon(pickup.status, pickup.status === 'pending' ? null : pickup.number, currentZoom, isMobile, pickup.pinColor, pickup.isOtherDriver) : createStoreIcon(
                pickup.status, 
                pickup.pinColor, 
                isFanned, 
                pickup.status === 'pending' ? null : pickup.number, 
                currentZoom,
                pickup.duplicateCount,
                isMobile,
                highlightedDeliveryId === pickup.id,
                pickup.isNextDelivery,
                hasIncompleteStops,
                pickup.isOtherDriver // NEW
              )}
              zIndexOffset={dynamicZIndex}
              draggable={!pickup.useSimpleCircle && !pickup.isOtherDriver}
              eventHandlers={pickup.isOtherDriver ? {
                click: (e) => {
                  L.DomEvent.stopPropagation(e);
                },
                mouseover: (e) => e.target.openPopup(),
                mouseout: (e) => e.target.closePopup()
              } : pickup.useSimpleCircle ? {
                click: (e) => {
                  L.DomEvent.stopPropagation(e);
                }
              } : {
                click: (e) => {
                  L.DomEvent.stopPropagation(e);
                  handleMarkerClickForFanning(pickup, 'pickup');
                },
                mouseover: (e) => e.target.openPopup(),
                mouseout: (e) => e.target.closePopup(),
                dragend: (e) => handleMarkerDragEnd(pickup.id, e, 'pickup')
              }}
              ref={(ref) => {
                if (ref) {
                  markerRefs.current[`pickup-${pickup.id}`] = ref;
                }
              }}>

              {/* Show popup for non-clustered markers or expanded cluster markers */}
              {!pickup.useSimpleCircle && !pickup.isOtherDriver && (
                isClustered && !isFanned ? (
                  // Clustered markers show unified popup with all marker info
                  <Popup autoPan={true} autoPanPadding={[50, 50]} closeButton={false} offset={[0, -20]} className="custom-popup">
                    <div className="min-w-[200px] max-w-[300px] space-y-2">
                      <div className="font-semibold text-sm pb-1 border-b" style={{ color: 'var(--text-slate-900)', borderColor: 'var(--border-slate-200)' }}>
                        {pickup.duplicateCount} stops at this location
                      </div>
                      {(() => {
                        const locationKey = `${pickup.latitude.toFixed(6)},${pickup.longitude.toFixed(6)}`;
                        const pickupsAtLocation = groupedPickupMarkers.get(locationKey) || [];
                        const deliveriesAtLocation = groupedDeliveryMarkers.get(locationKey) || [];
                        const allMarkersAtLocation = [...pickupsAtLocation, ...deliveriesAtLocation]
                          .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
                        
                        return allMarkersAtLocation.map((m, idx) => {
                          const isFinished = FINISHED_STATUSES.includes(m.status);
                          const finishedTime = m.actual_delivery_time ? format(new Date(m.actual_delivery_time), 'HH:mm') : null;
                          
                          return (
                            <div key={`cluster-item-${m.id}`} className="text-xs py-1 border-b last:border-0" style={{ borderColor: 'var(--border-slate-200)' }}>
                              <div className="font-medium" style={{ color: 'var(--text-slate-900)' }}>
                                #{m.number || m.stop_order} - {m.markerType === 'pickup' ? m.store?.name : m.patient?.full_name}
                              </div>
                              {isFinished && finishedTime ? (
                                <div className="flex items-center gap-1 text-[11px] text-emerald-600">
                                  <Clock className="w-3 h-3" />
                                  {finishedTime}
                                </div>
                              ) : m.delivery_time_eta ? (
                                <div className="text-[11px]" style={{ color: 'var(--text-slate-600)' }}>
                                  ETA: {m.delivery_time_eta}
                                </div>
                              ) : null}
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </Popup>
                ) : (
                  // Non-clustered or fanned markers show full details
                  <Popup autoPan={true} autoPanPadding={[50, 50]} closeButton={false} offset={[0, -20]} className="custom-popup">
                    <DeliveryPopup delivery={pickup} isPickup={true} />
                  </Popup>
                )
              )}
              {/* NEW: Simple popup for other drivers' pickups */}
              {pickup.isOtherDriver && (
                <Popup autoPan={true} autoPanPadding={[50, 50]} closeButton={false} offset={[0, -20]} className="custom-popup">
                  <div className="min-w-[150px] space-y-1.5">
                    <div className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: 'var(--text-slate-900)' }}>
                      <Truck className="w-3.5 h-3.5" />
                      {pickup.driver?.user_name || 'Unknown'}
                    </div>
                    <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-slate-600)' }}>
                      <Home className="w-3.5 h-3.5" />
                      {pickup.store?.name || 'Store'}
                    </div>
                    {(() => {
                      const isFinished = FINISHED_STATUSES.includes(pickup.status);
                      const finishedTime = pickup.actual_delivery_time ? format(new Date(pickup.actual_delivery_time), 'HH:mm') : null;
                      
                      if (isFinished && finishedTime) {
                        return (
                          <div className="flex items-center gap-1 text-xs text-emerald-600">
                            <Clock className="w-3.5 h-3.5" />
                            {finishedTime}
                          </div>
                        );
                      } else if (pickup.delivery_time_eta) {
                        return (
                          <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-slate-600)' }}>
                            ETA: {pickup.delivery_time_eta}
                          </div>
                        );
                      }
                      return null;
                    })()}
                  </div>
                </Popup>
              )}
            </Marker>
          ];
        })}

        {/* Patient Delivery Markers - NOW WITH FANNING AND HIGHLIGHT HALOS */}
        {deliveryMarkers.map((delivery, index) => {
          const locationKey = `${delivery.latitude.toFixed(6)},${delivery.longitude.toFixed(6)}`;
          const isClustered = delivery.duplicateCount > 1;
          const isFanned = fannedLocationKey === locationKey;
          const isHighlighted = highlightedDeliveryId === delivery.id;
          
          // Calculate position based on fanning state
          let markerPosition = [delivery.latitude, delivery.longitude];
          let dynamicZIndex;

          const isFinished = FINISHED_STATUSES.includes(delivery.status);
          const isNext = delivery.isNextInLine;
          const isPending = delivery.status === 'pending';

          if (isPending) {
            // Rule 0: Pending markers ALWAYS on top (highest z-index)
            dynamicZIndex = 5000 + (500 - (delivery.number || 500));
          } else if (isFinished) {
            dynamicZIndex = 100 + (500 - (delivery.number || 500));
          } else {
            dynamicZIndex = 1000 + (500 - (delivery.number || 500));
          }
          
          // Rule 3: Next marker is on top of everything except pending.
          if (isNext && !isPending) {
            dynamicZIndex = 2000;
          }
          
          if (isFanned && isClustered) {
            // FIXED: Get ALL markers (pickups AND deliveries) at this location
            const pickupsAtLocation = groupedPickupMarkers.get(locationKey) || [];
            const deliveriesAtLocation = groupedDeliveryMarkers.get(locationKey) || [];
            const allMarkersAtLocation = [...pickupsAtLocation, ...deliveriesAtLocation]
              .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
            
            const clusterIndex = allMarkersAtLocation.findIndex(d => d && d.id === delivery.id);
            markerPosition = calculateFannedPosition(
              delivery.latitude, 
              delivery.longitude, 
              clusterIndex, 
              allMarkersAtLocation.length,
              delivery.stop_order
            );
            
            // Calculate z-index: incomplete stops first, then by stop_order
            const isFinished = FINISHED_STATUSES.includes(delivery.status);
            const incompleteMarkers = allMarkersAtLocation.filter(d => !FINISHED_STATUSES.includes(d.status));
            
            if (isFinished) {
              // Finished stops get lower z-index
              dynamicZIndex = 2000 - allMarkersAtLocation.length - clusterIndex;
            } else {
              // Incomplete stops: lowest stop_order gets highest z-index
              const incompleteIndex = incompleteMarkers.findIndex(d => d.id === delivery.id);
              dynamicZIndex = 3000 + (incompleteMarkers.length - incompleteIndex);
            }
          }
          
          return [
            // Tiny pulsating halo for highlighted delivery markers
            isHighlighted && !isFanned &&
            <Circle
              key={`delivery-halo-${delivery.id}`}
              center={[delivery.latitude, delivery.longitude]}
              radius={40}
              pathOptions={{
                color: delivery.pinColor,
                fillColor: 'transparent',
                fillOpacity: 0,
                weight: 2,
                opacity: 0.9,
                className: 'pulsating-halo'
              }} />,
            
            // Tiny pulsating halo for highlighted delivery's store marker
            isHighlighted && !isFanned && delivery.store_id && (() => {
              const deliveryStore = stores.find(s => s?.id === delivery.store_id);
              if (!deliveryStore?.latitude || !deliveryStore?.longitude) return null;
              return (
                <Circle
                  key={`delivery-store-halo-${delivery.id}`}
                  center={[deliveryStore.latitude, deliveryStore.longitude]}
                  radius={40}
                  pathOptions={{
                    color: delivery.pinColor,
                    fillColor: 'transparent',
                    fillOpacity: 0,
                    weight: 2,
                    opacity: 0.9,
                    className: 'pulsating-halo'
                  }}
                />
              );
            })(),
            
            <Marker
              key={`delivery-${delivery.id}`}
              position={markerPosition}
              icon={delivery.useSimpleCircle ? createSimpleCircleIcon(delivery.status, delivery.status === 'pending' ? null : delivery.number, currentZoom, isMobile, delivery.pinColor, delivery.isOtherDriver) : createDeliveryIcon(
                delivery.status,
                delivery.pinColor,
                isFanned,
                delivery.status === 'pending' ? null : delivery.number,
                delivery.isFirstTime,
                delivery.duplicateCount,
                currentZoom,
                isMobile,
                delivery.isNextInLine,
                isHighlighted,
                hasIncompleteStops,
                delivery.ampm_deliveries === 'PM', // CRITICAL: Pass PM flag
                delivery.isOtherDriver // NEW
              )}
              zIndexOffset={dynamicZIndex}
              draggable={!delivery.useSimpleCircle && !delivery.isOtherDriver}
              eventHandlers={delivery.isOtherDriver ? {
                click: (e) => {
                  L.DomEvent.stopPropagation(e);
                },
                mouseover: (e) => e.target.openPopup(),
                mouseout: (e) => e.target.closePopup()
              } : delivery.useSimpleCircle ? {
                click: (e) => {
                  L.DomEvent.stopPropagation(e);
                }
              } : {
                click: (e) => {
                  L.DomEvent.stopPropagation(e);
                  handleMarkerClickForFanning(delivery, 'delivery');
                },
                mouseover: (e) => e.target.openPopup(),
                mouseout: (e) => e.target.closePopup(),
                dragend: (e) => handleMarkerDragEnd(delivery.id, e, 'delivery')
              }}
              ref={(ref) => {
                if (ref) {
                  markerRefs.current[`delivery-${delivery.id}`] = ref;
                }
              }}>

              {/* Show popup for non-clustered markers or expanded cluster markers */}
              {!delivery.useSimpleCircle && !delivery.isOtherDriver && (
                isClustered && !isFanned ? (
                  // Clustered markers show unified popup with all marker info
                  <Popup autoPan={true} autoPanPadding={[50, 50]} closeButton={false} offset={[0, -20]} className="custom-popup">
                    <div className="min-w-[200px] max-w-[300px] space-y-2">
                      <div className="font-semibold text-sm pb-1 border-b" style={{ color: 'var(--text-slate-900)', borderColor: 'var(--border-slate-200)' }}>
                        {delivery.duplicateCount} stops at this location
                      </div>
                      {(() => {
                        const locationKey = `${delivery.latitude.toFixed(6)},${delivery.longitude.toFixed(6)}`;
                        const pickupsAtLocation = groupedPickupMarkers.get(locationKey) || [];
                        const deliveriesAtLocation = groupedDeliveryMarkers.get(locationKey) || [];
                        const allMarkersAtLocation = [...pickupsAtLocation, ...deliveriesAtLocation]
                          .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
                        
                        return allMarkersAtLocation.map((m, idx) => {
                          const isFinished = FINISHED_STATUSES.includes(m.status);
                          const finishedTime = m.actual_delivery_time ? format(new Date(m.actual_delivery_time), 'HH:mm') : null;
                          
                          return (
                            <div key={`cluster-item-${m.id}`} className="text-xs py-1 border-b last:border-0" style={{ borderColor: 'var(--border-slate-200)' }}>
                              <div className="font-medium" style={{ color: 'var(--text-slate-900)' }}>
                                #{m.number || m.stop_order} - {m.markerType === 'pickup' ? m.store?.name : m.patient?.full_name}
                              </div>
                              {isFinished && finishedTime ? (
                                <div className="flex items-center gap-1 text-[11px] text-emerald-600">
                                  <Clock className="w-3 h-3" />
                                  {finishedTime}
                                </div>
                              ) : m.delivery_time_eta ? (
                                <div className="text-[11px]" style={{ color: 'var(--text-slate-600)' }}>
                                  ETA: {m.delivery_time_eta}
                                </div>
                              ) : null}
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </Popup>
                ) : (
                  // Non-clustered or fanned markers show full details
                  <Popup autoPan={true} autoPanPadding={[50, 50]} closeButton={false} offset={[0, -20]} className="custom-popup">
                    <DeliveryPopup delivery={delivery} isPickup={false} />
                  </Popup>
                )
              )}
              {/* NEW: Simple popup for other drivers' deliveries */}
              {delivery.isOtherDriver && (
                <Popup autoPan={true} autoPanPadding={[50, 50]} closeButton={false} offset={[0, -20]} className="custom-popup">
                  <div className="min-w-[150px] space-y-1.5">
                    <div className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: 'var(--text-slate-900)' }}>
                      <Truck className="w-3.5 h-3.5" />
                      {delivery.driver?.user_name || 'Unknown'}
                    </div>
                    <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-slate-600)' }}>
                      <Package className="w-3.5 h-3.5" />
                      {delivery.patient?.full_name || 'Patient'}
                    </div>
                    <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-slate-600)' }}>
                      <Home className="w-3.5 h-3.5" />
                      {delivery.store?.name || 'Store'}
                    </div>
                    {(delivery.delivery_time_eta || delivery.delivery_time_start || delivery.actual_delivery_time) && (
                      <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-slate-600)' }}>
                        <Clock className="w-3.5 h-3.5" />
                        {delivery.actual_delivery_time 
                          ? format(new Date(delivery.actual_delivery_time), 'HH:mm')
                          : (delivery.delivery_time_eta || delivery.delivery_time_start)}
                      </div>
                    )}
                  </div>
                </Popup>
              )}
            </Marker>
          ];
        })}

        {/* Driver Location Markers - Green for on_duty, Orange for on_break, with driver initial */}
        {/* Orange outer ring indicates stale location (>5 minutes old) */}
        {/* Blue outer ring for drivers on break viewing their own location from other devices */}
        {driverLocationMarkers.map((location) => {
          const statusLabel = location.driver_status === 'on_duty' ? 'On Duty' : 'On Break';
          const statusColor = location.driver_status === 'on_duty' ? 'text-emerald-600' : 'text-orange-600';
          const isOnBreakSelf = location.isOnBreak === true;
          
          return (
            <Marker
              key={`driver-location-${location.id || location.user_id}`}
              position={[location.latitude, location.longitude]}
              icon={createDriverIcon(location.driver_status, location.driverInitial, location.isStaleLocation, isOnBreakSelf)}
              zIndexOffset={3000}
              eventHandlers={{
                click: () => onMarkerClick && onMarkerClick(location, 'driver'),
                mouseover: (e) => {
                  e.target.openPopup();
                },
                mouseout: (e) => {
                  e.target.closePopup();
                }
              }}>

              <Popup
                autoPan={false}
                closeButton={false}
                offset={[0, -20]}
                className="custom-popup">

                <div className="min-w-[150px]">
                  <div className="flex items-center gap-1.5">
                    <Car className="w-3.5 h-3.5 text-indigo-600" />
                    <h3 className="font-semibold text-xs">
                      {location.isSelf ? 'Your Phone' : location.driverName}
                    </h3>
                  </div>
                  <div className={`text-[10px] mt-1 font-medium flex items-center gap-1 ${statusColor}`}>
                    <Activity className="w-3 h-3 animate-pulse" />
                    {statusLabel}
                  </div>
                  {isOnBreakSelf && (
                    <div className="text-[10px] mt-1 font-medium text-blue-600">
                      ☕ Viewing from other device
                    </div>
                  )}
                  {location.isStaleLocation && (
                    <div className="text-[10px] mt-1 font-medium text-orange-600">
                      ⚠️ Location stale (&gt;5 min)
                    </div>
                  )}
                  {location.location_updated_at &&
                    <div className="flex items-center gap-1 mt-1 text-[11px] text-gray-600">
                      <Clock className="w-3 h-3" />
                      {format(new Date(location.location_updated_at), 'HH:mm:ss')}
                    </div>
                  }
                </div>
              </Popup>
            </Marker>
          );
        })}



        {/* NEW: Driver Home Location Markers - Only for active routes */}
        {driverHomeMarkers.map((home) =>
          <Marker
            key={home.id}
            position={[home.latitude, home.longitude]}
            icon={createHomeIcon(home.driverColor)}
            eventHandlers={{
              click: () => onMarkerClick && onMarkerClick(home, 'home'),
              mouseover: (e) => {
                e.target.openPopup();
              },
              mouseout: (e) => {
                e.target.closePopup();
              }
            }}>

            <Popup
              autoPan={false}
              closeButton={false}
              offset={[0, -20]}
              className="custom-popup">

              <div className="min-w-[150px]">
                <div className="flex items-center gap-1.5">
                  <Home className="w-3.5 h-3.5 text-emerald-600" />
                  <h3 className="font-semibold text-xs">{home.driverName}</h3>
                </div>
                <p className="text-[11px] text-gray-600 mt-1">Final Destination (Home)</p>
              </div>
            </Popup>
          </Marker>
        )}
      </MapContainer>

      {/* Map Crosshair Overlay - Always visible, non-interactive */}
      <MapCrosshair 
        stopCardsHeight={areStopCardsVisible ? stopCardsHeight : 0}
        statsCardHeight={isMobile ? (isStatsCardExpanded ? 216 : 116) : 0}
        isMobile={isMobile} />

      {/* NEW: Zoom Level Overlay */}
      {showZoomOverlay &&
        <div className="absolute top-4 left-4 z-[99999] px-4 py-2 rounded-lg shadow-lg transition-opacity duration-300 pointer-events-none" style={{ background: 'var(--text-slate-900)', color: 'var(--bg-white)' }}>
          <div className="flex items-center gap-2">
            {/* <span className="text-sm font-medium">Zoom Level:</span> */}
            <span className="text-lg font-bold">{currentZoom.toFixed(1)}</span>
          </div>
        </div>
      }

      {/* Driver Legend - Shows driver colors when in "All Drivers" mode */}
      {showLegend && driverRoutes.length > 0 && (
        <div
          ref={legendRef}
          className="absolute z-[10] pointer-events-auto transition-opacity duration-300"
          style={{
            top: isStatsCardExpanded ? '220px' : '120px',
            left: legendLeft ? `${legendLeft}px` : '50%',
            transform: legendLeft ? 'none' : 'translateX(-50%)'
          }}
          onMouseEnter={() => onLegendInteraction(true)}
          onMouseLeave={() => onLegendInteraction(false)}
        >
          <div className="backdrop-blur-sm rounded-lg shadow-lg border px-3 py-2" style={{ background: 'var(--bg-white)', opacity: 0.95, borderColor: 'var(--border-slate-200)' }}>
            <div className="flex flex-wrap gap-x-3 gap-y-1.5 items-center justify-center">
              {driverRoutes
                .sort((a, b) => a.sortOrder - b.sortOrder)
                .map((route) => (
                  <div
                    key={route.driverId}
                    className="flex items-center gap-1.5 cursor-pointer hover:opacity-70 transition-opacity"
                    onMouseEnter={() => setHighlightedRouteId(route.driverId)}
                    onMouseLeave={() => setHighlightedRouteId(null)}
                    onClick={() => setHighlightedRouteId(highlightedRouteId === route.driverId ? null : route.driverId)}
                  >
                    <div
                      className="w-3 h-3 rounded-full border-2 border-white shadow-sm flex-shrink-0"
                      style={{ backgroundColor: route.color }}
                    />
                    <span className="text-xs font-medium whitespace-nowrap" style={{ color: 'var(--text-slate-700)' }}>
                      {route.driverName}
                    </span>
                    <span className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
                      ({route.totalStops})
                    </span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}

      <style>{`
        .custom-popup .leaflet-popup-content-wrapper {
          padding: 6px;
          border-radius: 8px;
          box-shadow: 0 3px 14px var(--shadow-color);
          background: var(--bg-white);
          color: var(--text-slate-900);
        }
        .custom-popup .leaflet-popup-content {
          margin: 0;
          line-height: 1.3;
        }
        .custom-popup .leaflet-popup-tip {
          box-shadow: 0 3px 14px var(--shadow-color);
          background: var(--bg-white);
        }
        .leaflet-popup-pane {
          z-index: 10010 !important;
        }
        .leaflet-popup {
          z-index: 10010 !important;
        }
        .route-popup .leaflet-popup-content-wrapper {
          padding: 4px 8px;
          border-radius: 6px;
          box-shadow: 0 2px 8px var(--shadow-color);
          background: var(--bg-white);
          color: var(--text-slate-900);
          z-index: 999999;
        }
        .route-popup .leaflet-popup-content {
          margin: 0;
          line-height: 1.2;
        }
        .route-popup .leaflet-popup-tip {
          box-shadow: 0 2px 8px var(--shadow-color);
          background: var(--bg-white);
        }
        
        @keyframes pulseHalo {
          0%, 100% {
            stroke-width: 2;
            opacity: 0.85;
          }
          50% {
            stroke-width: 4;
            opacity: 0.3;
          }
        }
        
        .pulsating-halo {
          animation: pulseHalo 1s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
}