import L from 'leaflet';
import { getContrastColor, getStoreColor } from '../utils/colorGenerator';
import { getDriverColor } from '../utils/driverUtils';

const ZOOM_LEVELS = {
  HIDE_ROUTES: 10,
  SIMPLIFY_ROUTES: 12,
  HIDE_NUMBERS: 11,
  HIDE_CIRCLES: 11,
  FULL_DETAIL: 13
};

const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];

const simpleCircleIconCache = new Map();

const getDriverTextColor = (driverColor) => {
  if (driverColor === '#00CED1' || driverColor === '#FF69B4') return 'black';
  return 'white';
};

const getInnerSymbolColor = (status, isPickup = false) => {
  if (isPickup) {
    if (status === 'completed') return '#10B981';
    if (status === 'Ready For Pickup') return '#3B82F6';
    if (status === 'pending') return '#94A3B8';
    if (status === 'cancelled') return '#EF4444';
    return '#FFFFFF';
  } else {
    if (status === 'completed' || status === 'delivered') return '#10B981';
    if (status === 'failed' || status === 'cancelled') return '#EF4444';
    if (status === 'returned') return '#F97316';
    if (status === 'Ready For Pickup') return '#3B82F6';
    if (status === 'pending') return '#94A3B8';
    return '#FFFFFF';
  }
};

