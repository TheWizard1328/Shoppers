import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import * as ReactExports from "react";
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMapEvents, Circle } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { getStoreColor, hexToRgba } from '../utils/colorGenerator';
import { sortUsers } from '../utils/sorting';
import MapModeControl from "./MapModeControl";
import { MapPin, Phone, Clock, Package, Truck, StickyNote, UserRoundSearch, Car, Home, Navigation, Activity, User, CheckCircle2, XCircle } from 'lucide-react';
import { userHasRole, isAppOwner } from '../utils/userRoles';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { format } from 'date-fns';
import { createRoot } from 'react-dom/client';
import { getStoredRouteCoordinates } from '../utils/routePolylineManager';
import { isMobileDevice } from '../utils/deviceUtils';
import MapCrosshair from './MapCrosshair';
import SpecialSymbolsBadges from '../utils/SpecialSymbolsBadges';
import { base44 } from '@/api/base44Client';
import { formatPhoneNumber } from '../utils/phoneFormatter';

// Fix for default icon issue with Webpack
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png'
});

// Driver color palette for "All Drivers" mode - 6 highly distinct colors
// Avoids: greens (completed status), reds/oranges (failed status), yellows
const DRIVER_COLORS = [
  '', // Index 0 - not used, to align with 1-based sort_order/hashing
  '#1E90FF', // Dodger Blue (Index 1)
  '#8A2BE2', // Blue Violet (Index 2)
  '#00CED1', // Dark Cyan/Teal (Index 3)
  '#FF69B4', // Hot Pink (Index 4)
  '#4B0082', // Indigo (Index 5)
  '#A0522D'  // Sienna - Reddish-Brown (Index 6)
];

