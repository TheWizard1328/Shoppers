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

// Driver color palette for "All Drivers" mode - contrasting colors without red, yellow, orange, or green
const DRIVER_COLORS = [
  '', // Blank color storage for unused 0 index - will be handled by getDriverColor fallback
  '#2196F3', // Blue (Index 1)
  '#9C27B0', // Purple (Index 2)
  '#E91E63', // Pink (Index 3)
  '#FF5722', // Deep Orange (Index 4)
  '#607D8B', // Blue Grey (Index 5)
  '#03A9F4', // Light Blue (Index 6)
  '#00BCD4', // Cyan (Index 7)
  '#795548', // Brown (Index 8)
  '#FFC107', // Amber (Index 9)
  '#4CAF50', // Green (Index 10)
  '#8BC34A', // Light Green (Index 11)
  '#FF9800' // Orange (Index 12)
];

// NEW: Simple circle marker for dispatcher view (other stores)
// CRITICAL: Memoized icon cache to prevent re-creation on every render
const simpleCircleIconCache = new Map();

const createSimpleCircleIcon = (status, number, zoomLevel, isMobile = false) => {
  // Create cache key based on all parameters that affect the icon
  const cacheKey = `${status}_${number}_${zoomLevel}_${isMobile}`;
  
  // Return cached icon if it exists
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

  const color = statusColors[status] || '#94A3B8';
  const textColor = getContrastColor(color);

  // CRITICAL: Match exact sizing from regular markers
  let baseSize = 24 * 0.75; // Same as regular markers
  if (zoomLevel >= ZOOM_LEVELS.FULL_DETAIL) {
    baseSize = 28 * 0.75;
  } else if (zoomLevel < ZOOM_LEVELS.SIMPLIFY_ROUTES) {
    baseSize = 20 * 0.75;
  }
  
  // Reduce size for pending status
  if (status === 'pending') {
    baseSize *= 0.75;
  }
  
  if (isMobile) {
    baseSize *= 1.25;
  }

  // Match font size calculation from regular markers (for numbers inside circles)
  const fontSize = 7; // Reduced from 9.5 for smaller circles

  const icon = L.divIcon({
    html: `
      <div class="simple-circle-marker" style="
        width: ${baseSize}px;
        height: ${baseSize}px;
        background-color: ${color};
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: ${fontSize}px;
        font-weight: bold;
        color: ${textColor};
        box-shadow: 0 2px 5px rgba(0,0,0,0.3);
        border: 2px solid white;
      ">
        ${number || ''}
      </div>
    `,
    className: 'custom-simple-circle-icon',
    iconSize: [baseSize, baseSize],
    iconAnchor: [baseSize / 2, baseSize / 2]
  });
  
  // Cache the icon
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

// NEW: Zoom level thresholds for dynamic display
const ZOOM_LEVELS = {
  HIDE_ROUTES: 10, // Below this, hide routes completely
  SIMPLIFY_ROUTES: 12, // Below this, simplify route lines
  HIDE_NUMBERS: 11, // Below this, hide stop numbers
  HIDE_CIRCLES: 11, // Below this, hide pickup circles
  FULL_DETAIL: 13 // At or above this, show full detail
};

// Helper for checking if user is an app owner (platform admin role)
// MODIFIED: Create icons with zoom-aware sizing - REMOVED duplicateCount badge
const createStoreIcon = (status, storeColor = '#6B7280', isActive = false, number = null, zoomLevel = 12, duplicateCount = 0, isMobile = false, isHighlighted = false, isNextDelivery = false) => {
  const innerColor = isNextDelivery ? '#3B82F6' : getInnerSymbolColor(status, true);
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
  
  // Increase size for mobile devices
  if (isMobile) {
    baseSize *= 1.25;
  }
  
  // Enlarge if highlighted (from card hover/selection)
  let size = isActive ? baseSize * 1.15 : baseSize;
  if (isHighlighted) {
    size = baseSize * 1.35; // 35% larger when highlighted
  }
  
  const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
  const numberColor = finishedStatuses.includes(status) ? 'black' : getContrastColor(storeColor);

  return L.divIcon({
    html: `
      <div class="store-marker ${isHighlighted ? 'highlighted' : ''}" style="
        width: ${size}px;
        height: ${size * 1.4}px;
        position: relative;
        cursor: pointer;
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
        .store-marker:hover,
        .store-marker.highlighted {
          z-index: 9999 !important;
          transform: scale(1.25);
          transition: transform 0.2s ease;
        }
        .leaflet-marker-icon:has(.store-marker:hover),
        .leaflet-marker-icon:has(.store-marker.highlighted) {
          z-index: 9999 !important;
        }
      </style>
    `,
    className: 'custom-store-icon',
    iconSize: [size, size * 1.4],
    iconAnchor: [size / 2, size * 1.4]
  });
};

// Helper function to create delivery pin markers with circle - REMOVED duplicateCount badge
const createDeliveryIcon = (status, storeColor = '#6B7280', isActive = false, number = null, isFirstTime = false, duplicateCount = 0, zoomLevel = 12, isMobile = false, isNextInLine = false, isHighlighted = false) => {
  const statusColor = isNextInLine ? '#3B82F6' : getInnerSymbolColor(status, false);
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
  
  // Increase size for mobile devices
  if (isMobile) {
    baseSize *= 1.25;
  }
  
  // Enlarge if highlighted (from card hover/selection)
  let size = isActive ? baseSize * 1.15 : baseSize;
  if (isHighlighted) {
    size = baseSize * 1.35; // 35% larger when highlighted
  }
  
  const finishedStatuses = ['completed', 'delivered', 'failed', 'cancelled', 'returned'];
  const numberColor = isNextInLine ? '#FFFFFF' : (finishedStatuses.includes(status) ? 'black' : getContrastColor(statusColor));

  return L.divIcon({
    html: `
      <div class="delivery-marker ${isHighlighted ? 'highlighted' : ''}" style="
        width: ${size}px;
        height: ${size * 1.4}px;
        position: relative;
        cursor: pointer;
      ">
        <svg width="${size}" height="${size * 1.4}" viewBox="0 0 24 34" xmlns="http://www.w3.org/2000/svg">
          <!-- Pin shape with STORE COLOR - rounder, more compact -->
          <path d="M12 0C5.373 0 0 5.373 0 12c0 9 12 22 12 22s12-13 12-22C24 5.373 18.627 0 12 0z" 
                fill="${storeColor}" 
                stroke="#FFFFFF" 
                stroke-width="1.2"
                style="filter: drop-shadow(0 2px 3px rgba(0,0,0,0.3));" />
          
          ${hasYellowHalo ? `
            <!-- Yellow halo for new/first time deliveries - wider and brighter -->
            <circle cx="12" cy="12" r="7.5" 
                    fill="none" 
                    stroke="#FBBF24" 
                    stroke-width="5.5" 
                    opacity="1" />
          ` : ''}
          
          <!-- Inner STATUS circle - larger -->
          <circle cx="12" cy="12" r="8" 
                  fill="${statusColor}" 
                  stroke="${storeColor}" 
                  stroke-width="1.2" />
          
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
        .delivery-marker:hover,
        .delivery-marker.highlighted {
          z-index: 9999 !important;
          transform: scale(1.25);
          transition: transform 0.2s ease;
        }
        .leaflet-marker-icon:has(.delivery-marker:hover),
        .leaflet-marker-icon:has(.delivery-marker.highlighted) {
          z-index: 9999 !important;
        }
      </style>
    `,
    className: 'custom-delivery-icon',
    iconSize: [size, size * 1.4],
    iconAnchor: [size / 2, size * 1.4]
  });
};

const createDriverIcon = (color = '#ef4444', initial = '') => {
  const size = 30; // Increased size slightly to accommodate initial
  
  return L.divIcon({
    html: `
      <div class="driver-marker" style="
        position: relative;
        width: ${size}px;
        height: ${size}px;
      ">
        <div style="
          background-color: ${color};
          border: 3px solid white;
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
            font-size: 16px;
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
        }
        .live-location-dot:hover {
          transform: scale(1.2);
          transition: transform 0.2s ease;
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
        .home-marker:hover {
          z-index: 9999 !important;
          transform: scale(1.25);
          transition: transform 0.2s ease;
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
  patients = [],
  stores = [],
  users = [], // This `users` prop is crucial, it contains merged AppUser data
  currentUser,
  driverLocations = [], // Legacy prop for multiple driver locations
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
  retractClustersRef, // NEW: Ref to allow parent to retract clusters
  stopCardsHeight = 0, // NEW: Height of the horizontal stop cards for fitBounds padding
  currentToNextPolyline = null, // NEW: Google Maps polyline from current position to next stop
  statsCardPositioning = '', // NEW: CSS classes for stats card positioning
  isStatsCardExpanded = false, // NEW: Whether stats card is expanded
  statsCardRect = null, // NEW: Stats card bounding rect for legend positioning
  highlightedDeliveryId = null, // NEW: ID of delivery to highlight (from card hover/selection)
  highlightedStoreId = null, // NEW: ID of store to highlight with pulsing halo when card is selected
  STOP_CARDS_BASE_HEIGHT = 145, // NEW: Base height for stop cards
  areStopCardsVisible = false, // NEW: Whether stop cards are visible
  onDriverRoutesCalculated = () => {}, // NEW: Callback to pass driver routes to parent
  onCenterOnSelectedStop = null // NEW: Callback to request map centering on selected stop
}) {
  const mapRef = useRef(null);
  const [map, setMap] = useState(null);
  const [hoveredMarkerId, setHoveredMarkerId] = useState(null);
  const markerRefs = useRef({});
  const [hasInitialFit, setHasInitialFit] = useState(false);
  const [currentZoom, setCurrentZoom] = useState(zoom);
  const isMobile = useMemo(() => isMobileDevice(), []); // MODIFIED: Use isMobileDevice utility function
  const [googleRouteCoordinates, setGoogleRouteCoordinates] = useState(null);

  // NEW: State for interactive route highlighting
  const [highlightedRouteId, setHighlightedRouteId] = useState(null);
  
  // NEW: State for fanning out markers
  const [fannedLocationKey, setFannedLocationKey] = useState(null);
  
  // NEW: Ref and state for legend positioning
  const legendRef = useRef(null);
  const [legendLeft, setLegendLeft] = useState(null);

  // NEW: Expose retract function to parent via ref
  useEffect(() => {
    if (retractClustersRef) {
      retractClustersRef.current = () => setFannedLocationKey(null);
    }
  }, [retractClustersRef]);

  // NEW: State for zoom level overlay
  const [showZoomOverlay, setShowZoomOverlay] = useState(false);

  // NEW: State for delayed popups
  const popupTimeoutRef = useRef(null);

  // NEW: State for map center coordinates (for app owner crosshair)
  const [mapCenter, setMapCenter] = useState(center);
  
  // NEW: State for pulsing halo on selected markers
  const [pulsingMarkerId, setPulsingMarkerId] = useState(null);
  const [pulsingStoreId, setPulsingStoreId] = useState(null);
  
  // NEW: State for visible bounds debug box
  const [visibleBounds, setVisibleBounds] = useState(null);
  


  // REMOVED: useEffect for window resize listener for isMobile, as useMemo handles it once.

  // Add safety checks for required props
  const safeDeliveries = Array.isArray(deliveries) ? deliveries : [];
  const safePatients = Array.isArray(patients) ? patients : [];
  const safeStores = Array.isArray(stores) ? stores : [];
  const safeUsers = Array.isArray(users) ? users : [];
  const safeDriverLocations = Array.isArray(driverLocations) ? driverLocations : [];

  // Determine if we're in single driver mode
  const isSingleDriverMode = useMemo(() => {
    if (!safeDeliveries || safeDeliveries.length === 0) return false;
    const uniqueDriverIds = new Set(safeDeliveries.map((delivery) => delivery?.driver_id).filter(Boolean));
    return uniqueDriverIds.size === 1;
  }, [safeDeliveries]);

  // Get the selected date from deliveries
  const selectedDate = useMemo(() => {
    if (!safeDeliveries || safeDeliveries.length === 0) return null;
    // Assuming all deliveries in 'deliveries' prop are for the same date.
    // Or we can take the first one's date as a reference.
    return safeDeliveries[0]?.delivery_date;
  }, [safeDeliveries]);

  // Separate pickups from patient deliveries
  const { pickups, patientDeliveries } = useMemo(() => {
    const pickups = safeDeliveries.filter((d) => d && !d.patient_id && d.store_id);
    const patientDeliveries = safeDeliveries.filter((d) => d && d.patient_id);
    return { pickups, patientDeliveries };
  }, [safeDeliveries]);

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
      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
      const hasStarted = safeDeliveries.some((d) =>
        ['in_transit', ...finishedStatuses].includes(d.status)
      );

      // For pre-route polylines, only show if route hasn't started
      // For active routes, we use currentToNextPolyline instead
      if (hasStarted) {
        console.log('⏭️ [DeliveryMap] Route already started, not displaying pre-route polyline');
        setGoogleRouteCoordinates(null);
        return;
      }

      try {
        console.log('🗺️ [DeliveryMap] Fetching stored route polyline:', {
          driverId,
          deliveryDate
        });

        const coordinates = await getStoredRouteCoordinates(
          driverId,
          deliveryDate,
          'to_first_stop' // This parameter is ignored now - we fetch by driver_id + date
        );

        if (coordinates && coordinates.length > 0) {
          console.log('✅ [DeliveryMap] Google route loaded:', coordinates.length, 'points');
          // Convert {lat, lng} to [lat, lng] for Leaflet
          const leafletCoords = coordinates.map((coord) => [coord.lat, coord.lng]);
          setGoogleRouteCoordinates(leafletCoords);
        } else {
          console.log('📍 [DeliveryMap] No Google route available yet (no encoded_polyline in record)');
          setGoogleRouteCoordinates(null);
        }
      } catch (error) {
        console.error('❌ [DeliveryMap] Error fetching Google route:', error);
        setGoogleRouteCoordinates(null);
      }
    };

    fetchGoogleRoute();
  }, [safeDeliveries, isSingleDriverMode, showRoutes]);

  // Get coordinates for deliveries and pickups - UNIFIED CLUSTER TRACKING
  const { deliveryMarkers, groupedDeliveryMarkers, pickupMarkers, groupedPickupMarkers } = useMemo(() => {
    // Determine the next in-line delivery for each driver
    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
    const nextDeliveryByDriver = new Map();
    
    // Group deliveries by driver and find the first incomplete one
    const deliveriesByDriver = new Map();
    patientDeliveries.forEach((delivery) => {
      if (!delivery || !delivery.driver_id) return;
      if (!deliveriesByDriver.has(delivery.driver_id)) {
        deliveriesByDriver.set(delivery.driver_id, []);
      }
      deliveriesByDriver.get(delivery.driver_id).push(delivery);
    });
    
    deliveriesByDriver.forEach((driverDeliveries, driverId) => {
      // Sort by stop_order
      const sorted = [...driverDeliveries].sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
      // Find first incomplete delivery
      const nextDelivery = sorted.find((d) => !finishedStatuses.includes(d.status) && d.status !== 'pending');
      if (nextDelivery) {
        nextDeliveryByDriver.set(driverId, nextDelivery.id);
      }
    });

    // Process delivery markers
    const deliveryMarkersRaw = patientDeliveries.map((delivery) => {
      if (!delivery) return null;

      const patient = safePatients.find((p) => p && p.id === delivery.patient_id);
      if (!patient?.latitude || !patient?.longitude) return null;

      // FIXED: Find driver by ID only, don't require user_name in find condition
      const driver = safeUsers.find((u) => u && typeof u === 'object' && u.id === delivery.driver_id);
      const store = safeStores.find((s) => s && s.id === delivery.store_id);

      // Check if this is a first-time delivery
      const isFirstTime = isFirstTimeDelivery(delivery);

      // Determine if dispatcher should see simple circle for this stop
      const isCurrentUserDispatcher = userHasRole(currentUser, 'dispatcher');
      const isStopInDispatcherStore = isCurrentUserDispatcher && currentUser.store_ids && store && currentUser.store_ids.includes(store.id);
      const useSimpleCircle = isCurrentUserDispatcher && !isStopInDispatcherStore;

      // Check if this is the next in-line delivery for its driver
      const isNextInLine = nextDeliveryByDriver.get(delivery.driver_id) === delivery.id;

      // CRITICAL: Check if delivery has no pickup (missing PUID)
      // Only check for patient deliveries - pickups don't need PUID validation
      const hasNoPickup = delivery.patient_id && (!delivery.puid || delivery.puid.trim() === '');

      // Determine pin color based on mode
      let pinColor;
      if (hasNoPickup) {
        // Bright yellow for PATIENT deliveries with no associated pickup
        pinColor = '#FBBF24';
      } else if (isSingleDriverMode) {
        // Single driver mode: use store colors
        pinColor = store ? getStoreColor(store) : '#6B7280';
      } else {
        // All drivers mode: use driver colors, with fallback
        pinColor = driver && typeof driver === 'object' ? getDriverColor(driver) : '#607D8B';
      }

      return {
        ...delivery,
        latitude: patient.latitude,
        longitude: patient.longitude,
        patient,
        driver,
        store,
        pinColor,
        number: delivery.display_stop_order || delivery.stop_order || 0,
        isFirstTime,
        isNextInLine,
        markerType: 'delivery',
        useSimpleCircle
      };
    }).filter(Boolean);

    // Process pickup markers
    const pickupMarkersRaw = pickups.map((pickup) => {
      if (!pickup) return null;

      const store = safeStores.find((s) => s && s.id === pickup.store_id);
      if (!store?.latitude || !store?.longitude) return null;

      // FIXED: Find driver by ID only, don't require user_name in find condition
      const driver = safeUsers.find((u) => u && typeof u === 'object' && u.id === pickup.driver_id);

      // CRITICAL: Pickups should NEVER use simple circles - they always show full store pickup markers
      const useSimpleCircle = false;

      // Store pickups ALWAYS use store colors (both modes)
      const pinColor = getStoreColor(store);

      return {
        ...pickup,
        latitude: store.latitude,
        longitude: store.longitude,
        store,
        pinColor,
        driver,
        number: pickup.display_stop_order || pickup.stop_order || 0,
        markerType: 'pickup',
        useSimpleCircle
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
      groupedPickupMarkers: groupedPickups
    };
  }, [patientDeliveries, pickups, safePatients, safeStores, safeUsers, isSingleDriverMode, currentUser]);

  // NEW: Calculate fanned-out positions with corrected linear radius scaling
  const calculateFannedPosition = useCallback((originalLat, originalLng, markerIndex, totalMarkers, stopOrder) => {
    // Only fan between zoom levels 11-18
    if (currentZoom < 11 || currentZoom > 18) {
      return [originalLat, originalLng];
    }

    // Base radius at maximum zoom level 18
    const baseRadius = 0.0008; // ~80 meters at max zoom
    const dynamicRadius = 0.0008; // Multiplier per zoom level
    
    // Calculate radius using the formula: Radius = BaseRadius + (18 - Zoom level) * DynamicRadius
    const radius = baseRadius + (18 - currentZoom) * dynamicRadius;

    // DEBUG: Log calculation
    console.log('🎯 [Fanning] Calculation:', {
      currentZoom,
      zoomDelta: 18 - currentZoom,
      radius: radius.toFixed(6),
      totalMarkers
    });

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
    
    // If this marker is part of a cluster (duplicateCount > 1)
    if (marker.duplicateCount > 1) {
      console.log('🎯 [Cluster Click] Detected cluster at:', locationKey);
      
      // CRITICAL: Notify parent IMMEDIATELY to lock map view (before ANY checks)
      if (onMapInteraction) {
        console.log('🔒 [Cluster Click] Calling onMapInteraction to lock FAB');
        onMapInteraction();
      }
      
      // If already fanned, retract and select card
      if (fannedLocationKey === locationKey) {
        console.log('✅ Fanned marker clicked - retracting cluster and selecting card');
        setFannedLocationKey(null); // Retract
        if (onMarkerClick) {
          onMarkerClick(marker);
        }
        return;
      }
      
      console.log('🎯 [Cluster Click] Proceeding to zoom/center/fan at:', locationKey);
      
      // FIXED: Get ALL markers at this location (both pickups AND deliveries)
      const deliveriesAtLocation = groupedDeliveryMarkers.get(locationKey) || [];
      const pickupsAtLocation = groupedPickupMarkers.get(locationKey) || [];
      const markersAtLocation = [...pickupsAtLocation, ...deliveriesAtLocation];
      
      console.log('📍 Found', markersAtLocation.length, 'markers at location (', pickupsAtLocation.length, 'pickups +', deliveriesAtLocation.length, 'deliveries)');
      
      // Sort markers by stop_order for consistent fanning
      markersAtLocation.sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
      
      // Calculate bounds to include center point and all fanned positions
      const bounds = L.latLngBounds([marker.latitude, marker.longitude]);
      
      // Calculate fanned positions and extend bounds
      markersAtLocation.forEach((m, index) => {
        const [fannedLat, fannedLng] = calculateFannedPosition(
          marker.latitude,
          marker.longitude,
          index,
          markersAtLocation.length,
          m.stop_order
        );
        bounds.extend([fannedLat, fannedLng]);
        console.log(`  Fan ${index + 1}/${markersAtLocation.length} (${m.markerType}):`, [fannedLat, fannedLng]);
      });
      
      console.log('📐 Bounds calculated:', bounds.toBBoxString());
      
      // Zoom and center on cluster location (if map is available)
      if (map) {
        // First, zoom to 14 centered on the cluster
        map.setView([marker.latitude, marker.longitude], 14, { 
          animate: true, 
          duration: 0.6 
        });
        
        // Then fit bounds to show all fanned markers
        setTimeout(() => {
          console.log('🗺️ Fitting bounds after zoom...');
          map.fitBounds(bounds, { 
            padding: [80, 80], 
            maxZoom: 14,
            animate: true,
            duration: 0.3
          });
          
          // Fan out the markers
          setFannedLocationKey(locationKey);
          console.log('✅ Fanned location key set:', locationKey);
        }, 650);
      } else {
        console.warn('⚠️ Map not available - skipping zoom/pan but fanning markers');
        setFannedLocationKey(locationKey);
      }
      
      // Don't call onMarkerClick when fanning - only when already fanned
      return;
    }
    
    // Retract any expanded cluster and call onMarkerClick for non-clustered markers
    setFannedLocationKey(null);
    if (onMarkerClick) {
      onMarkerClick(marker);
    }
    // Notify parent that map interaction occurred (marker click)
    if (onMapInteraction) {
      onMapInteraction();
    }
  }, [fannedLocationKey, onMarkerClick, currentZoom, map, groupedDeliveryMarkers, groupedPickupMarkers, calculateFannedPosition, onMapInteraction]);

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

  // Process driver locations - Show current user's location as green/orange dot on non-mobile devices
  // Show other drivers' locations based on location_tracking_enabled
  const driverLocationMarkers = useMemo(() => {
    // Only show driver markers when viewing current date
    if (!isViewingCurrentDate) {
      console.log('🗺️ [DeliveryMap] Not viewing current date - hiding driver markers');
      return [];
    }

    console.log('🗺️ [DeliveryMap] Processing driver locations:', safeDriverLocations.length);

    const isAdmin = currentUser && userHasRole(currentUser, 'admin');
    const currentUserCityId = currentUser?.city_id;
    const currentUserId = currentUser?.id;

    // Active delivery statuses for dispatcher filtering
    const activeDeliveryStatuses = ['pending', 'Ready For Pickup', 'in_transit', 'en_route'];

    return safeDriverLocations.map((location) => {
      if (!location || !location.latitude || !location.longitude) {
        return null;
      }

      const driverId = location.driver_id || location.user_id || location.id;
      const driver = safeUsers.find((u) => u && u.id === driverId);
      
      if (!driver) {
        console.log('  ⏭️ Skipping location: driver not found');
        return null;
      }

      // RULE 1: Current user's own location (green/orange dot for on_duty/on_break)
      const isCurrentUserLocation = driverId === currentUserId;
      
      if (isCurrentUserLocation) {
        // Skip if off_duty
        if (location.driver_status === 'off_duty') {
          console.log('  ⏭️ Skipping current user location: off_duty');
          return null;
        }
        
        // Show green for on_duty, orange for on_break (on non-mobile devices only)
        if (!isMobile) {
          const dotColor = location.driver_status === 'on_duty' ? '#10B981' : '#F97316';
          console.log(`  ✅ Current user location (${location.driver_status}): ${dotColor} dot on desktop`);
          
          return {
            ...location,
            driver,
            driverColor: dotColor,
            driverName: driver.user_name || driver.full_name || 'You',
            driverInitial: (driver.user_name || driver.full_name || 'Y').charAt(0).toUpperCase(),
            isSelf: true,
            driver_status: location.driver_status
          };
        } else {
          console.log('  ⏭️ Skipping current user location: mobile uses blue dot');
          return null;
        }
      }

      // RULE 2: Other drivers - require location_tracking_enabled=true (sharing ON)
      if (location.location_tracking_enabled !== true) {
        console.log(`  ⏭️ Skipping ${driver.user_name || driver.full_name}: location sharing disabled`);
        return null;
      }

      // RULE 3: Must be on_duty (other drivers with on_break don't show to others)
      if (location.driver_status !== 'on_duty') {
        console.log(`  ⏭️ Skipping ${driver.user_name || driver.full_name}: status is ${location.driver_status}`);
        return null;
      }

      // RULE 4: Permission filtering for other drivers
      if (!isAdmin && currentUserCityId !== driver.city_id) {
        console.log(`  ⏭️ Skipping ${driver.user_name || driver.full_name}: different city`);
        return null;
      }

      // RULE 5: Dispatcher filtering - only show drivers with active deliveries for dispatcher's stores
      if (currentUser && userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin')) {
        const dispatcherStoreIds = new Set(currentUser.store_ids || []);
        const hasActiveDeliveryInDispatcherStore = safeDeliveries.some(delivery =>
          delivery &&
          delivery.driver_id === driver.id &&
          dispatcherStoreIds.has(delivery.store_id) &&
          activeDeliveryStatuses.includes(delivery.status)
        );

        if (!hasActiveDeliveryInDispatcherStore) {
          console.log(`  ⏭️ Skipping ${driver.user_name || driver.full_name}: no active deliveries in dispatcher's stores`);
          return null;
        }
      }

      const driverColor = getDriverColor(driver);
      const driverName = driver.user_name || driver.full_name || 'Unknown Driver';
      const driverInitial = driverName ? driverName.charAt(0).toUpperCase() : 'D';

      console.log(`  ✅ ${driverName}: Live GPS marker created (Location sharing enabled, On Duty)`);

      return {
        ...location,
        driver,
        driverColor,
        driverName,
        driverInitial,
        isSelf: false,
        driver_status: location.driver_status
      };
    }).filter(Boolean);
  }, [safeDriverLocations, safeUsers, safeDeliveries, currentUser, isViewingCurrentDate, isMobile]);

  // UPDATED: Process current driver's live location for display - ONLY SHOW ON MOBILE, TODAY'S DATE
  const currentDriverMarker = useMemo(() => {
    if (!currentDriverLocation || !currentUser) {
      return null;
    }

    // CRITICAL: Check if viewing today's date - handle null selectedDate as today
    const today = format(new Date(), 'yyyy-MM-dd');
    const isToday = !selectedDate || selectedDate === today;
    
    if (!isToday) {
      console.log('⏭️ [DeliveryMap] Skipping blue dot - not viewing today:', { selectedDate, today });
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

    // CRITICAL: Only show on mobile devices
    if (!isMobile) {
      console.log('⏭️ [DeliveryMap] Skipping blue dot - not on mobile device');
      return null;
    }

    console.log('🗺️ [DeliveryMap] Processing currentDriverLocation:', currentDriverLocation);

    if (!currentDriverLocation.latitude || !currentDriverLocation.longitude) {
      console.warn('⚠️ [DeliveryMap] currentDriverLocation missing coordinates');
      return null;
    }

    // Show the driver's own location (blue dot) on mobile only
    console.log('✅ [DeliveryMap] Created current driver blue dot marker (mobile):', {
      lat: currentDriverLocation.latitude,
      lon: currentDriverLocation.longitude
    });

    return {
      ...currentDriverLocation,
      driver: currentUser
    };
  }, [currentDriverLocation, currentUser, isMobile, selectedDate]);

  // NEW: Calculate driver home locations for drivers with active stops - CURRENT DATE ONLY
  const driverHomeMarkers = useMemo(() => {
    if (!showRoutes || !currentUser || !isViewingCurrentDate) return [];

    // Check if current user is app owner (Base44 platform admin)
    const isCurrentUserDriver = userHasRole(currentUser, 'driver');
    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];

    // Get drivers with active (unfinished) stops
    const driversWithActiveStops = new Set();

    safeDeliveries.forEach((delivery) => {
      if (!delivery) return;
      if (!finishedStatuses.includes(delivery.status) && delivery.driver_id) {
        driversWithActiveStops.add(delivery.driver_id);
      }
    });

    // Create home markers based on user permissions
    const homeMarkers = [];
    driversWithActiveStops.forEach((driverId) => {
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
  }, [safeDeliveries, safeUsers, showRoutes, currentUser, isViewingCurrentDate]);

  // Generate routes for each driver - NOW WITH ZOOM-BASED STYLING, CURRENT DATE ONLY for polylines
  const driverRoutes = useMemo(() => {
    if (!showRoutes || currentZoom < ZOOM_LEVELS.HIDE_ROUTES) return [];
    
    // For live route polylines (origin lines, pre-routes), only show on current date
    const showLivePolylines = isViewingCurrentDate;

    console.log('🗺️ Building driver routes...');
    console.log('📍 Pickup markers:', pickupMarkers.length);
    console.log('📦 Delivery markers:', deliveryMarkers.length);

    // Define finished statuses
    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
    const activeStatuses = ['in_transit']; // NEW

    // Group deliveries by driver
    const routesByDriver = {};

    deliveryMarkers.forEach((delivery) => {
      if (!delivery) return;
      const driverId = delivery.driver_id || 'unassigned';
      if (!routesByDriver[driverId]) {
        // FIXED: Find driver by ID only, don't require user_name in find condition
        const driverForRoute = safeUsers.find((u) => u && typeof u === 'object' && u.id === driverId);

        // Determine route color based on mode
        const routeColor = isSingleDriverMode ?
          delivery.pinColor // Single driver: use store color from marker
          : driverForRoute && typeof driverForRoute === 'object' ? getDriverColor(driverForRoute) : '#607D8B';

        // FIXED: Use driver object's user_name for display, with proper fallbacks
        const driverDisplayName = driverForRoute ? (driverForRoute.user_name || driverForRoute.full_name || 'Unknown') : 'Unassigned';

        console.log(`🗺️ Creating route for driver ${driverId}:`, {
          found: !!driverForRoute,
          displayName: driverDisplayName,
          user_name: driverForRoute?.user_name,
          full_name: driverForRoute?.full_name
        });

        routesByDriver[driverId] = {
          driverId,
          driverName: driverDisplayName,
          driver: driverForRoute, // Store driver object
          color: routeColor,
          stops: [],
          sortOrder: driverForRoute?.sort_order ?? Infinity
        };
      }
      routesByDriver[driverId].stops.push(delivery);
    });

    // Sort stops by stop_order and create route lines
    const routes = Object.values(routesByDriver).map((route) => {
      // Find ALL pickup locations for this driver
      const driverPickups = pickupMarkers.filter((p) => p.driver_id === route.driverId);

      // Check if all stops (deliveries + pickups) are finished
      const allDeliveriesFinished = route.stops.every((d) => finishedStatuses.includes(d.status));
      const allPickupsFinished = driverPickups.every((p) => finishedStatuses.includes(p.status));
      const isRouteCompleted = allDeliveriesFinished && allPickupsFinished;

      // NEW: Check if route has started (has any in_transit or completed stops)
      const hasActiveStops = route.stops.some((delivery) => delivery && activeStatuses.includes(delivery.status)) ||
        driverPickups.some((p) => p && activeStatuses.includes(p.status));
      const hasCompletedStops = route.stops.some((d) => finishedStatuses.includes(d.status)) ||
        driverPickups.some((p) => p && finishedStatuses.includes(p.status));
      const isRouteStarted = hasActiveStops || hasCompletedStops;

      console.log(`🚗 Route for ${route.driverName}:`, {
        driverId: route.driverId,
        pickupCount: driverPickups.length,
        deliveryStops: route.stops.length,
        isRouteCompleted,
        isRouteStarted,
        allDeliveriesFinished,
        allPickupsFinished
      });

      // Filter stops based on route completion status
      let deliveriesToRoute = route.stops;
      let pickupsToRoute = driverPickups;

      if (!isRouteCompleted) {
        // Route is in-progress: only show unfinished stops (excluding pending)
        deliveriesToRoute = route.stops.filter((delivery) => delivery && !finishedStatuses.includes(delivery.status) && delivery.status !== 'pending');
        pickupsToRoute = driverPickups.filter((p) => p && !finishedStatuses.includes(p.status) && p.status !== 'pending');
        console.log(`  🔄 In-progress route: showing ${deliveriesToRoute.length} unfinished deliveries and ${pickupsToRoute.length} unfinished pickups (excluding pending)`);
      } else {
        console.log(`  ✅ Completed route: showing all ${deliveriesToRoute.length} deliveries and ${pickupsToRoute.length} pickups in stop order`);
      }

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

        // Sort by stop order
        allStops.sort((a, b) => a.stop_order - b.stop_order);

        console.log(`  📋 Combined stops (sorted by stop order):`, allStops.map((s) =>
          `#${s.stop_order} ${s.type === 'pickup' ? `🏪 ${s.store}` : `📦 ${s.patient}`} at ${s.time}`
        ));

        // Extract coordinates in stop order
        coordinates = allStops.map((stop) => [stop.latitude, stop.longitude]);

        // Get first stop coordinates
        if (allStops.length > 0) {
          const firstStop = allStops[0];
          firstStopCoordinates = [firstStop.latitude, firstStop.longitude];
          console.log(`  🏁 First stop: ${firstStop.type === 'pickup' ? firstStop.store : firstStop.patient}`);
        }

        // Get last stop coordinates and determine if home route should show
        if (allStops.length > 0) {
          const lastStop = allStops[allStops.length - 1];
          lastStopCoordinates = [lastStop.latitude, lastStop.longitude];
          // NEW: Only show home route if route is NOT completed
          shouldShowHomeRoute = !isRouteCompleted;
          console.log(`  📍 Last stop: ${lastStop.type === 'pickup' ? lastStop.store : lastStop.patient} at [${lastStop.latitude?.toFixed(4)}, ${lastStop.longitude?.toFixed(4)}]`);
          console.log(`  🏠 Show home route: ${shouldShowHomeRoute}`);
        }

        // NEW: Determine starting point for visualization (routeHasActuallyStarted defined above)
        if (routeHasActuallyStarted && firstStopCoordinates && route.driver) {
          let startPoint = null;

          // Priority 1: Use driver's current location from AppUser if available and recent
          if (route.driver.current_latitude && route.driver.current_longitude && route.driver.location_updated_at) {
            const locationAge = Date.now() - new Date(route.driver.location_updated_at).getTime();
            const fiveMinutesInMs = 5 * 60 * 1000;

            if (locationAge < fiveMinutesInMs) {
              startPoint = [route.driver.current_latitude, route.driver.current_longitude];
              console.log(`  📍 Origin from driver's current location (${Math.round(locationAge / 1000)}s old)`);
            }
          }

          // Priority 2: Use last completed stop location
          if (!startPoint && hasCompletedStops) {
            const completedStopsForDriver = [...route.stops, ...driverPickups]
              .filter((s) => s && finishedStatuses.includes(s.status) && s.actual_delivery_time)
              .sort((a, b) => new Date(b.actual_delivery_time) - new Date(a.actual_delivery_time));

            if (completedStopsForDriver.length > 0) {
              const lastCompleted = completedStopsForDriver[0];
              startPoint = [lastCompleted.latitude, lastCompleted.longitude];
              console.log(`  📍 Origin from last completed stop`);
            }
          }

          // Draw bright red solid line from origin to first incomplete stop
          if (startPoint) {
            startToFirstStopCoordinates = [startPoint, firstStopCoordinates];
            console.log(`  ✅ Will draw BRIGHT RED origin line from start to first incomplete stop`);
          }
        } else if (!isRouteStarted && firstStopCoordinates && route.driver) {
          // Route hasn't started - use home or current location
          let startPoint = null;

          // Priority 1: Use current driver location if this is the current user and available
          if (currentUser && route.driver.id === currentUser.id && currentDriverLocation) {
            startPoint = [currentDriverLocation.latitude, currentDriverLocation.longitude];
            console.log(`  🚀 Pre-route from current location to first stop`);
          }
          // Priority 2: Use driver's home location
          else if (route.driver.home_latitude && route.driver.home_longitude) {
            startPoint = [route.driver.home_latitude, route.driver.home_longitude];
            console.log(`  🏠 Pre-route from home to first stop`);
          }

          if (startPoint) {
            startToFirstStopCoordinates = [startPoint, firstStopCoordinates];
            console.log(`  ✅ Will draw pre-route line from start to first stop`);
          }
        }
      }

      console.log(`  📍 Total route points: ${coordinates.length}`);

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
        totalStops: route.stops.length + driverPickups.length,
        // NEW: Zoom-based styling
        routeWeight,
        routeOpacity,
        showWaypoints
      };
    }).filter((route) => route.coordinates.length >= 2 || route.startToFirstStopCoordinates);

    const sortedRoutes = routes.sort((a, b) => a.sortOrder - b.sortOrder);
    console.log(`✅ Generated ${sortedRoutes.length} routes`);

    return sortedRoutes;
  }, [deliveryMarkers, pickupMarkers, showRoutes, isSingleDriverMode, safeUsers, currentZoom, currentUser, currentDriverLocation, isViewingCurrentDate]);
  
  // Pass driver routes to parent component
  useEffect(() => {
    if (onDriverRoutesCalculated) {
      onDriverRoutesCalculated(driverRoutes);
    }
  }, [driverRoutes, onDriverRoutesCalculated]);

  // NEW: Center map on selected stop and store when highlightedDeliveryId changes
  useEffect(() => {
    if (!highlightedDeliveryId || !map) return;
    
    // Find the delivery/pickup that's highlighted
    const highlightedDelivery = deliveryMarkers.find(d => d.id === highlightedDeliveryId);
    const highlightedPickup = pickupMarkers.find(p => p.id === highlightedDeliveryId);
    const highlightedMarker = highlightedDelivery || highlightedPickup;
    
    if (!highlightedMarker) return;
    
    // Get store coordinates for this delivery
    const store = safeStores.find(s => s && s.id === highlightedMarker.store_id);
    
    // Set pulsing markers
    setPulsingMarkerId(highlightedDeliveryId);
    setPulsingStoreId(store?.id || null);
    
    // Calculate bounds to include both the stop and the store
    const boundsPoints = [[highlightedMarker.latitude, highlightedMarker.longitude]];
    
    if (store?.latitude && store?.longitude && !highlightedPickup) {
      // Only add store to bounds if this isn't a pickup (pickup IS the store)
      boundsPoints.push([store.latitude, store.longitude]);
    }
    
    // If we have multiple points, fit bounds
    if (boundsPoints.length > 1) {
      const bounds = L.latLngBounds(boundsPoints);
      map.fitBounds(bounds, {
        padding: [80, 80],
        maxZoom: 15,
        animate: true,
        duration: 0.5
      });
    } else {
      // Single point - just center on it
      map.setView(boundsPoints[0], Math.max(map.getZoom(), 14), {
        animate: true,
        duration: 0.5
      });
    }
    
    // Clear pulsing after 5 seconds
    const timeout = setTimeout(() => {
      setPulsingMarkerId(null);
      setPulsingStoreId(null);
    }, 5000);
    
    return () => clearTimeout(timeout);
  }, [highlightedDeliveryId, map, deliveryMarkers, pickupMarkers, safeStores]);

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

  // REMOVED: Auto-fit logic that was interfering with FAB-controlled map positioning
  // The FAB (via Dashboard's shouldFitBounds prop) now controls ALL map positioning

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
    // This prevents auto-centering when other props change
    if (!shouldFitBounds) {
      return;
    }

    try {
      console.log('[MapCenter] EXECUTING fitBounds with', shouldFitBounds.bounds.length, 'coordinates');
      const bounds = L.latLngBounds(shouldFitBounds.bounds);
      
      // CRITICAL FIX: Use stopCardsHeight directly as bottom padding
      const modifiedOptions = { 
        ...shouldFitBounds.options,
        animate: true,
        duration: 0.8 // Smooth 800ms animation
      };
      
      if (stopCardsHeight > 0) {
        modifiedOptions.paddingBottomRight = [
          modifiedOptions.paddingBottomRight?.[0] || 50,
          stopCardsHeight + 40
        ];
      }
      
      console.log('[MapCenter] Calling map.fitBounds with smooth animation');
      map.fitBounds(bounds, modifiedOptions);
      console.log('[MapCenter] fitBounds completed');

      if (onBoundsFitted && typeof onBoundsFitted === 'function') {
        onBoundsFitted();
      }
    } catch (error) {
      console.error('[MapCenter] DYNAMIC VIEW error:', error);
    }
  }, [map, shouldFitBounds, stopCardsHeight, onBoundsFitted]);

  // Handle marker drag end
  const handleMarkerDragEnd = useCallback((markerId, event, type) => {
    try {
      const newLatLng = event.target.getLatLng();
      console.log(`📍 Marker dragged - ${type} #${markerId}:`, {
        lat: newLatLng.lat,
        lng: newLatLng.lng
      });

      // You can emit this to parent or save to database here
      // For now, just log it. Add your save logic here if needed.
    } catch (error) {
      console.error('Error handling marker drag:', error);
    }
  }, []);

  // CRITICAL FIX: Simplified MapController - only sets map reference, no conditional hooks
  // NEW: Track zoom level changes and show overlay AND notify parent of map interactions
  function MapController() {
    const mapInstance = useMapEvents({
      zoomend: () => {
        const rawZoom = mapInstance.getZoom();
        const roundedZoom = Math.round(rawZoom * 10) / 10; // Round to 1 decimal place
        
        // Only update state if the rounded zoom actually changed
        if (roundedZoom !== currentZoom) {
          setCurrentZoom(roundedZoom);
          
          // Show zoom overlay for 3 seconds
          setShowZoomOverlay(true);
          setTimeout(() => {
            setShowZoomOverlay(false);
          }, 3000);
        }
        
        // Update visible bounds for debug box
        const bounds = mapInstance.getBounds();
        setVisibleBounds(bounds);
        
        // Notify parent that user zoomed the map
        if (onMapInteraction) {
          onMapInteraction();
        }
      },
      moveend: () => {
        // Notify parent that user panned the map
        if (onMapInteraction) {
          onMapInteraction();
        }
        // Update map center for crosshair - use actual center without adjustments
        const center = mapInstance.getCenter();
        setMapCenter([center.lat, center.lng]);
        
        // Update visible bounds for debug box
        const bounds = mapInstance.getBounds();
        setVisibleBounds(bounds);
      },
      click: () => {
        // Retract clusters on map click
        setFannedLocationKey(null);
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
      <div className="min-w-[220px] max-w-[300px]">
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
          <p className="text-sm font-semibold text-slate-900">
            {isPickup ? store?.address : patient?.full_name}
          </p>

          <p className="text-xs text-slate-600">
            {isPickup ? store?.address : patient?.address}
            {!isPickup && delivery.unit_number && <span className="ml-1">#{delivery.unit_number}</span>}
          </p>

          {delivery.delivery_time_start && (
            <div className="flex items-center gap-1 text-xs text-slate-600">
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
            <div className="flex items-center gap-1 text-xs text-slate-600">
              <Truck className="w-3.5 h-3.5 flex-shrink-0" />
              <span>{driver.user_name || driver.full_name}</span>
            </div>
          )}

          {delivery.prescription_number && (
            <div className="text-xs text-slate-600">
              <span className="font-medium">Rx#</span> {delivery.prescription_number}
            </div>
          )}

          {delivery.tracking_number && (
            <div className="text-xs text-slate-600">
              <span className="font-medium">TR#</span> {delivery.tracking_number}
            </div>
          )}

          {delivery.cod_total_amount_required > 0 && (
            <div className="flex items-center gap-1 text-xs font-semibold text-emerald-700 bg-emerald-50 px-2 py-1 rounded">
              <span>💵 COD: ${delivery.cod_total_amount_required.toFixed(2)}</span>
            </div>
          )}

          {!isPickup && delivery.delivery_instructions && (
            <div className="text-xs text-slate-500 italic border-t border-slate-200 pt-1.5 mt-1.5">
              {delivery.delivery_instructions}
            </div>
          )}

          {delivery.delivery_notes && (
            <div className="text-xs text-blue-600 border-t border-slate-200 pt-1.5 mt-1.5">
              <span className="font-medium">Notes:</span> {delivery.delivery_notes}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="h-full w-full relative overflow-hidden">
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
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

        <MapController />

        {/* NEW: Draw Google Directions route polyline (if available) - CURRENT DATE ONLY */}
        {isViewingCurrentDate && googleRouteCoordinates && googleRouteCoordinates.length > 1 &&
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

        {/* NEW: Current-to-Next-Stop Google Polyline - SOLID BLUE - HIGHEST Z-INDEX - CURRENT DATE ONLY */}
        {isViewingCurrentDate && currentToNextPolyline && currentToNextPolyline.length > 1 &&
          <Polyline
            positions={currentToNextPolyline.map(coord => [coord.lat, coord.lng])}
            pathOptions={{
              color: '#3B82F6', // Solid blue
              weight: 5,
              opacity: 1,
              dashArray: '', // Solid line
              lineJoin: 'round',
              lineCap: 'round'
            }}
            pane="tooltipPane" />
        }

        {/* Draw Routes - NOW WITH INTERACTIVE HIGHLIGHTING */}
        {showRoutes && driverRoutes.map((route, index) => {
          const isHighlighted = highlightedRouteId === route.driverId;
          const routeWeight = isHighlighted ? route.routeWeight * 2 : route.routeWeight;
          const routeOpacity = isHighlighted ? 1 : route.routeOpacity;

          return [
            // Origin to first stop line - HIDDEN if currentToNextPolyline exists or route is completed
            route.startToFirstStopCoordinates && route.isOriginLine && !googleRouteCoordinates && !currentToNextPolyline && !route.isCompleted &&
            <Polyline
              key={`origin-line-${route.driverId}`}
              positions={route.startToFirstStopCoordinates}
              pathOptions={{
                color: '#3B82F6', // Blue
                weight: 4,
                opacity: 1,
                dashArray: '10, 5', // Dashed line
                lineJoin: 'round',
                lineCap: 'round'
              }}
              eventHandlers={{
                click: () => setHighlightedRouteId(isHighlighted ? null : route.driverId),
                mouseover: () => setHighlightedRouteId(route.driverId),
                mouseout: () => setHighlightedRouteId(null)
              }} />,

            // Pre-route line - DASHED for unstarted routes
            route.startToFirstStopCoordinates && !route.isOriginLine && !googleRouteCoordinates &&
            <Polyline
              key={`pre-route-${route.driverId}`}
              positions={route.startToFirstStopCoordinates}
              pathOptions={{
                color: '#3B82F6', // Blue
                weight: routeWeight * 2,
                opacity: isHighlighted ? 1 : route.routeOpacity,
                dashArray: '15, 10',
                lineJoin: 'round',
                lineCap: 'round'
              }}
              eventHandlers={{
                click: () => setHighlightedRouteId(isHighlighted ? null : route.driverId),
                mouseover: () => setHighlightedRouteId(route.driverId),
                mouseout: () => setHighlightedRouteId(null)
              }} />,

            // Main route line - NOW INTERACTIVE
            route.coordinates.length >= 2 &&
            <Polyline
              key={`route-line-${route.driverId}-${index}`}
              positions={route.coordinates}
              pathOptions={{
                color: route.color,
                weight: routeWeight,
                opacity: routeOpacity,
                dashArray: route.hasPickup ? '10, 5' : '10, 10',
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
                  <p className="font-semibold text-slate-900">{route.driverName}</p>
                  <p className="text-slate-600">{route.totalStops} stops</p>
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

            // Home route line - INTERACTIVE
            (() => {
              if (!route.shouldShowHomeRoute || !route.lastStopCoordinates || !route.driver?.home_latitude || !route.driver?.home_longitude) return null;

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

        {/* MOVED: Current Driver's Live Location - BLUE DOT - RENDER FIRST for lower priority */}
        {currentDriverMarker &&
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
        }

        {/* Store Pickup Markers - NOW WITH FANNING */}
        {pickupMarkers.map((pickup, index) => {
          const locationKey = `${pickup.latitude.toFixed(6)},${pickup.longitude.toFixed(6)}`;
          const isClustered = pickup.duplicateCount > 1;
          const isFanned = fannedLocationKey === locationKey;
          
          // Calculate position based on fanning state
          let markerPosition = [pickup.latitude, pickup.longitude];
          let dynamicZIndex;
          
          const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
          const isFinished = finishedStatuses.includes(pickup.status);

          if (isFinished) {
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
            const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
            const isFinished = finishedStatuses.includes(pickup.status);
            const incompleteMarkers = allMarkersAtLocation.filter(p => !finishedStatuses.includes(p.status));
            
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

            <Marker
              key={`pickup-${pickup.id}`}
              position={markerPosition}
              icon={pickup.useSimpleCircle ? createSimpleCircleIcon(pickup.status, pickup.status === 'pending' ? null : pickup.number, currentZoom, isMobile) : createStoreIcon(
                pickup.status, 
                pickup.pinColor, 
                isFanned, 
                pickup.status === 'pending' ? null : pickup.number, 
                currentZoom,
                pickup.duplicateCount,
                isMobile,
                highlightedDeliveryId === pickup.id,
                pickup.isNextDelivery
              )}
              zIndexOffset={dynamicZIndex}
              draggable={!pickup.useSimpleCircle}
              eventHandlers={pickup.useSimpleCircle ? {
                click: (e) => {
                  L.DomEvent.stopPropagation(e);
                }
              } : {
                click: (e) => {
                  L.DomEvent.stopPropagation(e);
                  handleMarkerClickForFanning(pickup, 'pickup');
                  e.target.openPopup();
                  setTimeout(() => {
                    e.target.closePopup();
                  }, 5000);
                },
                mouseover: (e) => {
                  e.target.openPopup();
                  setTimeout(() => {
                    e.target.closePopup();
                  }, 5000);
                },
                mouseout: (e) => {
                  e.target.closePopup();
                },
                dragend: (e) => handleMarkerDragEnd(pickup.id, e, 'pickup')
              }}
              ref={(ref) => {
                if (ref) {
                  markerRefs.current[`pickup-${pickup.id}`] = ref;
                }
              }}>

              {/* Only show popup for non-clustered markers or expanded cluster markers - HIDE for simple circles */}
              {!pickup.useSimpleCircle && (!isClustered || isFanned) && (
                <Popup
                  autoPan={false}
                  closeButton={false}
                  offset={[0, -20]}
                  className="custom-popup">
                  <DeliveryPopup delivery={pickup} isPickup={true} />
                </Popup>
              )}
            </Marker>
          ];
        })}

        {/* Patient Delivery Markers - NOW WITH FANNING */}
        {deliveryMarkers.map((delivery, index) => {
          const locationKey = `${delivery.latitude.toFixed(6)},${delivery.longitude.toFixed(6)}`;
          const isClustered = delivery.duplicateCount > 1;
          const isFanned = fannedLocationKey === locationKey;
          
          // Calculate position based on fanning state
          let markerPosition = [delivery.latitude, delivery.longitude];
          let dynamicZIndex;

          const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
          const isFinished = finishedStatuses.includes(delivery.status);
          const isNext = delivery.isNextInLine;

          if (isFinished) {
            // Rule 2: Finished markers are at the bottom.
            dynamicZIndex = 100 + (500 - (delivery.number || 500));
          } else {
            // Rule 1: Reverse stop order for active markers.
            dynamicZIndex = 1000 + (500 - (delivery.number || 500));
          }
          
          // Rule 3: Next marker is on top of everything.
          if (isNext) {
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
            const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
            const isFinished = finishedStatuses.includes(delivery.status);
            const incompleteMarkers = allMarkersAtLocation.filter(d => !finishedStatuses.includes(d.status));
            
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
            <Marker
              key={`delivery-${delivery.id}`}
              position={markerPosition}
              icon={delivery.useSimpleCircle ? createSimpleCircleIcon(delivery.status, delivery.status === 'pending' ? null : delivery.number, currentZoom, isMobile) : createDeliveryIcon(
                delivery.status,
                delivery.pinColor,
                isFanned,
                delivery.status === 'pending' ? null : delivery.number,
                delivery.isFirstTime,
                delivery.duplicateCount,
                currentZoom,
                isMobile,
                delivery.isNextInLine,
                highlightedDeliveryId === delivery.id
              )}
              zIndexOffset={dynamicZIndex}
              draggable={!delivery.useSimpleCircle}
              eventHandlers={delivery.useSimpleCircle ? {
                click: (e) => {
                  L.DomEvent.stopPropagation(e);
                }
              } : {
                click: (e) => {
                  L.DomEvent.stopPropagation(e);
                  handleMarkerClickForFanning(delivery, 'delivery');
                  e.target.openPopup();
                  setTimeout(() => {
                    e.target.closePopup();
                  }, 5000);
                },
                mouseover: (e) => {
                  e.target.openPopup();
                  setTimeout(() => {
                    e.target.closePopup();
                  }, 5000);
                },
                mouseout: (e) => {
                  e.target.closePopup();
                },
                dragend: (e) => handleMarkerDragEnd(delivery.id, e, 'delivery')
              }}
              ref={(ref) => {
                if (ref) {
                  markerRefs.current[`delivery-${delivery.id}`] = ref;
                }
              }}>

              {/* Only show popup for non-clustered markers or expanded cluster markers - HIDE for simple circles */}
              {!delivery.useSimpleCircle && (!isClustered || isFanned) && (
                <Popup
                  autoPan={false}
                  closeButton={false}
                  offset={[0, -20]}
                  className="custom-popup">
                  <DeliveryPopup delivery={delivery} isPickup={false} />
                </Popup>
              )}
            </Marker>
          ];
        })}

        {/* Driver Location Markers - Green/Orange for current user on other devices, Regular for other drivers */}
        {driverLocationMarkers.map((location) => {
          const statusLabel = location.driver_status === 'on_duty' ? 'On Duty' : 'On Break';
          const statusColor = location.driver_status === 'on_duty' ? 'text-emerald-600' : 'text-orange-600';
          
          return (
            <Marker
              key={`driver-location-${location.id || location.user_id}`}
              position={[location.latitude, location.longitude]}
              icon={createDriverIcon(location.driverColor, location.driverInitial)}
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

        {/* NEW: App Owner Center Crosshair - Red + at map center - ONLY on user interaction */}
        {currentUser && isAppOwner(currentUser) && mapCenter && showZoomOverlay && (
          <Marker
            key="center-crosshair"
            position={mapCenter}
            icon={L.divIcon({
              html: `
                <div style="
                  width: 12px;
                  height: 12px;
                  position: relative;
                  pointer-events: none;
                ">
                  <div style="
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    width: 10px;
                    height: 2px;
                    background: #EF4444;
                    border-radius: 1px;
                  "></div>
                  <div style="
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    width: 2px;
                    height: 10px;
                    background: #EF4444;
                    border-radius: 1px;
                  "></div>
                </div>
              `,
              className: 'center-crosshair-icon',
              iconSize: [12, 12],
              iconAnchor: [6, 6]
            })}
            zIndexOffset={5000}
            interactive={false}
          />
        )}

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
      <MapCrosshair stopCardsHeight={areStopCardsVisible ? stopCardsHeight : 0} />

      {safeDeliveries.length === 0 &&
        <div className="absolute inset-0 flex items-center justify-center bg-white/80 pointer-events-none">
          <div className="text-center">
            <Package className="w-12 h-12 mx-auto mb-2 text-slate-400" />
            <p className="text-slate-600">No deliveries for selected date</p>
          </div>
        </div>
      }



      {/* NEW: Zoom Level Overlay */}
      {showZoomOverlay &&
        <div className="absolute top-4 left-4 z-[100] bg-slate-900 text-white px-4 py-2 rounded-lg shadow-lg transition-opacity duration-300 pointer-events-none">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Zoom Level:</span>
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
          <div className="bg-white/95 backdrop-blur-sm rounded-lg shadow-lg border border-slate-200 px-3 py-2">
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
                    <span className="text-xs font-medium text-slate-700 whitespace-nowrap">
                      {route.driverName}
                    </span>
                    <span className="text-xs text-slate-500">
                      ({route.stops.length})
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
          box-shadow: 0 3px 14px rgba(0,0,0,0.25);
          z-index: 999999;
        }
        .custom-popup .leaflet-popup-content {
          margin: 0;
          line-height: 1.3;
        }
        .custom-popup .leaflet-popup-tip {
          box-shadow: 0 3px 14px rgba(0,0,0,0.25);
        }
        .leaflet-popup-pane {
          z-index: 999999 !important;
        }
        .leaflet-popup {
          z-index: 999999 !important;
        }
        .route-popup .leaflet-popup-content-wrapper {
          padding: 4px 8px;
          border-radius: 6px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.2);
          z-index: 999999;
        }
        .route-popup .leaflet-popup-content {
          margin: 0;
          line-height: 1.2;
        }
        .route-popup .leaflet-popup-tip {
          box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        }
        @keyframes pulsingHalo {
          0%, 100% { 
            transform: scale(1); 
            opacity: 0.8;
          }
          50% { 
            transform: scale(1.5); 
            opacity: 0.3;
          }
        }
        .pulsing-halo {
          animation: pulsingHalo 1.5s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
}