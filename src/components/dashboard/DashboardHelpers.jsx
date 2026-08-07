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
    slate: "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 dark:text-slate-500"
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
 *
 * Three padding regions:
 *   TOP    — mobile normal:     stats card container height (measured via ResizeObserver);
 *            mobile immersive:  ImmersiveMapTopOverlay banner height (~80px) — that
 *                                banner does NOT hide in immersive mode, unlike the
 *                                full stats card, so top padding must clear it or
 *                                markers render underneath it;
 *            desktop:           BASE_PADDING (25px)
 *   BOTTOM — normal: EXTRA_ITEMS + stop cards height;
 *            immersive: IMMERSIVE_ITEMS (50px) — only temp badge + FAB remain
 *   SIDES  — BASE_PADDING (25px) on all platforms
 *
 * The 80px EXTRA_ITEMS_HEIGHT accounts for always-present bottom UI chrome
 * (bulk-select bar, temp badge, FABs, reoptimize button) in normal mode.
 * In immersive mode, stop cards + reoptimize button hide, leaving only the
 * temp badge + cycle FAB (~50px), so we use a smaller immersive baseline.
 */
export const buildMapPadding = ({ isMobile, isImmersiveModeOn, statsCardHeight, stopCardsBaseHeight }) => {
  // Always-present UI chrome pinned at the bottom of the map in NORMAL mode
  // (API counter, temp badge, reoptimize FAB, cycle FAB) sits ON TOP of the
  // stop cards row. On mobile this also has to clear the fixed bottom nav bar
  // (~64-88px), so it needs a bigger baseline than desktop, which has no
  // bottom nav (sidebar instead) — its FABs only need their own ~40px height
  // plus a little breathing room above the stop card row.
  const EXTRA_ITEMS_HEIGHT = 50 ; // isMobile ? 80 : 50;

  // Immersive mode: stop cards + reoptimize button hide, leaving only temp badge + cycle FAB.
  const IMMERSIVE_ITEMS_HEIGHT = 50;

  // Baseline breathing room for top/sides when no UI obstructions are present.
  const BASE_PADDING = 25;

  // Immersive mode does NOT hide everything at the top — ImmersiveMapTopOverlay
  // (the compact "#stop / name / ETA" banner) stays pinned ~8px from the top and
  // is roughly 64px tall itself (two badge rows + padding), so its bottom edge
  // sits around ~72px down. Without this, fit-bounds/pan targets used only
  // BASE_PADDING (~35px), placing markers directly underneath the banner.
  const IMMERSIVE_TOP_BANNER_HEIGHT = 60;

  // Bottom padding:
  //   Normal mode   — extra items + stop cards stack underneath
  //   Immersive mode — only temp badge + FAB remain (50px)
  let bottomPadding;
  if (!isImmersiveModeOn) {
    bottomPadding = EXTRA_ITEMS_HEIGHT + (stopCardsBaseHeight || 0);
  } else {
    bottomPadding = EXTRA_ITEMS_HEIGHT;
  }

  // Top padding:
  //   Normal (all devices)   — stats card container height (DashboardStatsPanel overlays
  //                            the top of the map on BOTH mobile AND desktop via absolute
  //                            positioning at z-230. Not accounting for it on desktop left
  //                            markers hidden behind the panel.)
  //   Mobile immersive       — IMMERSIVE_TOP_BANNER_HEIGHT (clears ImmersiveMapTopOverlay banner)
  //   Desktop immersive      — BASE_PADDING + breathing room (stats panel slides away)
  let topPadding;
  if (!isImmersiveModeOn) {
    topPadding = Math.max(statsCardHeight || 75, BASE_PADDING) + 10;
  } else if (isMobile) {
    topPadding = IMMERSIVE_TOP_BANNER_HEIGHT;
  } else {
    topPadding = BASE_PADDING + 10;
  }

  return {
    paddingTopLeft:     [BASE_PADDING, topPadding],
    paddingBottomRight: [BASE_PADDING, bottomPadding],
    topPadding,
    bottomPadding,
    _debug: {
      isImmersiveModeOn,
      EXTRA_ITEMS_HEIGHT,
      IMMERSIVE_ITEMS_HEIGHT,
      statsCardHeight,
      stopCardsBaseHeight,
      topPadding,
      bottomPadding,
    },
  };
};

// Populate temporary start times for deliveries with blank time windows
export const populateTemporaryStartTimes = (deliveries, stores) => {
  const finishedStatuses = ['completed', 'failed', 'cancelled'];
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