export const createSimpleCircleIcon = (status, number, zoomLevel, isMobile = false, borderColor = 'white', isOtherDriver = false, clusterCount = 0, isNextDelivery = false, isFaded = false, isHighlightedFinished = false) => {
  const cacheKey = `${status}_${number}_${zoomLevel}_${isMobile}_${borderColor}_${isOtherDriver}_${clusterCount}_${isNextDelivery}_${isFaded}`;
  
  if (simpleCircleIconCache.has(cacheKey)) {
    return simpleCircleIconCache.get(cacheKey);
  }
  
  const statusColors = {
    'pending': '#3B82F6',
    'Ready For Pickup': '#3B82F6',
    'in_transit': '#0EA5E9',
    'en_route': '#0EA5E9',
    'completed': '#10B981',
    'delivered': '#10B981',
    'failed': '#EF4444',
    'cancelled': '#EF4444',
    'returned': '#F97316'
  };

  const statusColor = statusColors[status] || '#94A3B8';
  const driverColor = isNextDelivery ? '#FDE047' : borderColor;
  
  const outerRingColor = isOtherDriver ? '#FFFFFF' : statusColor;
  const innerCircleColor = isOtherDriver 
    ? (isNextDelivery && !FINISHED_STATUSES.includes(status) ? '#FFEA00' : borderColor)
    : driverColor;

  let baseSize = 24 * 0.75;
  if (zoomLevel >= ZOOM_LEVELS.FULL_DETAIL) {
    baseSize = 28 * 0.75;
  } else if (zoomLevel < ZOOM_LEVELS.SIMPLIFY_ROUTES) {
    baseSize = 20 * 0.75;
  }
  
  if (status === 'pending') baseSize *= 0.75;
  if (isOtherDriver) baseSize *= 0.86;
  if (isMobile) baseSize *= 1.25;

  const fontSize = 7;
  const textColor = isNextDelivery ? 'black' : getDriverTextColor(driverColor);

  const finalBorderColor = isOtherDriver && FINISHED_STATUSES.includes(status)
    ? statusColor
    : outerRingColor;

  const markerOpacity = isHighlightedFinished ? 0.85 : isFaded ? 0.5 : isOtherDriver ? 0.75 : 1;

  const icon = L.divIcon({
    html: `
      <div class="simple-circle-marker" style="
        width: ${baseSize}px;
        height: ${baseSize}px;
        background-color: ${innerCircleColor};
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        padding-top: 1px;
        font-size: ${fontSize}px;
        font-weight: bold;
        color: ${textColor};
        box-shadow: 0 2px 5px rgba(0,0,0,0.3);
        border: ${isOtherDriver ? '3px' : '2px'} solid ${finalBorderColor};
        opacity: ${markerOpacity};
        transition: opacity 0.2s ease-in-out;
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
  
  simpleCircleIconCache.set(cacheKey, icon);
  return icon;
};

export const createStoreIcon = (status, storeColor = '#6B7280', isActive = false, number = null, zoomLevel = 12, duplicateCount = 0, isMobile = false, isHighlighted = false, isNextDelivery = false, hasIncompleteStops = true, isOtherDriver = false, isFaded = false, isHighlightedFinished = false) => {
  const isFinished = FINISHED_STATUSES.includes(status);
  const shouldShowNextYellow = isNextDelivery && !isFinished && hasIncompleteStops;
  
  const innerColor = shouldShowNextYellow ? '#FFEA00' : getInnerSymbolColor(status, true);
  const showNumber = zoomLevel >= ZOOM_LEVELS.HIDE_NUMBERS && number;
  const hasDuplicates = duplicateCount > 1;

  let baseSize = 24 * 0.75;
  if (zoomLevel >= ZOOM_LEVELS.FULL_DETAIL) {
    baseSize = 28 * 0.75;
  } else if (zoomLevel < ZOOM_LEVELS.SIMPLIFY_ROUTES) {
    baseSize = 20 * 0.75;
  }
  
  if (status === 'pending') baseSize *= 0.75;
  if (isMobile) baseSize *= 1.25;
  
  let size = isActive ? baseSize * 1.15 : baseSize;
  const storeOpacity = isHighlightedFinished ? 0.85 : isFaded ? 0.5 : isOtherDriver ? 0.75 : 1;

  return L.divIcon({
    html: `
      <div class="store-marker ${isHighlighted ? 'highlighted' : ''}" style="
        width: ${size}px;
        height: ${size * 1.4}px;
        position: relative;
        cursor: pointer;
        opacity: ${storeOpacity};
        transition: opacity 0.2s ease-in-out;
      ">
        <svg width="${size}" height="${size * 1.4}" viewBox="0 0 24 34" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 0C5.373 0 0 5.373 0 12c0 9 12 22 12 22s12-13 12-22C24 5.373 18.627 0 12 0z" 
                fill="${storeColor}" 
                stroke="#FFFFFF" 
                stroke-width="1.2"
                style="filter: drop-shadow(0 2px 3px rgba(0,0,0,0.3));" />
          
          <g transform="translate(12, 9)">
            <rect x="-2" y="-7" width="4" height="14" fill="${innerColor}" rx="1.5" />
            <rect x="-7" y="-2" width="14" height="4" fill="${innerColor}" rx="1.5" />
          </g>
          
          ${showNumber ? `
            <text x="12" y="24" 
                  font-family="Arial, sans-serif" 
                  font-size="9.5" 
                  font-weight="bold" 
                  fill="white"
                  text-anchor="middle">${number}</text>
          ` : ''}
        </svg>
        
        ${hasDuplicates && zoomLevel >= ZOOM_LEVELS.HIDE_NUMBERS ? `
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
        .store-marker { transition: transform 0.15s ease-out; will-change: transform; }
        .store-marker:hover { z-index: 9999 !important; transform: scale(1.15); }
        .leaflet-marker-icon:has(.store-marker:hover) { z-index: 9999 !important; }
      </style>
    `,
    className: 'custom-store-icon',
    iconSize: [size, size * 1.4],
    iconAnchor: [size / 2, size * 1.4]
  });
};

export const createDeliveryIcon = (status, storeColor = '#6B7280', isActive = false, number = null, isFirstTime = false, duplicateCount = 0, zoomLevel = 12, isMobile = false, isNextInLine = false, isHighlighted = false, hasIncompleteStops = true, isPM = false, isOtherDriver = false, isReturn = false, isFaded = false, isHighlightedFinished = false) => {
  const isFinished = FINISHED_STATUSES.includes(status);
  const shouldShowNextYellow = isNextInLine && !isFinished && hasIncompleteStops;
  const isPending = status === 'pending';
  
  const statusColor = isReturn ? '#F97316' : (shouldShowNextYellow ? '#FFEA00' : getInnerSymbolColor(status, false));
  const hasYellowHalo = isFirstTime && zoomLevel >= ZOOM_LEVELS.SIMPLIFY_ROUTES;
  const hasDuplicates = duplicateCount > 1;
  const showNumber = zoomLevel >= ZOOM_LEVELS.HIDE_NUMBERS && number;

  let baseSize = 24 * 0.75;
  if (zoomLevel >= ZOOM_LEVELS.FULL_DETAIL) {
    baseSize = 28 * 0.75;
  } else if (zoomLevel < ZOOM_LEVELS.SIMPLIFY_ROUTES) {
    baseSize = 20 * 0.75;
  }
  
  if (status === 'pending') baseSize *= 0.75;
  if (isOtherDriver) baseSize *= 0.86;
  if (isMobile) baseSize *= 1.25;
  
  const size = isActive ? baseSize * 1.15 : baseSize;
  const numberColor = shouldShowNextYellow ? '#000000' : ((status === 'failed' || status === 'cancelled') ? 'white' : (FINISHED_STATUSES.includes(status) ? 'black' : getContrastColor(statusColor)));
  const deliveryOpacity = isHighlightedFinished ? 0.85 : isFaded ? 0.5 : isOtherDriver ? 0.75 : 1;

  return L.divIcon({
    html: `
      <div class="delivery-marker ${isHighlighted ? 'highlighted' : ''}" style="
        width: ${size}px;
        height: ${size * 1.4}px;
        position: relative;
        cursor: pointer;
        opacity: ${deliveryOpacity};
        transition: opacity 0.2s ease-in-out;
      ">
        <svg width="${size}" height="${size * 1.4}" viewBox="0 0 24 34" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 0C5.373 0 0 5.373 0 12c0 9 12 22 12 22s12-13 12-22C24 5.373 18.627 0 12 0z" 
                fill="${storeColor}" 
                stroke="#FFFFFF" 
                stroke-width="1.2"
                style="filter: drop-shadow(0 2px 3px rgba(0,0,0,0.3));" />
          
          ${hasYellowHalo ? (isPM ? `
            <rect x="4.5" y="4.5" width="15" height="15" fill="none" stroke="#FBBF24" stroke-width="5.5" opacity="1" />
          ` : `
            <circle cx="12" cy="12" r="7.5" fill="none" stroke="#FBBF24" stroke-width="5.5" opacity="1" />
          `) : ''}
          
          ${(isPM && !isPending) || (isPM && isPending) ? `
            <rect x="4" y="4" width="16" height="16" fill="${statusColor}" stroke="${storeColor}" stroke-width="1.2" />
          ` : `
            <circle cx="12" cy="12" r="8" fill="${statusColor}" stroke="${storeColor}" stroke-width="1.2" />
          `}
          
          ${showNumber ? `
            <text x="12" y="15.5" font-family="Arial, sans-serif" font-size="9.5" font-weight="bold" fill="${numberColor}" text-anchor="middle">${number}</text>
          ` : ''}
        </svg>
        
        ${hasDuplicates && zoomLevel >= ZOOM_LEVELS.HIDE_NUMBERS ? `
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
        .delivery-marker { transition: transform 0.15s ease-out; will-change: transform; }
        .delivery-marker:hover { z-index: 9999 !important; transform: scale(1.15); }
        .leaflet-marker-icon:has(.delivery-marker:hover) { z-index: 9999 !important; }
      </style>
    `,
    className: 'custom-delivery-icon',
    iconSize: [size, size * 1.4],
    iconAnchor: [size / 2, size * 1.4]
  });
};

export const createLiveLocationDot = () => {
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
          0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 0.6; }
          50% { transform: translate(-50%, -50%) scale(1.3); opacity: 0.2; }
        }
        .live-location-dot { z-index: 100 !important; pointer-events: auto; transition: transform 0.2s ease; }
        .live-location-dot:hover { transform: scale(1.15); }
      </style>
    `,
    className: 'custom-live-location-icon',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    zIndexOffset: -1000
  });
};

export const createHomeIcon = (color = '#10B981') => {
  const size = 24 * 0.75;
  return L.divIcon({
    html: `
      <div class="home-marker" style="width: ${size}px; height: ${size * 1.4}px; position: relative; cursor: pointer;">
        <svg width="${size}" height="${size * 1.4}" viewBox="0 0 24 34" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 0C5.373 0 0 5.373 0 12c0 9 12 22 12 22s12-13 12-22C24 5.373 18.627 0 12 0z" 
                fill="${color}" stroke="#FFFFFF" stroke-width="1.2" style="filter: drop-shadow(0 2px 3px rgba(0,0,0,0.3));" />
          <g transform="translate(12, 12)">
            <path d="M-5,-3 L0,-7 L5,-3 Z" fill="white" stroke="white" stroke-width="0.5" stroke-linejoin="round" />
            <rect x="-4" y="-3" width="8" height="6" fill="white" stroke="white" stroke-width="0.5" />
            <rect x="-1.5" y="0" width="3" height="3" fill="${color}" stroke="${color}" stroke-width="0.3" />
          </g>
        </svg>
      </div>
      <style>
        .home-marker { transition: transform 0.2s ease; }
        .home-marker:hover { z-index: 9999 !important; transform: scale(1.15); }
        .leaflet-marker-icon:has(.home-marker:hover) { z-index: 9999 !important; }
      </style>
    `,
    className: 'custom-home-icon',
    iconSize: [size, size * 1.4],
    iconAnchor: [size / 2, size * 1.4]
  });
};