// Helper function to determine text color for driver colors
const getDriverTextColor = (driverColor) => {
  // Light colors need black text for readability
  if (driverColor === '#00CED1' || driverColor === '#FF69B4') return 'black';
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

const createSimpleCircleIcon = (status, number, zoomLevel, isMobile = false, borderColor = 'white', isOtherDriver = false, clusterCount = 0) => {
  // Use caching to prevent icon re-creation causing pulsation
  const cacheKey = `${status}_${number}_${zoomLevel}_${isMobile}_${borderColor}_${isOtherDriver}_${clusterCount}`;
  
  if (simpleCircleIconCache.has(cacheKey)) {
    return simpleCircleIconCache.get(cacheKey);
  }
  
  const statusColors = {
    'pending': '#3B82F6', // Blue
    'Ready For Pickup': '#3B82F6', // Blue
    'in_transit': '#3B82F6', // Blue
    'en_route': '#3B82F6', // Blue
    'completed': '#059669', // Darker Green
    'delivered': '#059669', // Darker Green
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
  
  // NEW: Reduce size for other drivers' faded markers (but not as small as before)
  if (isOtherDriver) {
    baseSize *= 0.86; // 15% larger than previous 0.75
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
        border: ${isOtherDriver ? '3px' : '2px'} solid ${statusColor};
        opacity: ${isOtherDriver ? 0.75 : 1};
        position: relative;
      ">
        ${number || ''}
        ${clusterCount > 1 ? `
          <div style="
            position: absolute;
            top: -3px;
            right: -3px;
            background: #EF4444;
            border: 1px solid white;
            border-radius: 50%;
            width: 10px;
            height: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 6px;
            font-weight: bold;
            color: white;
            box-shadow: 0 1px 3px rgba(0,0,0,0.3);
            z-index: 10;
          ">${clusterCount}</div>
        ` : ''}
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
  if (!driver || typeof driver !== 'object' || !driver.id) {
    console.warn('[DeliveryMap] getDriverColor: Invalid driver or missing ID:', driver);
    return '#607D8B'; // Default blue-grey for invalid/unassigned
  }

  const numFixedColors = DRIVER_COLORS.length - 1; // Exclude the empty index 0

  let effectiveIndex;
  // Prioritize sort_order for fixed colors if provided and positive
  if (typeof driver.sort_order === 'number' && driver.sort_order > 0 && driver.sort_order <= numFixedColors) {
    effectiveIndex = driver.sort_order;
  } else {
    // If sort_order is missing, zero, or beyond fixed palette, use hash of ID for more consistent assignment
    let hash = 0;
    const idString = driver.id.toString();
    for (let i = 0; i < idString.length; i++) {
      hash = idString.charCodeAt(i) + ((hash << 5) - hash);
    }
    effectiveIndex = (Math.abs(hash) % numFixedColors) + 1; // Map hash to 1-based index within fixed palette
  }

  // Try to use a color from the fixed palette first
  // If the effectiveIndex maps to a valid slot in DRIVER_COLORS (1 to numFixedColors), use it.
  if (effectiveIndex >= 1 && effectiveIndex <= numFixedColors && DRIVER_COLORS[effectiveIndex]) {
    return DRIVER_COLORS[effectiveIndex];
  } else {
    // If sort_order maps to an index outside the fixed palette, or if there are more drivers than fixed colors
    // Generate an HSL color based on the hash of the driver ID
    // Restrict hues to cool colors only (avoid greens, reds, oranges, yellows)
    // Safe hue ranges: Blues (190-280), some purples/magentas (280-330)
    const idHash = Math.abs(driver.id.split('').reduce((acc, char) => (acc * 31) + char.charCodeAt(0), 0));
    const safeHueMin = 190; // Start from blue
    const safeHueRange = 140; // 190-330 gives us blues, cyans, purples, and magentas
    const hue = safeHueMin + (idHash % safeHueRange);
    return `hsl(${hue}, 70%, 50%)`; // Bright, vibrant colors with good saturation
  }
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
  
  // NEW: Reduce size for other drivers' faded markers (but not as small as before)
  if (isOtherDriver) {
    baseSize *= 0.86; // 15% larger than previous 0.75
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
const createDeliveryIcon = (status, storeColor = '#6B7280', isActive = false, number = null, isFirstTime = false, duplicateCount = 0, zoomLevel = 12, isMobile = false, isNextInLine = false, isHighlighted = false, hasIncompleteStops = true, isPM = false, isOtherDriver = false, isReturn = false) => {
  // CRITICAL: Returns take precedence over other statuses for color
  const isFinished = FINISHED_STATUSES.includes(status);
  const shouldShowNextBlue = isNextInLine && !isFinished && hasIncompleteStops;
  const isPending = status === 'pending';
  
  const statusColor = isReturn ? '#F97316' : (shouldShowNextBlue ? '#3B82F6' : getInnerSymbolColor(status, false));
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

  // NEW: Reduce size for other drivers' faded markers (but not as small as before)
  if (isOtherDriver) {
    baseSize *= 0.86; // 15% larger than previous 0.75
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
  let outerRingColor = '#94A3B8'; // Darker grey for white (fresh location)
  let outerRingWidth = 3; // +1px thicker
  
  if (isOnBreakSelf) {
    outerRingColor = '#1E40AF'; // Darker blue for on_break self
    outerRingWidth = 4; // +1px thicker
  } else if (isStaleLocation) {
    outerRingColor = '#EA580C'; // Darker orange for stale
    outerRingWidth = 4; // +1px thicker
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
  deliveriesForLocationFilter = [], // NEW: Deliveries for filtering shared location markers
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
  stopCardsHeight = 75, // Height of the stop cards container (passed from Dashboard)
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

  // CRITICAL: ALWAYS use users prop directly (contains fresh AppUser data from context)
  // Update immediately when users change - no complex comparison needed
  useEffect(() => {
    if (users && users.length > 0) {
      setRealtimeAppUsers(users);
    }
  }, [users]);

  // State to force re-render of driverRoutes when deliveries update
  const [routeRenderKey, setRouteRenderKey] = useState(0);

  // Listen for screen orientation/size changes to update map view based on current FAB phase
  useEffect(() => {
    if (!map) return;
    
    const handleResize = () => {
      console.log('🔄 [DeliveryMap] Screen resized - checking FAB phase for map update');
      
      // Dispatch event to trigger FAB phase re-application
      window.dispatchEvent(new CustomEvent('screenResized'));
    };
    
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);
    
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
    };
  }, [map]);

  // State to force re-render of polylines when driver locations change
  const [polylineRenderKey, setPolylineRenderKey] = useState(0);
  
  // Listen for real-time driver location updates from SmartRefreshManager
  useEffect(() => {
    const handleDriverLocationUpdate = (event) => {
      const { appUsers, singleUpdate } = event.detail;

      // CRITICAL: Handle single driver updates (from status toggle, etc.)
      if (singleUpdate) {
        setRealtimeAppUsers(prev => prev.map(u => 
          u?.id === singleUpdate.user_id ? { ...u, ...singleUpdate } : u
        ));
        // CRITICAL: Force polyline re-render when driver location changes
        setPolylineRenderKey(prev => prev + 1);
        // CRITICAL: Force delivery marker refresh to update status colors
        setRouteRenderKey(prev => prev + 1);
        console.log('🗺️ [DeliveryMap] Driver location updated - refreshing map markers and polylines');
        return;
      }

      // CRITICAL: Handle bulk updates (from smart refresh) - update immediately
      if (appUsers && appUsers.length > 0) {
        setRealtimeAppUsers(appUsers);
        // CRITICAL: Force polyline re-render when driver locations change
        setPolylineRenderKey(prev => prev + 1);
        // CRITICAL: Force delivery marker refresh to update status colors
        setRouteRenderKey(prev => prev + 1);
        console.log('🗺️ [DeliveryMap] Bulk driver locations updated - refreshing map markers and polylines');
      }
    };

    // NEW: Listen for delivery updates to force complete route recalculation
    const handleDeliveriesUpdate = (event) => {
      console.log('🗺️ [DeliveryMap] Deliveries updated - forcing route line recalculation');
      // CRITICAL: Clear cached routes to force full recalculation
      prevDriverRoutesRef.current = [];
      // Force re-render by incrementing BOTH keys
      setRouteRenderKey(prev => prev + 1);
      setPolylineRenderKey(prev => prev + 1);
    };

    // NEW: Listen for route optimization completion to refresh map
    const handleRouteOptimizationComplete = (event) => {
      console.log('🗺️ [DeliveryMap] Route optimization complete - refreshing map');
      prevDriverRoutesRef.current = [];
      setRouteRenderKey(prev => prev + 1);
      setPolylineRenderKey(prev => prev + 1);
    };

    window.addEventListener('driverLocationsUpdated', handleDriverLocationUpdate);
    window.addEventListener('deliveriesUpdated', handleDeliveriesUpdate);
    window.addEventListener('routeOptimizationComplete', handleRouteOptimizationComplete);
    return () => {
      window.removeEventListener('driverLocationsUpdated', handleDriverLocationUpdate);
      window.removeEventListener('deliveriesUpdated', handleDeliveriesUpdate);
      window.removeEventListener('routeOptimizationComplete', handleRouteOptimizationComplete);
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

  // CRITICAL: Listen for deliveriesImported event to refresh other drivers' markers
  useEffect(() => {
    const handleDeliveriesImported = (event) => {
      const { deliveries: importedDeliveries } = event.detail || {};
      
      // If deliveries array is provided, use it directly to update otherDriverDeliveries
      if (importedDeliveries && importedDeliveries.length > 0 && showOtherDriverDeliveries && currentUser) {
        console.log('📥 [DeliveryMap] Updating other drivers markers from import event');
        const others = importedDeliveries.filter(d => d && d.driver_id && d.driver_id !== currentUser.id);
        setOtherDriverDeliveries(others);
      }
    };
    
    window.addEventListener('deliveriesImported', handleDeliveriesImported);
    return () => window.removeEventListener('deliveriesImported', handleDeliveriesImported);
  }, [showOtherDriverDeliveries, currentUser?.id]);

  useEffect(() => {
    const fetchOtherDrivers = async () => {
      // CRITICAL: Fetch when showOtherDriverDeliveries is true (checkbox checked)
      // Works for ANY user viewing a specific driver (not just drivers viewing self)
      if (!selectedDate || !showOtherDriverDeliveries || !selectedDriverId || selectedDriverId === 'all') {
        // CRITICAL: Clear markers when checkbox is unchecked
        if (!showOtherDriverDeliveries && otherDriverDeliveries.length > 0) {
          console.log('📍 [DeliveryMap] Clearing other driver markers (checkbox unchecked)');
          setOtherDriverDeliveries([]);
        }
        return;
      }

      try {
        // CRITICAL: Load from offline DB first to prevent rate limiting
        const { offlineDB } = await import('./../../components/utils/offlineDatabase');
        let allDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDate);
        
        // Fallback to API if offline DB doesn't have data for this date
        if (!allDeliveries || allDeliveries.length === 0) {
          console.log(`📡 [DeliveryMap] Offline DB empty for ${selectedDate}, fetching from API`);
          const { base44 } = await import('@/api/base44Client');
          allDeliveries = await base44.entities.Delivery.filter({
            delivery_date: selectedDate
          });
          // Save to offline DB for future
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, allDeliveries);
        } else {
          console.log(`💾 [DeliveryMap] Loaded ${allDeliveries.length} deliveries from offline DB`);
        }
        
        // Filter to exclude the currently selected driver's deliveries
        const others = allDeliveries.filter(d => d && d.driver_id && d.driver_id !== selectedDriverId);
        console.log(`📍 [DeliveryMap] Setting ${others.length} other driver deliveries (excluding ${selectedDriverId})`);
        
        // CRITICAL: ALWAYS update to force React re-render - use new array reference
        setOtherDriverDeliveries([...others]);
      } catch (error) {
        console.error('❌ [DeliveryMap] Failed to load other drivers:', error);
      }
    };

    fetchOtherDrivers();
  }, [selectedDriverId, selectedDate, showOtherDriverDeliveries]);

  const { pickups, patientDeliveries } = useMemo(() => {
    let deliveriesToShow = safeDeliveries;
    
    // CRITICAL: Include other drivers' deliveries when showOtherDriverDeliveries is true (checkbox checked)
    // Works for ANY user viewing a specific driver (admin, driver, etc.)
    if (showOtherDriverDeliveries && otherDriverDeliveries.length > 0) {
      console.log(`📍 [DeliveryMap] Including ${otherDriverDeliveries.length} other driver deliveries`);
      
      // CRITICAL: De-duplicate by delivery ID to prevent duplicate markers
      const deliveriesById = new Map();
      
      // First, add all main deliveries
      safeDeliveries.forEach(d => {
        if (d && d.id) {
          deliveriesById.set(d.id, d);
        }
      });
      
      // Then, add other drivers' deliveries (won't override existing)
      otherDriverDeliveries.forEach(d => {
        if (d && d.id && !deliveriesById.has(d.id)) {
          deliveriesById.set(d.id, d);
        }
      });
      
      deliveriesToShow = Array.from(deliveriesById.values());
      console.log(`📍 [DeliveryMap] De-duplicated to ${deliveriesToShow.length} total deliveries`);
    }
    
    const pickups = deliveriesToShow.filter((d) => d && !d.patient_id && d.store_id);
    const patientDeliveries = deliveriesToShow.filter((d) => d && d.patient_id);
    return { pickups, patientDeliveries };
  }, [safeDeliveries, otherDriverDeliveries, showOtherDriverDeliveries]);

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

  // CRITICAL: FREEZE driver order on FIRST component mount - NEVER recalculate
  // Don't use useMemo—compute once via ref and always return cached result
  const frozenDriverOrderRef = useRef(null);
  
  if (!frozenDriverOrderRef.current) {
    const drivers = safeUsers.filter(u => u && typeof u === 'object' && u.id);
    drivers.sort((a, b) => {
      const sortA = a.sort_order ?? Infinity;
      const sortB = b.sort_order ?? Infinity;
      if (sortA !== sortB) return sortA - sortB;
      const nameA = (a.user_name || a.full_name || '').toLowerCase();
      const nameB = (b.user_name || b.full_name || '').toLowerCase();
      return nameA.localeCompare(nameB);
    });
    frozenDriverOrderRef.current = drivers;
  }
  
  const stableSortedDrivers = frozenDriverOrderRef.current || [];

  // CRITICAL: Create stable driver lookup map using SORTED drivers
  const driverLookupMap = useMemo(() => {
    const map = new Map();
    
    stableSortedDrivers.forEach(u => {
      map.set(u.id, u);
    });
    
    return map;
  }, [stableSortedDrivers]);

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
      // Use lookup map first, then fallback to denormalized driver name
      const enrichedDriver = driverLookupMap.get(delivery.driver_id) || driver || (delivery.driver_name ? { 
        id: delivery.driver_id, 
        user_name: delivery.driver_name,
        full_name: delivery.driver_name 
      } : null);

      const isFirstTime = isFirstTimeDelivery(delivery);
      
      // CRITICAL: Check if this is a return delivery (patient name contains "Return")
      const patientNameLower = (patient?.full_name || delivery.patient_name || '').toLowerCase();
      const isReturn = patientNameLower.includes('return') || patientNameLower.includes('(rtn)');

      const isCurrentUserDispatcher = userHasRole(currentUser, 'dispatcher');
      const isStopInDispatcherStore = isCurrentUserDispatcher && currentUser.store_ids && store && currentUser.store_ids.includes(store.id);
      const useSimpleCircle = isCurrentUserDispatcher && !isStopInDispatcherStore;

      // CRITICAL: Use backend isNextDelivery flag for blue marker circle
      const isNextInLine = delivery.isNextDelivery || false;
      
      // CRITICAL: Track delivery status and isNextDelivery in stable key
      const stableKey = `${delivery.id}:${delivery.status}:${isNextInLine}:${delivery.stop_order}`;

      // CRITICAL: Check if delivery has a pickup by looking at PUID in ASSIGNED DRIVER'S route
      // Check in both safeDeliveries (current route data) AND allDeliveriesForDate (full data for date)
      let hasNoPickup = false;
      if (delivery.patient_id) {
        // If no PUID at all, definitely no pickup
        if (!delivery.puid || delivery.puid.trim() === '') {
          hasNoPickup = true;
        } else {
          // CRITICAL: Check BOTH safeDeliveries AND allDeliveriesForDate to prevent blinking during smart refresh
          // When smart refresh runs, safeDeliveries may temporarily be empty/incomplete
          const pickupExistsInRoute = safeDeliveries.some(d => 
            d && 
            !d.patient_id && 
            d.stop_id === delivery.puid &&
            d.driver_id === delivery.driver_id
          );
          
          const pickupExistsInAllData = safeAllDeliveriesForDate.some(d => 
            d && 
            !d.patient_id && 
            d.stop_id === delivery.puid &&
            d.driver_id === delivery.driver_id
          );
          
          hasNoPickup = !pickupExistsInRoute && !pickupExistsInAllData;
        }
      }

      // CRITICAL: Determine if this marker belongs to another driver
      // Works for ANY user (admin, driver, dispatcher) viewing a specific driver
      const isOtherDriver = selectedDriverId && selectedDriverId !== 'all' && delivery.driver_id !== selectedDriverId;

      // CRITICAL: Determine pin color based on mode - calculate ONCE, before rendering
      let pinColor;
      if (isStopInDispatcherStore) {
        // Dispatcher's own stores - ALWAYS use store colors regardless of driver or PUID
        pinColor = store ? getStoreColor(store) : '#6B7280';
      } else if (isAllDriversMode) {
        // All drivers mode - ALWAYS use driver colors, never yellow
        pinColor = enrichedDriver && typeof enrichedDriver === 'object' ? getDriverColor(enrichedDriver) : '#607D8B';
      } else if (hasNoPickup && !isOtherDriver) {
        // Single driver mode ONLY: Yellow for deliveries without assigned pickup
        pinColor = '#FBBF24';
      } else if (isOtherDriver) {
        // "Show All" mode for drivers - other drivers use STORE COLORS
        pinColor = store ? getStoreColor(store) : '#6B7280';
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
        isOtherDriver, // NEW
        isReturn // NEW: Flag for return deliveries
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
      // Use lookup map first, then fallback to denormalized driver name
      const enrichedDriver = driverLookupMap.get(pickup.driver_id) || driver || (pickup.driver_name ? { 
        id: pickup.driver_id, 
        user_name: pickup.driver_name,
        full_name: pickup.driver_name 
      } : null);

      // CRITICAL: Pickups should NEVER use simple circles - they always show full store pickup markers
      const useSimpleCircle = false;

      // Store pickups ALWAYS use store colors (both modes)
      const pinColor = getStoreColor(store);

      // CRITICAL: Determine if this marker belongs to another driver
      // Works for ANY user (admin, driver, dispatcher) viewing a specific driver
      const isOtherDriver = selectedDriverId && selectedDriverId !== 'all' && pickup.driver_id !== selectedDriverId;

      // CRITICAL: Pin color for pickups
      // Active driver OR all drivers mode: ALWAYS use store color
      // "Show All" mode for other drivers: use store color
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
      // CRITICAL: Validate coordinates before calling toFixed
      if (!marker || typeof marker.latitude !== 'number' || typeof marker.longitude !== 'number') {
        console.warn('[DeliveryMap] Invalid marker coordinates:', marker);
        return;
      }
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
      // CRITICAL: Validate coordinates before calling toFixed
      if (!marker || typeof marker.latitude !== 'number' || typeof marker.longitude !== 'number') {
        console.warn('[DeliveryMap] Invalid delivery marker coordinates:', marker);
        return null;
      }
      const key = `${marker.latitude.toFixed(6)},${marker.longitude.toFixed(6)}`;
      return {
        ...marker,
        duplicateCount: locationCounts.get(key) || 1
      };
    }).filter(Boolean);

    const pickupMarkersWithCounts = pickupMarkersRaw.map((marker) => {
      // CRITICAL: Validate coordinates before calling toFixed
      if (!marker || typeof marker.latitude !== 'number' || typeof marker.longitude !== 'number') {
        console.warn('[DeliveryMap] Invalid pickup marker coordinates:', marker);
        return null;
      }
      const key = `${marker.latitude.toFixed(6)},${marker.longitude.toFixed(6)}`;
      return {
        ...marker,
        duplicateCount: locationCounts.get(key) || 1
      };
    }).filter(Boolean);

    // Create separate grouped maps for each type
    const groupedDeliveries = new Map();
    deliveryMarkersWithCounts.forEach((marker) => {
      // CRITICAL: Validate coordinates before calling toFixed
      if (!marker || typeof marker.latitude !== 'number' || typeof marker.longitude !== 'number') return;
      const key = `${marker.latitude.toFixed(6)},${marker.longitude.toFixed(6)}`;
      if (!groupedDeliveries.has(key)) {
        groupedDeliveries.set(key, []);
      }
      groupedDeliveries.get(key).push(marker);
    });

    const groupedPickups = new Map();
    pickupMarkersWithCounts.forEach((marker) => {
      // CRITICAL: Validate coordinates before calling toFixed
      if (!marker || typeof marker.latitude !== 'number' || typeof marker.longitude !== 'number') return;
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
      
      // Track cluster click
      base44.analytics.track({
        eventName: 'map_cluster_clicked',
        properties: { 
          cluster_size: marker.duplicateCount,
          action: fannedLocationKey === locationKey ? 'retract' : 'expand'
        }
      });
      
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
        // Calculate dynamic bottom padding based on actual stop cards height
        // CRITICAL: Get the FULL container height from the horizontal-cards-container
        const stopCardsFullContainer = document.querySelector('.horizontal-cards-container');
        let dynamicBottomPadding = 80; // Default fallback
        
        if (stopCardsFullContainer) {
          const actualHeight = stopCardsFullContainer.getBoundingClientRect().height;
          dynamicBottomPadding = Math.max(actualHeight + 20, 80); // Add 20px buffer
          console.log(`🗺️ [Cluster Click] Using actual stop cards height: ${actualHeight}px, padding: ${dynamicBottomPadding}px`);
        } else {
          console.log(`⚠️ [Cluster Click] Container not found - using default padding: ${dynamicBottomPadding}px`);
        }
        
        // Center on original cluster location with dynamic padding
        const fitOptions = { 
          paddingTopLeft: [80, 80],
          paddingBottomRight: [80, dynamicBottomPadding],
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
    
    // Retract any expanded cluster
    setFannedLocationKey(null);
    
    // Track marker click
    base44.analytics.track({
      eventName: 'map_marker_clicked',
      properties: { 
        marker_type: markerType,
        status: marker.status
      }
    });
    
    // CRITICAL: For pending deliveries, select the assigned pickup instead
    if (marker.status === 'pending' && marker.puid) {
      const assignedPickup = pickupMarkers.find(p => p && p.stop_id === marker.puid);
      if (assignedPickup && onMarkerClick) {
        onMarkerClick(assignedPickup);
      }
    } else if (onMarkerClick) {
      onMarkerClick(marker);
    }
    
    // Auto-center marker on screen with info balloon on first click
    if (map) {
      // Calculate zoom level based on device type
      const targetZoom = isMobile ? 15 : 16;
      
      // Calculate dynamic bottom padding for message balloon
      const messageBalloonsHeight = 120; // Approximate height of popup balloon + padding
      const stopCardsFullContainer = document.querySelector('.horizontal-cards-container');
      let dynamicBottomPadding = messageBalloonsHeight + 20; // Add buffer
      
      if (stopCardsFullContainer) {
        const actualHeight = stopCardsFullContainer.getBoundingClientRect().height;
        dynamicBottomPadding = Math.max(actualHeight + messageBalloonsHeight + 20, messageBalloonsHeight + 20);
      }
      
      // Create a small bounds box centered on the marker
      const markerBounds = L.latLngBounds([
        [marker.latitude, marker.longitude],
        [marker.latitude, marker.longitude]
      ]);
      
      // Center map with proper zoom and offset to show balloon fully
      const panOptions = {
        paddingTopLeft: [60, 60],
        paddingBottomRight: [60, dynamicBottomPadding],
        animate: true,
        duration: 0.6,
        maxZoom: targetZoom
      };
      
      map.fitBounds(markerBounds, panOptions);
      
      // Set the zoom to target zoom level
      setTimeout(() => {
        if (map.getZoom() < targetZoom) {
          map.setZoom(targetZoom, { animate: true, duration: 0.3 });
        }
      }, 600);
      
      // Get marker element and open popup immediately
      const markerElement = markerRefs.current[`${markerType}-${marker.id}`];
      if (markerElement && markerElement._popup) {
        setTimeout(() => {
          markerElement.openPopup();
        }, 300);
      }
    }
    
    // Notify parent that map interaction occurred (marker click)
    if (onMapInteraction) {
      onMapInteraction();
    }
  }, [fannedLocationKey, onMarkerClick, currentZoom, map, groupedDeliveryMarkers, groupedPickupMarkers, calculateFannedPosition, onMapInteraction, stopCardsHeight, isMobile]);

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
    // CRITICAL: Only show on today or future dates
    const today = format(new Date(), 'yyyy-MM-dd');
    const isViewingTodayOrFuture = !selectedDate || selectedDate >= today;
    
    if (!isViewingTodayOrFuture) {
      prevDriverLocationMarkersRef.current = [];
      return [];
    }

    const isCurrentUserAdmin = currentUser && userHasRole(currentUser, 'admin');
    const isCurrentUserDispatcher = currentUser && userHasRole(currentUser, 'dispatcher');
    const isCurrentUserDriver = currentUser && userHasRole(currentUser, 'driver');
    
    // CRITICAL: Pure dispatcher = dispatcher role WITHOUT driver or admin
    const isPureDispatcher = isCurrentUserDispatcher && !isCurrentUserDriver && !isCurrentUserAdmin;
    
    const currentUserCityId = currentUser?.city_id;
    const fiveMinutesInMs = 5 * 60 * 1000;
    const now = Date.now();
    const todayStr = format(new Date(), 'yyyy-MM-dd');
    const currentUserId = currentUser?.id;

    // CRITICAL: Use realtimeAppUsers as the source of truth (contains merged location data)
    const markers = safeUsers.map((user) => {
      if (!user || typeof user !== 'object') return null;

      const driverId = user.id || user.user_id;
      if (!driverId) return null;

      const isCurrentUserMarker = driverId === currentUserId || 
                                  (currentUser?.user_id && driverId === currentUser.user_id) ||
                                  (user.user_id && user.user_id === currentUserId);

      // CRITICAL: On mobile, ALWAYS skip current user's shared marker (blue GPS dot shows instead)
      if (isMobile && isCurrentUserMarker) {
        return null;
      }

      // CRITICAL: Skip inactive users
      if (user.status === 'inactive') {
        return null;
      }
      
      // CRITICAL: Only show on_duty or on_break drivers
      if (user.driver_status !== 'on_duty' && user.driver_status !== 'on_break') {
        return null;
      }
      
      // CRITICAL: Must have valid coordinates
      if (!user.current_latitude || !user.current_longitude) {
        return null;
      }
      
      // CRITICAL: Location tracking must be enabled (unless viewing self)
      if (user.location_tracking_enabled !== true && !isCurrentUserMarker) {
        return null;
      }

      // CRITICAL: Check staleness
      let isStaleLocation = false;
      let locationAge = 0;
      if (user.location_updated_at) {
        locationAge = now - new Date(user.location_updated_at).getTime();
        isStaleLocation = locationAge > fiveMinutesInMs;
      } else {
        isStaleLocation = true;
      }

      // CRITICAL: Show other drivers in same city (admins see all cities)
      // Self is already filtered out above on mobile
      if (isMobile && (isCurrentUserDriver || isCurrentUserAdmin) && !isPureDispatcher) {
        if (!isCurrentUserAdmin && currentUserCityId && user.city_id !== currentUserCityId) {
          return null;
        }
      }
      // CRITICAL: RULE 2 - Desktop drivers/admins: show ALL drivers (including self)
      else if (!isMobile && (isCurrentUserDriver || isCurrentUserAdmin) && !isPureDispatcher) {
        // Show all drivers in same city (admins see all cities)
        if (!isCurrentUserAdmin && currentUserCityId && user.city_id !== currentUserCityId) {
          return null;
        }
      }
      // CRITICAL: RULE 3 - Pure dispatchers: Only show drivers with active deliveries in their stores
      // CRITICAL: Dispatchers can ONLY see shared location marker when driver is on_duty
      // on_break = show polyline only, NOT shared marker
      // off_duty = show nothing
      else if (isPureDispatcher) {
        const dispatcherStoreIds = new Set(currentUser.store_ids || []);
        const hasActiveDelivery = (deliveriesForLocationFilter || []).some(delivery =>
          delivery &&
          delivery.driver_id === driverId &&
          delivery.delivery_date === todayStr &&
          dispatcherStoreIds.has(delivery.store_id) &&
          ['en_route', 'in_transit', 'pending'].includes(delivery.status)
        );

        if (!hasActiveDelivery) return null;
        
        // CRITICAL: Dispatchers can ONLY see shared location marker when driver is on_duty
        // on_break = polyline only (handled below), NOT shared marker
        // off_duty = nothing
        if (user.driver_status !== 'on_duty') return null;
        
        // CRITICAL: Must have location_tracking_enabled = true
        if (user.location_tracking_enabled !== true) return null;
      }
      // No access for other roles
      else {
        return null;
      }
      
      const isOnBreak = user.driver_status === 'on_break' && isCurrentUserMarker;

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

    // CRITICAL: Always return fresh array to ensure polyline positions update
    // The slight performance hit is worth it for accurate real-time tracking
    prevDriverLocationMarkersRef.current = markers;
    return markers;
  // CRITICAL: Include polylineRenderKey to force refresh when locations update
  }, [
    isViewingCurrentDate,
    currentUser?.id,
    isMobile,
    // Track user location data with stable key - round coordinates to prevent micro-changes
    safeUsers.map(u => `${u?.id}:${u?.current_latitude?.toFixed(5)}:${u?.current_longitude?.toFixed(5)}:${u?.driver_status}:${u?.location_tracking_enabled}`).join('|'),
    // Include deliveries for filtering idle drivers
    deliveriesForLocationFilter.map(d => `${d?.id}:${d?.driver_id}:${d?.delivery_date}:${d?.status}`).join('|'),
    polylineRenderKey // CRITICAL: Force recalculation when driver locations update
  ]);

  // UPDATED: Process current driver's live location for display - ONLY SHOW ON MOBILE, TODAY OR FUTURE
  const currentDriverMarker = useMemo(() => {
    // CRITICAL: Only show blue dot on mobile devices
    if (!isMobile) {
      return null;
    }

    if (!currentUser) {
      return null;
    }

    // CRITICAL: Check if viewing today or future date - handle null selectedDate as today
    const today = format(new Date(), 'yyyy-MM-dd');
    const isViewingTodayOrFuture = !selectedDate || selectedDate >= today;
    
    if (!isViewingTodayOrFuture) {
      return null;
    }

    // CRITICAL: Check user roles
    const isCurrentUserDriver = userHasRole(currentUser, 'driver');
    const isCurrentUserAdmin = userHasRole(currentUser, 'admin');
    const isCurrentUserDispatcher = userHasRole(currentUser, 'dispatcher');
    
    // CRITICAL: Pure dispatcher = dispatcher WITHOUT driver or admin roles
    const isPureDispatcher = isCurrentUserDispatcher && !isCurrentUserDriver && !isCurrentUserAdmin;
    
    // CRITICAL: Show blue dot ONLY for users with driver OR admin role (NOT pure dispatchers)
    const shouldShowBlueDot = (isCurrentUserDriver || isCurrentUserAdmin) && !isPureDispatcher;
    
    if (!shouldShowBlueDot) {
      return null;
    }

    // CRITICAL: Use currentDriverLocation if available, otherwise fall back to user's AppUser location
    let locationData = currentDriverLocation;
    
    if (!locationData?.latitude || !locationData?.longitude) {
      // Fall back to current user's location from AppUser data
      if (currentUser.current_latitude && currentUser.current_longitude) {
        locationData = {
          latitude: currentUser.current_latitude,
          longitude: currentUser.current_longitude,
          timestamp: currentUser.location_updated_at
        };
      } else {
        return null;
      }
    }

    return {
      ...locationData,
      driver: currentUser
    };
  }, [currentDriverLocation, currentUser, isMobile, selectedDate]);

  // NEW: Calculate driver home locations for drivers with active stops - CURRENT DATE ONLY
  // Use ref to cache previous markers and only update when actual data changes
  const prevDriverHomeMarkersRef = useRef([]);
  
  const driverHomeMarkers = useMemo(() => {
    if (!showRoutes || !currentUser || !isViewingCurrentDate) {
      // CRITICAL: Don't clear the cache if we already have markers - preserve them during smart refresh
      if (prevDriverHomeMarkersRef.current.length > 0) {
        return prevDriverHomeMarkersRef.current;
      }
      return [];
    }

    // CRITICAL: Dispatchers should not see home locations
    if (userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin')) {
      prevDriverHomeMarkersRef.current = [];
      return [];
    }

    // Check if current user is app owner (Base44 platform admin)
    const isCurrentUserDriver = userHasRole(currentUser, 'driver');
    const isCurrentUserAdmin = userHasRole(currentUser, 'admin');
    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];

    const driversToShowHome = new Set();
    const driversToExcludeFromBounds = new Set(); // CRITICAL: Track home markers to exclude from centering
    const driversWithCompleteRoute = new Set(); // NEW: Track drivers whose routes are complete

    // CRITICAL: For admins/app owners, check ALL deliveries for the date (not just current driver's)
    // This includes other drivers when "Show All" is enabled
    const deliveriesToCheck = (isCurrentUserAdmin && showOtherDriverDeliveries && otherDriverDeliveries.length > 0)
      ? [...safeDeliveries, ...otherDriverDeliveries]
      : safeDeliveries;

    // Group all stops (deliveries + pickups) by driver
    const stopsByDriver = new Map();
    
    deliveriesToCheck.forEach((delivery) => {
      if (!delivery || !delivery.driver_id) return;
      if (!stopsByDriver.has(delivery.driver_id)) {
        stopsByDriver.set(delivery.driver_id, { deliveries: [], pickups: [] });
      }
      if (delivery.patient_id) {
        stopsByDriver.get(delivery.driver_id).deliveries.push(delivery);
      } else {
        stopsByDriver.get(delivery.driver_id).pickups.push(delivery);
      }
    });

    // For each driver, determine if home marker should show
    stopsByDriver.forEach((stops, driverId) => {
      const allStops = [...stops.deliveries, ...stops.pickups];
      
      // Check if ANY stop has been completed
      const hasCompletedAnyStop = allStops.some(s => finishedStatuses.includes(s.status));
      
      // If no stops completed yet, SHOW home marker
      if (!hasCompletedAnyStop) {
        driversToShowHome.add(driverId);
        return;
      }
      
      // CRITICAL: After first stop is completed, EXCLUDE home marker from bounds calculation
      // But still show the marker visually
      if (hasCompletedAnyStop) {
        driversToExcludeFromBounds.add(driverId);
      }
      
      // If stops have been completed, check if there are incomplete pickups remaining
      const hasIncompletePickups = stops.pickups.some(p => !finishedStatuses.includes(p.status) && p.status !== 'pending');
      
      // If NO incomplete pickups remain, SHOW home marker (route is heading home)
      // CRITICAL: And INCLUDE it in bounds calculation (remove from exclude list)
      if (!hasIncompletePickups) {
        driversToShowHome.add(driverId);
        driversToExcludeFromBounds.delete(driverId); // Re-include in bounds when heading home
        
        // NEW: Check if ALL patient deliveries are complete for this driver
        const patientDeliveriesForDriver = stops.deliveries.filter(d => d && d.patient_id);
        const allPatientDeliveriesComplete = patientDeliveriesForDriver.length > 0 && 
          patientDeliveriesForDriver.every(d => finishedStatuses.includes(d.status));
        
        if (allPatientDeliveriesComplete) {
          driversWithCompleteRoute.add(driverId);
        }
      }
      // Otherwise, HIDE home marker (still working on pickups)
    });

    // CRITICAL: If no drivers found but we have cached markers, preserve them during refresh
    // This prevents flickering when deliveries array briefly becomes empty during smart refresh
    if (driversToShowHome.size === 0 && prevDriverHomeMarkersRef.current.length > 0) {
      return prevDriverHomeMarkersRef.current;
    }

    const homeMarkers = [];
    driversToShowHome.forEach((driverId) => {
      if (isDriverViewingSelfToday && driverId !== currentUser.id) return;

      // CRITICAL: Find driver in safeUsers (contains merged AppUser data with home coords)
      const driver = safeUsers.find((u) => u && typeof u === 'object' && u.id === driverId);

      // CRITICAL: Validate home coordinates exist and are valid numbers
      if (!driver?.home_latitude || !driver?.home_longitude ||
          typeof driver.home_latitude !== 'number' || typeof driver.home_longitude !== 'number' ||
          isNaN(driver.home_latitude) || isNaN(driver.home_longitude)) {
        console.warn(`[DeliveryMap] Driver ${driverId} has invalid home coordinates:`, { 
          home_lat: driver?.home_latitude, 
          home_lon: driver?.home_longitude 
        });
        return; // Skip drivers without valid home coordinates
      }

      // CRITICAL: Admins see ALL home markers (for all drivers with active stops)
      // Drivers ALWAYS see their own home marker
      const shouldRenderHome =
        isAppOwner(currentUser) || // App owner sees all home markers
        isCurrentUserAdmin || // Admins see all home markers
        (isCurrentUserDriver && driver.id === currentUser.id); // Driver ALWAYS sees their own home
      
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
          driverName,
          excludeFromBounds: driversToExcludeFromBounds.has(driverId), // CRITICAL: Flag to exclude from centering
          isRouteComplete: driversWithCompleteRoute.has(driverId) // NEW: Flag to show Go Home button
        });
      }
    });

    // CRITICAL: Only update if home markers actually changed to prevent blinking
    const newKey = homeMarkers.map(m => `${m.id}:${m.latitude}:${m.longitude}`).join('|');
    const prevKey = prevDriverHomeMarkersRef.current.map(m => `${m.id}:${m.latitude}:${m.longitude}`).join('|');
    
    if (newKey === prevKey && prevDriverHomeMarkersRef.current.length > 0) {
      return prevDriverHomeMarkersRef.current;
    }
    
    // CRITICAL: If new markers are empty but we had markers before, preserve them
    // This handles the case where deliveries briefly become empty during refresh
    if (homeMarkers.length === 0 && prevDriverHomeMarkersRef.current.length > 0) {
      return prevDriverHomeMarkersRef.current;
    }
    
    prevDriverHomeMarkersRef.current = homeMarkers;
    return homeMarkers;
  // CRITICAL: Use minimal, stable dependencies to prevent blinking
  }, [
    showRoutes,
    currentUser?.id,
    isViewingCurrentDate,
    isDriverViewingSelfToday,
    showOtherDriverDeliveries,
    // Only track essential data with stable JSON stringify
    JSON.stringify(safeDeliveries.map(d => ({ id: d?.driver_id, status: d?.status }))),
    JSON.stringify(otherDriverDeliveries.map(d => ({ id: d?.driver_id, status: d?.status }))),
    JSON.stringify(safeUsers.map(u => ({ id: u?.id, hLat: u?.home_latitude, hLon: u?.home_longitude })))
  ]);

  // CRITICAL: Pass home markers, driver locations, AND delivery markers to Dashboard for FAB phase 1 bounds calculation
  useEffect(() => {
    window.__mapHomeMarkers = driverHomeMarkers;
    window.__mapDriverLocationMarkers = driverLocationMarkers;
    // Also pass delivery and pickup markers with their coordinates for bounds calculation
    window.__mapDeliveryMarkers = deliveryMarkers;
    window.__mapPickupMarkers = pickupMarkers;
    
    return () => {
      delete window.__mapHomeMarkers;
      delete window.__mapDriverLocationMarkers;
      delete window.__mapDeliveryMarkers;
      delete window.__mapPickupMarkers;
    };
  }, [driverHomeMarkers, driverLocationMarkers, deliveryMarkers, pickupMarkers]);

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

    // CRITICAL: Pre-build driver lookup with STABLE sort order from stableSortedDrivers
    const driverOrderMap = new Map();
    stableSortedDrivers.forEach((driver, index) => {
      driverOrderMap.set(driver.id, { driver, sortIndex: index });
    });

    // Group deliveries by driver
    const routesByDriver = {};

    deliveryMarkers.forEach((delivery) => {
    if (!delivery) return;
    const driverId = delivery.driver_id || 'unassigned';
    if (!routesByDriver[driverId]) {
      // CRITICAL: Use stable driver order map
      const driverInfo = driverOrderMap.get(driverId);
      let driverForRoute = driverInfo?.driver || driverLookupMap.get(driverId);
      let stableSortIndex = driverInfo?.sortIndex ?? Infinity;
      
      // CRITICAL: Fallback to denormalized driver name if not in lookup map
      if (!driverForRoute && delivery.driver_name) {
        driverForRoute = {
          id: driverId,
          user_name: delivery.driver_name,
          full_name: delivery.driver_name
        };
        stableSortIndex = Infinity;
      }

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
        sortOrder: stableSortIndex, // Use stable index instead of dynamic sort_order
        // CRITICAL: Store both the route color AND the driver object for legend lookup
        _driverObj: driverForRoute
      };
    }
    routesByDriver[driverId].stops.push(delivery);
    });

    // Sort stops by stop_order and create route lines
    const sortedRoutes = Object.values(routesByDriver).sort((a, b) => a.sortOrder - b.sortOrder).map((route) => {
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

      // CRITICAL POLYLINE RULE: For active routes, filter to incomplete stops. For completed routes, show all
      let deliveriesToRoute = isRouteCompleted ? route.stops : route.stops.filter((delivery) => delivery && !FINISHED_STATUSES.includes(delivery.status) && delivery.status !== 'pending');
      let pickupsToRoute = isRouteCompleted ? driverPickups : driverPickups.filter((p) => p && !FINISHED_STATUSES.includes(p.status) && p.status !== 'pending');

      // CRITICAL: Calculate totalDriverStops using Dashboard stats rules
      // Patient deliveries + completed/cancelled after hours pickups
      const patientDeliveryCount = route.stops.filter(d => d && d.patient_id).length;
      const completedOrCancelledAfterHours = driverPickups.filter(p => {
        if (!p) return false;
        return p.after_hours_pickup && (p.status === 'completed' || p.status === 'cancelled');
      }).length;
      const totalDriverStopsWithAfterHours = patientDeliveryCount + completedOrCancelledAfterHours;

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
            shouldShowHomeRoute = !isRouteCompleted && !isDispatcherNonAdmin && showLivePolylines;
          }

          // NEW: Determine starting point for visualization (routeHasActuallyStarted defined above)
          // CRITICAL: Skip home-to-first-stop lines for other drivers when viewing self today
          // CRITICAL: Only show starting lines for live routes (current date)
          const isOtherDriverRoute = isDriverViewingSelfToday && route.driverId !== currentUser?.id;

          if (routeHasActuallyStarted && firstStopCoordinates && route.driver && !isOtherDriverRoute && showLivePolylines) {
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
        totalStops: totalDriverStopsWithAfterHours, // FIXED: Use count including after hours pickups
        // NEW: Zoom-based styling
        routeWeight,
        routeOpacity,
        showWaypoints
      };
    });

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
    stableSortedDrivers.map(d => `${d?.id}:${d?.sort_order}`).join('|'), // Stable driver order key
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
      
      // CRITICAL: Mark this as a programmatic zoom BEFORE calling fitBounds
      // Use a ref that persists across the entire zoom operation (zoomstart -> zoomend)
      // Access the MapController's ref through a closure
      if (map._leaflet_events?.zoomstart) {
        // Store flag globally on map instance so MapController can access it
        if (!map._isProgrammaticZoom) {
          Object.defineProperty(map, '_isProgrammaticZoom', {
            value: { current: false },
            writable: true,
            configurable: true
          });
        }
        map._isProgrammaticZoom.current = true;
      }
      
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

  // Track popup visibility timeouts for driver location markers
  const popupTimeoutsRef = useRef({});
  
  const handleDriverLocationPopupHover = (locationId, isHovering) => {
    if (isHovering) {
      // Clear timeout when hovering over popup
      if (popupTimeoutsRef.current[locationId]) {
        clearTimeout(popupTimeoutsRef.current[locationId]);
        popupTimeoutsRef.current[locationId] = null;
      }
    } else {
      // Set 2-second delay before closing when leaving popup
      popupTimeoutsRef.current[locationId] = setTimeout(() => {
        const markers = document.querySelectorAll(`[data-driver-location-id="${locationId}"] .leaflet-popup`);
        markers.forEach(m => {
          const closeBtn = m.querySelector('.leaflet-popup-close-button');
          if (closeBtn) closeBtn.click();
        });
      }, 2000);
    }
  };

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
        // Check multiple sources to ensure we catch all programmatic zooms
        const isProgrammaticFromFlag = mapInstance._isProgrammaticZoom?.current === true;
        const timeSinceProgrammatic = Date.now() - (window._lastProgrammaticMapMove || 0);
        const isProgrammaticFromTimer = timeSinceProgrammatic < 500;
        
        if (isProgrammaticFromFlag || isProgrammaticFromTimer) {
          console.log('🗺️ [MapController] ZOOM START - PROGRAMMATIC (ignoring)');
          return;
        }
        
        // Real user zoom - notify parent and track
        console.log('🗺️ [MapController] ZOOM START - USER INTERACTION');
        base44.analytics.track({
          eventName: 'map_zoom_started',
          properties: { zoom_level: mapInstance.getZoom() }
        });
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
            base44.analytics.track({
              eventName: 'map_panned',
              properties: { zoom_level: mapInstance.getZoom() }
            });
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
          
          // CRITICAL: Only show zoom overlay on MANUAL zooms (not programmatic)
          // Check multiple sources to ensure we catch all programmatic zooms
          const isProgrammaticFromFlag = mapInstance._isProgrammaticZoom?.current === true;
          const timeSinceProgrammatic = Date.now() - (window._lastProgrammaticMapMove || 0);
          const isProgrammaticFromTimer = timeSinceProgrammatic < 1000;
          
          if (!isProgrammaticFromFlag && !isProgrammaticFromTimer) {
            // Real user zoom - show overlay for 3 seconds
            console.log('🗺️ [MapController] ZOOM END - USER INTERACTION (showing overlay)');
            if (zoomOverlayTimeoutRef.current) {
              clearTimeout(zoomOverlayTimeoutRef.current);
            }
            setShowZoomOverlay(true);
            zoomOverlayTimeoutRef.current = setTimeout(() => {
              setShowZoomOverlay(false);
            }, 3000);
          } else {
            console.log('🗺️ [MapController] ZOOM END - PROGRAMMATIC (not showing overlay)');
          }
        }
        
        // Reset programmatic flag after zoom completes
        if (mapInstance._isProgrammaticZoom) {
          mapInstance._isProgrammaticZoom.current = false;
        }
        
        // Update visible bounds for debug box
        const bounds = mapInstance.getBounds();
        setVisibleBounds(bounds);
      },
      moveend: () => {
        // Update map center for crosshair - use actual center without adjustments
        const center = mapInstance.getCenter();
        const newCenter = [center.lat, center.lng];
        
        // CRITICAL: Only update if center actually changed to prevent infinite loop
        setMapCenter(prev => {
          if (!prev || prev[0] !== newCenter[0] || prev[1] !== newCenter[1]) {
            return newCenter;
          }
          return prev;
        });
        
        // Update visible bounds for debug box
        const bounds = mapInstance.getBounds();
        setVisibleBounds(bounds);
      },
      click: () => {
        setFannedLocationKey(null);
        
        const now = Date.now();
        const timeSinceLastTap = now - lastTapRef.current;
        
        if (timeSinceLastTap < 300) {
          base44.analytics.track({
            eventName: 'map_double_tapped',
            properties: { zoom_level: mapInstance.getZoom() }
          });
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

          {(() => {
            const isFinished = FINISHED_STATUSES.includes(delivery.status);
            const finishedTime = delivery.actual_delivery_time ? format(new Date(delivery.actual_delivery_time), 'HH:mm') : null;
            
            if (isFinished && finishedTime) {
              return (
                <div className="flex items-center gap-1 text-xs text-emerald-600 font-medium">
                  <Clock className="w-3.5 h-3.5 flex-shrink-0" />
                  <span>{finishedTime}</span>
                </div>
              );
            } else if (delivery.delivery_time_eta) {
              return (
                <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-slate-600)' }}>
                  <Clock className="w-3.5 h-3.5 flex-shrink-0" />
                  <span>ETA: {delivery.delivery_time_eta}</span>
                </div>
              );
            }
            return null;
          })()}

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
            <div className="flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded" style={{ color: '#059669', background: 'rgba(5, 150, 105, 0.1)' }}>
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

          {!isPickup && (
            <div className="border-t pt-1.5 mt-1.5" style={{ borderColor: 'var(--border-slate-200)' }}>
              <SpecialSymbolsBadges delivery={delivery} patient={patient} size="sm" />
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

        {/* TYPE 1 POLYLINE: Blue dotted line from driver location to next stop */}
        {isViewingCurrentDate && (() => {
          const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
          const polylines = [];
          
          // Get all unique driver IDs that have incomplete stops
          const driversWithIncompleteStops = new Set();
          [...deliveryMarkers, ...pickupMarkers].forEach(m => {
            if (!m || !m.driver_id) return;
            if (finishedStatuses.includes(m.status) || m.status === 'pending') return;
            driversWithIncompleteStops.add(m.driver_id);
          });
          
          driversWithIncompleteStops.forEach(driverId => {
            // Skip driver on break
            const driverAppUser = realtimeAppUsers.find(u => u && u.id === driverId);
            if (driverAppUser?.driver_status === 'on_break') return;
            
            // Get next stop for this driver
            const nextStop = deliveryMarkers.find(d => 
              d && 
              d.driver_id === driverId &&
              d.isNextDelivery === true &&
              !finishedStatuses.includes(d.status) &&
              d.status !== 'pending' &&
              typeof d.latitude === 'number' &&
              typeof d.longitude === 'number'
            ) || pickupMarkers.find(p => 
              p && 
              p.driver_id === driverId &&
              p.isNextDelivery === true &&
              !finishedStatuses.includes(p.status) &&
              p.status !== 'pending' &&
              typeof p.latitude === 'number' &&
              typeof p.longitude === 'number'
            );
            
            if (!nextStop) return;
            
            // Determine start point (priority: live location > shared marker > last completed > home)
            let startPoint = null;
            
            // 1) Live driver location (current user only)
            if (driverId === currentUser?.id && currentDriverLocation?.latitude && currentDriverLocation?.longitude) {
              startPoint = [currentDriverLocation.latitude, currentDriverLocation.longitude];
            }
            
            // 2) Shared location marker
            if (!startPoint) {
              const sharedMarker = driverLocationMarkers.find(m => m.driver_id === driverId);
              if (sharedMarker?.latitude && sharedMarker?.longitude) {
                startPoint = [sharedMarker.latitude, sharedMarker.longitude];
              }
            }
            
            // 3) Last completed stop
            if (!startPoint) {
              const allDriverStops = [...deliveryMarkers, ...pickupMarkers].filter(m => m && m.driver_id === driverId);
              const completedStops = allDriverStops
                .filter(s => finishedStatuses.includes(s.status) && s.actual_delivery_time)
                .sort((a, b) => new Date(b.actual_delivery_time) - new Date(a.actual_delivery_time));
              
              if (completedStops.length > 0) {
                startPoint = [completedStops[0].latitude, completedStops[0].longitude];
              }
            }
            
            // 4) Driver home location
            if (!startPoint) {
              const driver = safeUsers.find(u => u && u.id === driverId);
              if (driver?.home_latitude && driver?.home_longitude) {
                startPoint = [driver.home_latitude, driver.home_longitude];
              }
            }
            
            if (!startPoint) return;
            
            // TYPE 1: Blue dotted line to next stop
            polylines.push(
              <Polyline
                key={`type1-${driverId}-${nextStop.id}-${polylineRenderKey}`}
                positions={[startPoint, [nextStop.latitude, nextStop.longitude]]}
                pathOptions={{
                  color: '#3B82F6',
                  weight: 4,
                  opacity: 0.7,
                  dashArray: '2, 8',
                  lineJoin: 'round',
                  lineCap: 'round'
                }}
                pane="overlayPane"
              />
            );
          });
          
          return polylines.length > 0 ? polylines : null;
        })()}
        
        {/* TYPE 2 & 3 POLYLINES: Colored lines connecting stops in stop_order sequence */}
        {isViewingCurrentDate && showRoutes && (() => {
          const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
          const polylines = [];
          
          driverRoutes.forEach(route => {
            if (!route.driverId) return;
            
            // CRITICAL: Use route.color for this driver's unique color
            const driverPolylineColor = route.color;
            
            // CRITICAL: Use ONLY deliveryMarkers for polylines (they have validated coordinates)
            // deliveryMarkers includes both own driver + other driver deliveries
            const sourceDeliveries = deliveryMarkers.filter(d => d && d.driver_id === route.driverId);
            
            const allDriverStops = [
              ...pickupMarkers.filter(p => p && p.driver_id === route.driverId),
              ...sourceDeliveries
            ].sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
            
            if (allDriverStops.length < 2) return;
            
            // Check if route is completed
            const isRouteCompleted = allDriverStops.every(s => finishedStatuses.includes(s.status));
            
            // Filter stops based on route status
            let stopsToConnect = isRouteCompleted 
              ? allDriverStops // Type 3: All stops for completed routes
              : allDriverStops.filter(s => !finishedStatuses.includes(s.status) && s.status !== 'pending'); // Type 2: Incomplete stops only
            
            // Find next stop to know where Type 2 starts
            const nextStop = stopsToConnect.find(s => s.isNextDelivery === true);
            const nextStopIndex = nextStop ? stopsToConnect.indexOf(nextStop) : -1;
            
            // Connect stops in sequence
            for (let i = 0; i < stopsToConnect.length - 1; i++) {
              const stop1 = stopsToConnect[i];
              const stop2 = stopsToConnect[i + 1];
              
              if (!stop1 || !stop2) continue;
              
              // CRITICAL: Validate coordinates before creating polyline
              if (typeof stop1.latitude !== 'number' || typeof stop1.longitude !== 'number' ||
                  typeof stop2.latitude !== 'number' || typeof stop2.longitude !== 'number' ||
                  isNaN(stop1.latitude) || isNaN(stop1.longitude) ||
                  isNaN(stop2.latitude) || isNaN(stop2.longitude)) {
                console.warn('[DeliveryMap] Skipping polyline with invalid coordinates:', { stop1, stop2 });
                continue;
              }
              
              // Determine line style based on destination stop's AM/PM
              const isAM = stop2.ampm_deliveries === 'AM';
              const dashArray = isAM ? '10, 5' : '2, 8'; // AM = dashed, PM = dotted
              
              // Type 2 polylines start from next stop (skip segments before next stop for active routes)
              if (!isRouteCompleted && i < nextStopIndex) continue;
              
              polylines.push(
               <Polyline
                 key={`type2-3-${route.driverId}-${i}-${polylineRenderKey}`}
                 positions={[
                   [stop1.latitude, stop1.longitude],
                   [stop2.latitude, stop2.longitude]
                 ]}
                 pathOptions={{
                   color: driverPolylineColor,
                   weight: 4,
                   opacity: 0.7,
                   dashArray: dashArray,
                   lineJoin: 'round',
                   lineCap: 'round'
                 }}
                 pane="overlayPane"
               />
              );
            }
          });
          
          return polylines.length > 0 ? polylines : null;
        })()}

        {/* DEPRECATED: Old route drawing logic - replaced by Type 2 & 3 polylines above */}

        {/* NEW: Fanning radius lines (thick, solid, grey) - UNIFIED for all markers */}
        {fannedLocationKey && (() => {
          const pickupsAtLocation = groupedPickupMarkers.get(fannedLocationKey) || [];
          const deliveriesAtLocation = groupedDeliveryMarkers.get(fannedLocationKey) || [];
          const allMarkersAtLocation = [...pickupsAtLocation, ...deliveriesAtLocation]
            .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
          
          return allMarkersAtLocation.map((marker, idx) => {
            const [originalLat, originalLng] = fannedLocationKey.split(',').map(Number);
            
            // CRITICAL: Validate coordinates
            if (typeof originalLat !== 'number' || typeof originalLng !== 'number' || 
                isNaN(originalLat) || isNaN(originalLng)) {
              return null;
            }
            
            const [fannedLat, fannedLng] = calculateFannedPosition(
              originalLat,
              originalLng,
              idx,
              allMarkersAtLocation.length,
              marker.stop_order
            );
            
            if (typeof fannedLat !== 'number' || typeof fannedLng !== 'number' ||
                isNaN(fannedLat) || isNaN(fannedLng)) {
              return null;
            }
            
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
          
          // CRITICAL: Validate coordinates before rendering marker
          if (!currentDriverMarker.latitude || !currentDriverMarker.longitude ||
              typeof currentDriverMarker.latitude !== 'number' || typeof currentDriverMarker.longitude !== 'number' ||
              isNaN(currentDriverMarker.latitude) || isNaN(currentDriverMarker.longitude)) {
            console.warn('[DeliveryMap] Invalid currentDriverMarker coordinates:', currentDriverMarker);
            return null;
          }
          
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
            // CRITICAL: Store zone circles ALWAYS visible (removed zoom check)
            !isFanned &&
            <Circle
              key={`pickup-circle-${pickup.id}`}
              center={[pickup.latitude, pickup.longitude]}
              radius={2500}
              pathOptions={{
                color: pickup.pinColor,
                fillColor: pickup.pinColor,
                fillOpacity: document.documentElement.classList.contains('dark-theme') || 
                            (document.documentElement.classList.contains('auto-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)
                            ? 0.15 : 0.05,
                weight: 2,
                opacity: document.documentElement.classList.contains('dark-theme') || 
                         (document.documentElement.classList.contains('auto-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)
                         ? 0.4 : 0.2
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
              icon={pickup.useSimpleCircle ? createSimpleCircleIcon(pickup.status, pickup.status === 'pending' ? null : pickup.number, currentZoom, isMobile, pickup.pinColor, pickup.isOtherDriver, pickup.duplicateCount) : createStoreIcon(
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
              draggable={!pickup.useSimpleCircle && !pickup.isOtherDriver && isFanned}
              eventHandlers={pickup.isOtherDriver ? {
                click: (e) => {
                  L.DomEvent.stopPropagation(e);
                },
                mouseover: (e) => e.target.openPopup(),
                mouseout: (e) => e.target.closePopup()
              } : pickup.useSimpleCircle ? {
                click: (e) => {
                  L.DomEvent.stopPropagation(e);
                },
                mouseover: (e) => e.target.openPopup(),
                mouseout: (e) => e.target.closePopup()
              } : {
                click: (e) => {
                  L.DomEvent.stopPropagation(e);
                  if (isFanned && onMarkerClick) {
                    onMarkerClick(pickup);
                  } else {
                    handleMarkerClickForFanning(pickup, 'pickup');
                  }
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
                  // Clustered markers show unified popup with all marker info and clickable stops
                  <Popup autoPan={false} closeButton={false} offset={[0, -20]} className="custom-popup">
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
                          const itemName = m.markerType === 'pickup' ? 'Store Pickup' : (m.patient?.full_name || 'Patient');

                          return (
                            <div 
                              key={`cluster-item-${m.id}`} 
                              className="text-xs py-1.5 border-b last:border-0 cursor-pointer hover:bg-slate-50 transition-colors px-1 -mx-1 rounded space-y-0.5"
                              style={{ borderColor: 'var(--border-slate-200)' }}
                              onClick={() => {
                                // CRITICAL: Close cluster popup immediately
                                const popups = document.querySelectorAll('.leaflet-popup');
                                popups.forEach(p => p.remove());

                                // Center card for clicked stop
                                const cardElement = document.getElementById(`stop-card-${m.id}`);
                                if (cardElement) {
                                  cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                                }
                              }}
                            >
                              <div className="flex items-center gap-1.5 font-medium" style={{ color: 'var(--text-slate-900)' }}>
                                <Truck className="w-3.5 h-3.5" />
                                {m.driver?.user_name || 'Unknown'}
                              </div>
                              <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-slate-600)' }}>
                                <Home className="w-3.5 h-3.5" />
                                {m.store?.name || 'Store'}
                              </div>
                              {isFinished && finishedTime ? (
                                <div className="flex items-center justify-between text-[11px]">
                                  <span style={{ color: 'var(--text-slate-900)' }}>{itemName}</span>
                                  <span className="text-emerald-600">{finishedTime}</span>
                                </div>
                              ) : m.delivery_time_eta ? (
                                <div className="flex items-center justify-between text-[11px]">
                                  <span style={{ color: 'var(--text-slate-900)' }}>{itemName}</span>
                                  <span style={{ color: 'var(--text-slate-600)' }}>ETA: {m.delivery_time_eta}</span>
                                </div>
                              ) : (
                                <div className="text-[11px]" style={{ color: 'var(--text-slate-900)' }}>
                                  {itemName}
                                </div>
                              )}
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </Popup>
                ) : (
                  // Non-clustered or fanned markers show full details
                  <Popup autoPan={false} closeButton={false} offset={[0, -20]} className="custom-popup">
                    <DeliveryPopup delivery={pickup} isPickup={true} />
                  </Popup>
                )
              )}
              {/* Simple popup for dispatcher's simple circle markers (other stores) */}
              {pickup.useSimpleCircle && !pickup.isOtherDriver && (
                <Popup autoPan={false} closeButton={false} offset={[0, -10]} className="custom-popup">
                  <div className="min-w-[150px] space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: 'var(--text-slate-900)' }}>
                        <Home className="w-3.5 h-3.5" />
                        {pickup.store?.name || 'Store'}
                      </div>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                        pickup.status === 'completed' ? 'text-emerald-700 bg-emerald-100' :
                        pickup.status === 'failed' || pickup.status === 'cancelled' ? 'text-red-700 bg-red-100' :
                        pickup.status === 'returned' ? 'text-orange-700 bg-orange-100' :
                        pickup.status === 'in_transit' ? 'text-blue-700 bg-blue-100' :
                        'text-slate-600 bg-slate-100'
                      }`}>
                        {pickup.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-slate-600)' }}>
                      <Truck className="w-3.5 h-3.5" />
                      {pickup.driver?.user_name || 'Unknown Driver'}
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
              {/* NEW: Popup for other drivers' pickups - grouped by driver+store */}
              {pickup.isOtherDriver && (
                isClustered && !isFanned ? (
                  // Clustered other driver pickups - grouped by driver+store
                  <Popup autoPan={false} closeButton={false} offset={[0, -20]} className="custom-popup">
                    <div className="min-w-[200px] max-w-[300px] space-y-0">
                      <div className="font-semibold text-sm pb-1 border-b mb-1" style={{ color: 'var(--text-slate-900)', borderColor: 'var(--border-slate-200)' }}>
                        {pickup.duplicateCount} stops at this location
                      </div>
                      {(() => {
                        const locationKey = `${pickup.latitude.toFixed(6)},${pickup.longitude.toFixed(6)}`;
                        const pickupsAtLocation = groupedPickupMarkers.get(locationKey) || [];
                        const deliveriesAtLocation = groupedDeliveryMarkers.get(locationKey) || [];
                        const allMarkersAtLocation = [...pickupsAtLocation, ...deliveriesAtLocation]
                          .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
                        
                        // Group by driver + store
                        const groups = [];
                        let currentGroup = null;
                        
                        allMarkersAtLocation.forEach((m) => {
                          const driverId = m.driver?.user_name || 'Unknown';
                          const storeId = m.store?.name || 'Store';
                          const key = `${driverId}|${storeId}`;
                          
                          if (!currentGroup || currentGroup.key !== key) {
                            currentGroup = { key, driver: driverId, store: storeId, items: [] };
                            groups.push(currentGroup);
                          }
                          currentGroup.items.push(m);
                        });
                        
                        return groups.map((group, groupIdx) => (
                          <div key={`group-${groupIdx}`}>
                            <div className="px-1 pt-1 pb-1.5 space-y-0.5">
                              <div className="flex items-center gap-1.5 font-medium text-xs" style={{ color: 'var(--text-slate-900)' }}>
                                <Truck className="w-3.5 h-3.5 flex-shrink-0" />
                                {group.driver}
                              </div>
                              <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-slate-600)' }}>
                                <Home className="w-3.5 h-3.5 flex-shrink-0" />
                                {group.store}
                              </div>
                            </div>
                            <div className="border-b" style={{ borderColor: 'var(--border-slate-200)' }} />
                            <div className="px-1 py-1.5 space-y-1">
                              {group.items.map((m) => {
                                const isFinished = FINISHED_STATUSES.includes(m.status);
                                const isFailed = m.status === 'failed' || m.status === 'cancelled';
                                const finishedTime = m.actual_delivery_time ? format(new Date(m.actual_delivery_time), 'HH:mm') : null;
                                const itemName = m.markerType === 'pickup' ? 'Store Pickup' : (m.patient?.full_name || 'Patient');
                                
                                return (
                                  <div 
                                    key={`item-${m.id}`} 
                                    className="text-xs cursor-pointer hover:bg-slate-50 transition-colors px-1 py-0.5 rounded flex items-center justify-between"
                                    onClick={() => {
                                      const popups = document.querySelectorAll('.leaflet-popup');
                                      popups.forEach(p => p.remove());
                                      const cardElement = document.getElementById(`stop-card-${m.id}`);
                                      if (cardElement) {
                                        cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                                      }
                                    }}
                                  >
                                    <div className="flex items-center gap-1.5" style={{ color: 'var(--text-slate-900)' }}>
                                      <User className="w-3 h-3 flex-shrink-0" />
                                      <span>{itemName}</span>
                                    </div>
                                    <div className="flex items-center gap-1">
                                      {isFinished && finishedTime ? (
                                        <>
                                          <span className="text-emerald-600">{finishedTime}</span>
                                          {isFailed ? (
                                            <XCircle className="w-3.5 h-3.5 text-red-600 flex-shrink-0" />
                                          ) : (
                                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" />
                                          )}
                                        </>
                                      ) : m.delivery_time_eta ? (
                                        <>
                                          <span style={{ color: 'var(--text-slate-600)' }}>{m.delivery_time_eta}</span>
                                          <Clock className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-slate-500)' }} />
                                        </>
                                      ) : null}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                            {groupIdx < groups.length - 1 && (
                              <div className="border-b" style={{ borderColor: 'var(--border-slate-200)' }} />
                            )}
                          </div>
                        ));
                      })()}
                    </div>
                  </Popup>
                ) : (
                  // Non-clustered other driver pickup - same layout as clustered
                  <Popup autoPan={false} closeButton={false} offset={[0, -20]} className="custom-popup">
                    <div className="min-w-[200px] max-w-[300px] space-y-0">
                      <div className="px-1 pt-1 pb-1.5 space-y-0.5">
                        <div className="flex items-center gap-1.5 font-medium text-xs" style={{ color: 'var(--text-slate-900)' }}>
                          <Truck className="w-3.5 h-3.5 flex-shrink-0" />
                          {pickup.driver?.user_name || 'Unknown'}
                        </div>
                        <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-slate-600)' }}>
                          <Home className="w-3.5 h-3.5 flex-shrink-0" />
                          {pickup.store?.name || 'Store'}
                        </div>
                      </div>
                      <div className="border-b" style={{ borderColor: 'var(--border-slate-200)' }} />
                      <div className="px-1 py-1.5">
                        {(() => {
                          const isFinished = FINISHED_STATUSES.includes(pickup.status);
                          const isFailed = pickup.status === 'failed' || pickup.status === 'cancelled';
                          const finishedTime = pickup.actual_delivery_time ? format(new Date(pickup.actual_delivery_time), 'HH:mm') : null;
                          const itemName = 'Store Pickup';
                          
                          return (
                            <div className="text-xs flex items-center justify-between">
                              <div className="flex items-center gap-1.5" style={{ color: 'var(--text-slate-900)' }}>
                                <User className="w-3 h-3 flex-shrink-0" />
                                <span>{itemName}</span>
                              </div>
                              <div className="flex items-center gap-1">
                                {isFinished && finishedTime ? (
                                  <>
                                    <span className="text-emerald-600">{finishedTime}</span>
                                    {isFailed ? (
                                      <XCircle className="w-3.5 h-3.5 text-red-600 flex-shrink-0" />
                                    ) : (
                                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" />
                                    )}
                                  </>
                                ) : pickup.delivery_time_eta ? (
                                  <>
                                    <span style={{ color: 'var(--text-slate-600)' }}>{pickup.delivery_time_eta}</span>
                                    <Clock className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-slate-500)' }} />
                                  </>
                                ) : null}
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  </Popup>
                )
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
              icon={delivery.useSimpleCircle || delivery.isOtherDriver ? createSimpleCircleIcon(delivery.isReturn ? 'returned' : delivery.status, delivery.status === 'pending' ? null : delivery.number, currentZoom, isMobile, delivery.pinColor, delivery.isOtherDriver, delivery.duplicateCount) : createDeliveryIcon(
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
                delivery.isOtherDriver, // NEW
                delivery.isReturn // NEW: Return flag
              )}
              zIndexOffset={dynamicZIndex}
              draggable={!delivery.useSimpleCircle && !delivery.isOtherDriver && isFanned}
              eventHandlers={delivery.isOtherDriver ? {
                click: (e) => {
                  L.DomEvent.stopPropagation(e);
                },
                mouseover: (e) => e.target.openPopup(),
                mouseout: (e) => e.target.closePopup()
              } : delivery.useSimpleCircle ? {
                click: (e) => {
                  L.DomEvent.stopPropagation(e);
                },
                mouseover: (e) => e.target.openPopup(),
                mouseout: (e) => e.target.closePopup()
              } : {
                click: (e) => {
                  L.DomEvent.stopPropagation(e);
                  if (isFanned && onMarkerClick) {
                    onMarkerClick(delivery);
                  } else {
                    handleMarkerClickForFanning(delivery, 'delivery');
                  }
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
                  // Clustered markers show unified popup with all marker info and clickable stops
                  <Popup autoPan={false} closeButton={false} offset={[0, -20]} className="custom-popup">
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
                        
                        // Find first incomplete stop
                        const firstIncomplete = allMarkersAtLocation.find(m => !FINISHED_STATUSES.includes(m.status));
                        
                        return allMarkersAtLocation.map((m, idx) => {
                          const isFinished = FINISHED_STATUSES.includes(m.status);
                          const finishedTime = m.actual_delivery_time ? format(new Date(m.actual_delivery_time), 'HH:mm') : null;
                          const isFirstIncomplete = m.id === firstIncomplete?.id;
                          const itemName = m.markerType === 'pickup' ? 'Store Pickup' : (m.patient?.full_name || 'Patient');
                          
                          return (
                            <div 
                              key={`cluster-item-${m.id}`} 
                              className="text-xs py-1.5 border-b last:border-0 cursor-pointer hover:bg-slate-50 transition-colors px-1 -mx-1 rounded space-y-0.5"
                              style={{ borderColor: 'var(--border-slate-200)' }}
                              onClick={() => {
                                // CRITICAL: Close cluster popup immediately
                                const popups = document.querySelectorAll('.leaflet-popup');
                                popups.forEach(p => p.remove());
                                
                                // Center card for clicked stop
                                const cardElement = document.getElementById(`stop-card-${m.id}`);
                                if (cardElement) {
                                  cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                                }
                              }}
                            >
                              <div className="flex items-center gap-1.5 font-medium" style={{ color: 'var(--text-slate-900)' }}>
                                <Truck className="w-3.5 h-3.5" />
                                {m.driver?.user_name || 'Unknown'}
                              </div>
                              <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-slate-600)' }}>
                                <Home className="w-3.5 h-3.5" />
                                {m.store?.name || 'Store'}
                              </div>
                              {isFinished && finishedTime ? (
                                <div className="flex items-center justify-between text-[11px]">
                                  <span style={{ color: 'var(--text-slate-900)' }}>{itemName}</span>
                                  <span className="text-emerald-600">{finishedTime}</span>
                                </div>
                              ) : m.delivery_time_eta ? (
                                <div className="flex items-center justify-between text-[11px]">
                                  <span style={{ color: 'var(--text-slate-900)' }}>{itemName}</span>
                                  <span style={{ color: 'var(--text-slate-600)' }}>ETA: {m.delivery_time_eta}</span>
                                </div>
                              ) : (
                                <div className="text-[11px]" style={{ color: 'var(--text-slate-900)' }}>
                                  {itemName}
                                </div>
                              )}
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </Popup>
                ) : (
                  // Non-clustered or fanned markers show full details
                  <Popup autoPan={false} closeButton={false} offset={[0, -20]} className="custom-popup">
                    <DeliveryPopup delivery={delivery} isPickup={false} />
                  </Popup>
                )
              )}
              {/* Simple popup for dispatcher's simple circle markers (other stores) */}
              {delivery.useSimpleCircle && !delivery.isOtherDriver && (
                <Popup autoPan={false} closeButton={false} offset={[0, -10]} className="custom-popup">
                  <div className="min-w-[150px] space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: 'var(--text-slate-900)' }}>
                        <Home className="w-3.5 h-3.5" />
                        {delivery.store?.name || 'Store'}
                      </div>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                        delivery.status === 'completed' ? 'text-emerald-700 bg-emerald-100' :
                        delivery.status === 'failed' || delivery.status === 'cancelled' ? 'text-red-700 bg-red-100' :
                        delivery.status === 'returned' ? 'text-orange-700 bg-orange-100' :
                        delivery.status === 'in_transit' ? 'text-blue-700 bg-blue-100' :
                        'text-slate-600 bg-slate-100'
                      }`}>
                        {delivery.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-slate-600)' }}>
                      <Truck className="w-3.5 h-3.5" />
                      {delivery.driver?.user_name || 'Unknown Driver'}
                    </div>
                    {(() => {
                      const isFinished = FINISHED_STATUSES.includes(delivery.status);
                      const finishedTime = delivery.actual_delivery_time ? format(new Date(delivery.actual_delivery_time), 'HH:mm') : null;
                      
                      if (isFinished && finishedTime) {
                        return (
                          <div className="flex items-center gap-1 text-xs text-emerald-600">
                            <Clock className="w-3.5 h-3.5" />
                            {finishedTime}
                          </div>
                        );
                      } else if (delivery.delivery_time_eta) {
                        return (
                          <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-slate-600)' }}>
                            ETA: {delivery.delivery_time_eta}
                          </div>
                        );
                      }
                      return null;
                    })()}
                  </div>
                </Popup>
              )}
              {/* NEW: Popup for other drivers' deliveries - with unified cluster view */}
              {delivery.isOtherDriver && (
                isClustered && !isFanned ? (
                  // Clustered other driver markers - grouped by driver+store
                  <Popup autoPan={false} closeButton={false} offset={[0, -20]} className="custom-popup">
                    <div className="min-w-[200px] max-w-[300px] space-y-0">
                      <div className="font-semibold text-sm pb-1 border-b mb-1" style={{ color: 'var(--text-slate-900)', borderColor: 'var(--border-slate-200)' }}>
                        {delivery.duplicateCount} stops at this location
                      </div>
                      {(() => {
                        const locationKey = `${delivery.latitude.toFixed(6)},${delivery.longitude.toFixed(6)}`;
                        const pickupsAtLocation = groupedPickupMarkers.get(locationKey) || [];
                        const deliveriesAtLocation = groupedDeliveryMarkers.get(locationKey) || [];
                        const allMarkersAtLocation = [...pickupsAtLocation, ...deliveriesAtLocation]
                          .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
                        
                        // Group by driver + store
                        const groups = [];
                        let currentGroup = null;
                        
                        allMarkersAtLocation.forEach((m) => {
                          const driverId = m.driver?.user_name || 'Unknown';
                          const storeId = m.store?.name || 'Store';
                          const key = `${driverId}|${storeId}`;
                          
                          if (!currentGroup || currentGroup.key !== key) {
                            currentGroup = { key, driver: driverId, store: storeId, items: [] };
                            groups.push(currentGroup);
                          }
                          currentGroup.items.push(m);
                        });
                        
                        return groups.map((group, groupIdx) => (
                          <div key={`group-${groupIdx}`}>
                            <div className="px-1 pt-1 pb-1.5 space-y-0.5">
                              <div className="flex items-center gap-1.5 font-medium text-xs" style={{ color: 'var(--text-slate-900)' }}>
                                <Truck className="w-3.5 h-3.5 flex-shrink-0" />
                                {group.driver}
                              </div>
                              <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-slate-600)' }}>
                                <Home className="w-3.5 h-3.5 flex-shrink-0" />
                                {group.store}
                              </div>
                            </div>
                            <div className="border-b" style={{ borderColor: 'var(--border-slate-200)' }} />
                            <div className="px-1 py-1.5 space-y-1">
                              {group.items.map((m) => {
                                const isFinished = FINISHED_STATUSES.includes(m.status);
                                const isFailed = m.status === 'failed' || m.status === 'cancelled';
                                const finishedTime = m.actual_delivery_time ? format(new Date(m.actual_delivery_time), 'HH:mm') : null;
                                const itemName = m.markerType === 'pickup' ? 'Store Pickup' : (m.patient?.full_name || 'Patient');
                                
                                return (
                                  <div 
                                    key={`item-${m.id}`} 
                                    className="text-xs cursor-pointer hover:bg-slate-50 transition-colors px-1 py-0.5 rounded flex items-center justify-between"
                                    onClick={() => {
                                      const popups = document.querySelectorAll('.leaflet-popup');
                                      popups.forEach(p => p.remove());
                                      const cardElement = document.getElementById(`stop-card-${m.id}`);
                                      if (cardElement) {
                                        cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                                      }
                                    }}
                                  >
                                    <div className="flex items-center gap-1.5" style={{ color: 'var(--text-slate-900)' }}>
                                      <User className="w-3 h-3 flex-shrink-0" />
                                      <span>{itemName}</span>
                                    </div>
                                    <div className="flex items-center gap-1">
                                      {isFinished && finishedTime ? (
                                        <>
                                          <span className="text-emerald-600">{finishedTime}</span>
                                          {isFailed ? (
                                            <XCircle className="w-3.5 h-3.5 text-red-600 flex-shrink-0" />
                                          ) : (
                                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" />
                                          )}
                                        </>
                                      ) : m.delivery_time_eta ? (
                                        <>
                                          <span style={{ color: 'var(--text-slate-600)' }}>{m.delivery_time_eta}</span>
                                          <Clock className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-slate-500)' }} />
                                        </>
                                      ) : null}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                            {groupIdx < groups.length - 1 && (
                              <div className="border-b" style={{ borderColor: 'var(--border-slate-200)' }} />
                            )}
                          </div>
                        ));
                      })()}
                    </div>
                  </Popup>
                ) : (
                  // Non-clustered other driver delivery - same layout as clustered
                  <Popup autoPan={false} closeButton={false} offset={[0, -20]} className="custom-popup">
                    <div className="min-w-[200px] max-w-[300px] space-y-0">
                      <div className="px-1 pt-1 pb-1.5 space-y-0.5">
                        <div className="flex items-center gap-1.5 font-medium text-xs" style={{ color: 'var(--text-slate-900)' }}>
                          <Truck className="w-3.5 h-3.5 flex-shrink-0" />
                          {delivery.driver?.user_name || 'Unknown'}
                        </div>
                        <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-slate-600)' }}>
                          <Home className="w-3.5 h-3.5 flex-shrink-0" />
                          {delivery.store?.name || 'Store'}
                        </div>
                      </div>
                      <div className="border-b" style={{ borderColor: 'var(--border-slate-200)' }} />
                      <div className="px-1 py-1.5">
                        {(() => {
                          const isFinished = FINISHED_STATUSES.includes(delivery.status);
                          const isFailed = delivery.status === 'failed' || delivery.status === 'cancelled';
                          const finishedTime = delivery.actual_delivery_time ? format(new Date(delivery.actual_delivery_time), 'HH:mm') : null;
                          const itemName = delivery.patient?.full_name || 'Patient';
                          
                          return (
                            <div className="text-xs flex items-center justify-between">
                              <div className="flex items-center gap-1.5" style={{ color: 'var(--text-slate-900)' }}>
                                <User className="w-3 h-3 flex-shrink-0" />
                                <span>{itemName}</span>
                              </div>
                              <div className="flex items-center gap-1">
                                {isFinished && finishedTime ? (
                                  <>
                                    <span className="text-emerald-600">{finishedTime}</span>
                                    {isFailed ? (
                                      <XCircle className="w-3.5 h-3.5 text-red-600 flex-shrink-0" />
                                    ) : (
                                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" />
                                    )}
                                  </>
                                ) : delivery.delivery_time_eta ? (
                                  <>
                                    <span style={{ color: 'var(--text-slate-600)' }}>{delivery.delivery_time_eta}</span>
                                    <Clock className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-slate-500)' }} />
                                  </>
                                ) : null}
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  </Popup>
                )
              )}
            </Marker>
          ];
        })}

        {/* Driver Location Markers - Green for on_duty, Orange for on_break, with driver initial */}
        {/* Orange outer ring indicates stale location (>5 minutes old) */}
        {/* Blue outer ring for drivers on break viewing their own location from other devices */}
        {driverLocationMarkers.map((location, locationIndex) => {
          // CRITICAL: Validate coordinates before rendering marker
          if (!location.latitude || !location.longitude ||
              typeof location.latitude !== 'number' || typeof location.longitude !== 'number' ||
              isNaN(location.latitude) || isNaN(location.longitude)) {
            console.warn('[DeliveryMap] Invalid driver location coordinates:', location);
            return null;
          }
          
          const statusLabel = location.driver_status === 'on_duty' ? 'On Duty' : 'On Break';
          const statusColor = location.driver_status === 'on_duty' ? 'text-emerald-600' : 'text-orange-600';
          const isOnBreakSelf = location.isOnBreak === true;
          const driverName = location.driverName || 'Unknown Driver';
          const firstName = driverName.split(' ')[0];
          
          // CRITICAL: Use unique key with index to prevent duplicate key errors
          const uniqueKey = `driver-location-${location.id || location.user_id}-${locationIndex}`;
          
          return (
            <Marker
              key={uniqueKey}
              position={[location.latitude, location.longitude]}
              icon={createDriverIcon(location.driver_status, location.driverInitial, location.isStaleLocation, isOnBreakSelf)}
              zIndexOffset={3000}
              data-driver-location-id={location.id}
              eventHandlers={{
                click: () => onMarkerClick && onMarkerClick(location, 'driver'),
                mouseover: (e) => {
                  // Clear any pending timeout
                  if (popupTimeoutsRef.current[location.id]) {
                    clearTimeout(popupTimeoutsRef.current[location.id]);
                    popupTimeoutsRef.current[location.id] = null;
                  }
                  e.target.openPopup();
                },
                mouseout: (e) => {
                  // Delay closing by 2 seconds to allow popup interaction
                  popupTimeoutsRef.current[location.id] = setTimeout(() => {
                    e.target.closePopup();
                  }, 2000);
                }
              }}>

              <Popup
                autoPan={false}
                closeButton={false}
                offset={[0, -20]}
                className="custom-popup"
                onOpen={() => {
                  // Keep popup open when hovering over it
                  const popup = document.querySelector(`[data-driver-location-id="${location.id}"] + .leaflet-popup`);
                  if (popup) {
                    popup.addEventListener('mouseenter', () => handleDriverLocationPopupHover(location.id, true));
                    popup.addEventListener('mouseleave', () => handleDriverLocationPopupHover(location.id, false));
                  }
                }}>

                <div className="min-w-[150px]">
                  <div className="flex items-center gap-1.5">
                    <Car className="w-3.5 h-3.5 text-indigo-600" />
                    <h3 className="font-semibold text-xs">
                      {location.isSelf ? 'Your Phone' : driverName}
                    </h3>
                  </div>
                  {location.driver?.phone && (
                    <div className="text-xs mt-2 space-y-1">
                      <p>
                        <a href={`tel:${location.driver.phone}`} className="text-blue-600 hover:text-blue-700 underline font-medium">
                          📞 {formatPhoneNumber(location.driver.phone)}
                        </a>
                      </p>
                      {isMobile && (
                        <p>
                          <a href={`sms:${location.driver.phone}`} className="text-green-600 hover:text-green-700 underline font-medium">
                            💬 Message
                          </a>
                        </p>
                      )}
                    </div>
                  )}
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
                  <button
                    onClick={() => {
                      const url = `https://www.google.com/maps/dir/?api=1&destination=${location.latitude},${location.longitude}`;
                      window.open(url, '_blank');
                    }}
                    className="w-full mt-3 px-2 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs rounded flex items-center justify-center gap-2 transition-colors"
                    title={`Navigate to ${firstName}'s location`}
                  >
                    📍 Go to {firstName}
                  </button>
                </div>
              </Popup>
            </Marker>
          );
        })}



        {/* NEW: Driver Home Location Markers - Only for active routes */}
        {driverHomeMarkers.map((home) => {
          // CRITICAL: Validate coordinates before rendering marker
          if (!home.latitude || !home.longitude ||
              typeof home.latitude !== 'number' || typeof home.longitude !== 'number' ||
              isNaN(home.latitude) || isNaN(home.longitude)) {
            console.warn('[DeliveryMap] Invalid home marker coordinates:', home);
            return null;
          }
          
          return (
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
          );
        })}
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
              {driverRoutes.map((route) => (
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