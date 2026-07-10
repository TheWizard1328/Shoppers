// DashboardHelpers.jsx - Extracted helper components and utilities from Dashboard

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { format } from 'date-fns';

// StatBadge - simple component without hooks to avoid violations
export const StatBadge = ({ icon: Icon, value, color, label, tooltip, driverCount }) => {
  const colorClasses = {
    blue: "bg-blue-100 text-blue-600",
    purple: "bg-purple-100 text-purple-600",
    emerald: "bg-emerald-100 text-emerald-600",
    green: "bg-green-100 text-green-600",
    red: "bg-red-100 text-red-600",
    slate: "bg-slate-100 text-slate-600"
  };

  const badge =
    <div className="px-1 flex items-center gap-2 cursor-help">
      <div className={`p-1.5 rounded-lg ${colorClasses[color]}`}>
        <Icon className="w-3.5 h-3.5" />
      </div>
      <div className="relative">
        {driverCount !== undefined && driverCount > 0 &&
          <span className="absolute -top-1 -right-1 text-[9px] font-bold" style={{ color: 'var(--text-slate-500)' }}>
            {driverCount}
          </span>
        }
        <span className="text-lg font-bold" style={{ color: 'var(--text-slate-900)' }}>{value}</span>
      </div>
    </div>;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          {badge}
        </TooltipTrigger>
        <TooltipContent className="z-[9999] border" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-900)', borderColor: 'var(--border-slate-300)' }}>
          <p>{tooltip || ''}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

// Helper function to calculate distance between two coordinates (Haversine formula)
export const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// Helper function to generate unique SID (3-character alphanumeric)
export const generateUniqueSID = (existingDeliveriesForDate) => {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const existingSIDs = new Set(
    (existingDeliveriesForDate || []).map((d) => d && d.stop_id).filter(Boolean)
  );
  let sid;
  let attempts = 0;
  do {
    sid = '';
    for (let i = 0; i < 3; i++) sid += chars.charAt(Math.floor(Math.random() * chars.length));
    if (++attempts > 10000) throw new Error('Unable to generate unique SID');
  } while (existingSIDs.has(sid));
  return sid;
};

// Helper: add minutes to HH:mm time string
export const addMinutesToTime = (timeString, minutes) => {
  if (!timeString) return null;
  const [hours, mins] = timeString.split(':').map(Number);
  const totalMinutes = hours * 60 + mins + minutes;
  const newHours = Math.floor(totalMinutes / 60) % 24;
  const newMins = totalMinutes % 60;
  return `${String(newHours).padStart(2, '0')}:${String(newMins).padStart(2, '0')}`;
};

// Round ISO timestamp to nearest 5-minute mark
export const roundCompletionTime = (timeISO) => {
  if (!timeISO) return timeISO;
  try {
    const [datePart, timePart] = timeISO.split('T');
    const [hours, minutesRaw] = timePart.split(':').map(Number);
    const roundedMinutes = Math.round(minutesRaw / 5) * 5;
    const finalHours = Math.floor((hours * 60 + roundedMinutes) / 60) % 24;
    const finalMinutes = roundedMinutes % 60;
    return `${datePart}T${String(finalHours).padStart(2, '0')}:${String(finalMinutes).padStart(2, '0')}:00`;
  } catch {
    return timeISO;
  }
};

/**
 * Calculates stable map padding for fit-bounds calls.
 * On mobile, enforces a minimum bottom padding of 160px to prevent the map
 * from bouncing when stopCardsBaseHeight is transiently 0 (e.g. cards
 * remeasuring right after a stop is completed in phase 2).
 */
export const buildMapPadding = ({ isMobile, isImmersiveHidden, statsCardHeight, statsCardBaseHeight, stopCardsBaseHeight, bottomNavHeight }) => {
  const paddingBuffer = 60;
  const stopCardsHeight = isImmersiveHidden ? paddingBuffer : (stopCardsBaseHeight || paddingBuffer);
  const cardsArePresent = stopCardsHeight > 0;

  // Bottom padding rules (both desktop and mobile):
  //   Cards present  — stop cards height + bottom nav + 10px breathing room
  //   Cards absent   — bottom nav + 10px (nav bar still overlaps the bottom edge)
  const rawBottomPadding = cardsArePresent
    ? stopCardsHeight + (bottomNavHeight || 0) + paddingBuffer
    : (bottomNavHeight || 0) + paddingBuffer;

  // CRITICAL: Never drop below 160px on mobile when cards are visible —
  // prevents fit-bounds from jumping when cards remeasure mid-animation.
  const bottomPadding = isMobile && cardsArePresent && isImmersiveHidden
    ? Math.max(rawBottomPadding, 160)
    : rawBottomPadding;

  // Top padding rules:
  //   Mobile  — full stats panel container height (statsCardHeight from DOM, which
  //             measures the stats card div only) + mobile header bar (~56px) +
  //             legend bar (~32px) + breathing room. Use a generous minimum of 200px
  //             to ensure markers never hide behind the stats panel in collapsed mode.
  //   Desktop — paddingBuffer (stats panel is not overlapping the map canvas).
  let topPadding;
  if (isMobile && !isImmersiveHidden) {
    const mobileHeaderHeight = 0; //56; // fixed MobileHeader height
    const legendBarHeight = 0; //36;    // collapsed driver legend bar below stats card
    const rawStatsHeight = statsCardHeight || statsCardBaseHeight || 75;
    // Full obstruction = mobile header + stats card + legend bar + breathing room
    const fullObstructionHeight = rawStatsHeight + paddingBuffer / 2 + mobileHeaderHeight + legendBarHeight;
    // Never drop below 200px on mobile — guards against transient 0 heights
    topPadding = Math.max(fullObstructionHeight, 25);
  } else {
    topPadding = paddingBuffer;
  }

  return {
    paddingTopLeft:     [25,   topPadding],
    paddingBottomRight: [25,   bottomPadding],
  };
};

// Populate temporary start times for deliveries with blank time windows
export const populateTemporaryStartTimes = (deliveries, stores) => {
  const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
  const deliveriesCopy = deliveries.map((d) => ({ ...d }));
  deliveriesCopy.forEach((delivery) => {
    if (!delivery.patient_id || delivery.delivery_time_start) return;
    const parentPickup = deliveriesCopy.find((d) =>
      !d.patient_id && d.store_id === delivery.store_id && d.driver_id === delivery.driver_id
    );
    if (parentPickup) {
      if (finishedStatuses.includes(parentPickup.status) && parentPickup.actual_delivery_time) {
          const completionTime = format(new Date(parentPickup.actual_delivery_time), 'HH:mm');
        delivery.delivery_time_start = addMinutesToTime(completionTime, 5);
      } else if (parentPickup.delivery_time_eta) {
        delivery.delivery_time_start = addMinutesToTime(parentPickup.delivery_time_eta, 5);
      } else if (parentPickup.delivery_time_start) {
        delivery.delivery_time_start = addMinutesToTime(parentPickup.delivery_time_start, 5);
      }
    }
  });
  return deliveriesCopy;
};