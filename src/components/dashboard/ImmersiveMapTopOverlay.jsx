import React, { useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import SpecialSymbolsBadges from "../utils/SpecialSymbolsBadges";
import { getCurrentEtaForDelivery, primeEtaTrendBus } from "../utils/etaTrendBus";

function formatBatchTracking(delivery, store) {
  if (!delivery?.tracking_number || !store?.abbreviation) return null;
  const storeAbbr = store.abbreviation.slice(0, 2).toUpperCase();
  const trackingNum = parseInt(delivery.tracking_number, 10) || 0;
  const formattedNum = trackingNum > 99 ? trackingNum.toString().padStart(3, "0") : trackingNum.toString().padStart(2, "0");
  return `${storeAbbr}${formattedNum}`;
}

function formatStopOrder(value) {
  return `#${value || 0}`;
}

function formatDistance(value) {
  const km = Number(value);
  if (!Number.isFinite(km)) return "--";
  if (km >= 1) return `${km.toFixed(1)} km`;
  return `${Math.max(1, Math.round(km * 1000))} m`;
}

function formatEta(value) {
  if (!value || typeof value !== "string") return "--";
  const match = value.match(/(\d{2}:\d{2})/);
  return match ? match[1] : value;
}

export default function ImmersiveMapTopOverlay({ delivery, store, patient, isPickup, storeColor, finalDisplayName, address = null, topOffset = 0, remainingDistanceKm = null }) {
  React.useEffect(() => {
    if (delivery) primeEtaTrendBus([delivery]);
  }, [delivery]);

  if (!delivery) return null;

  // Detect special stop types
  const isCyclingMarker = !!delivery.is_cycling_marker;
  const isInterStore = !isCyclingMarker && !isPickup && !patient &&
    (String(delivery.delivery_id || '').toUpperCase().startsWith('ISP') ||
     String(delivery.delivery_id || '').toUpperCase().startsWith('ISD') ||
     String(delivery.delivery_notes || '').toLowerCase().includes('interstore'));

  // Resolve display address
  const resolvedAddress = (() => {
    if (address) return address;
    if (isCyclingMarker) {
      // Address prop (from DashboardView) carries formatted GPS coordinates.
      // If it's missing (legacy path), format them inline from the delivery record.
      const lat = delivery?.cycling_latitude;
      const lng = delivery?.cycling_longitude;
      if (lat != null && lng != null) {
        const latStr = `${Math.abs(Number(lat)).toFixed(4)}°${Number(lat) >= 0 ? 'N' : 'S'}`;
        const lngStr = `${Math.abs(Number(lng)).toFixed(4)}°${Number(lng) >= 0 ? 'E' : 'W'}`;
        return `${latStr}, ${lngStr}`;
      }
      // Final fallback: show start/end label
      const notes = (delivery?.delivery_notes || '').trim().toLowerCase();
      return notes.includes('end') ? 'Cycling End' : 'Cycling Start';
    }
    if (patient?.address) return patient.address;
    if (store?.address) return store.address;
    return '--';
  })();

  // Only show batch tracking for regular deliveries
  const batchTracking = (!isCyclingMarker && !isInterStore) ? formatBatchTracking(delivery, store) : null;

  const liveEta = getCurrentEtaForDelivery(
    delivery?.id,
    delivery?.delivery_time_eta || (isPickup ? delivery?.delivery_time_start : null) || delivery?.delivery_time_start || "--:--"
  );

  return (
    <div className="absolute left-2 right-2 z-[800] pointer-events-none" style={{ top: `${Math.max(8, topOffset + 8)}px` }}>
      <div className="rounded-2xl border border-white/60 bg-transparent px-2.5 py-1.5 shadow-md backdrop-blur-md dark:border-slate-800/70 dark:bg-transparent">
        <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2 text-slate-900 dark:text-white">
          <Badge
            variant="secondary"
            className="h-6 min-w-[2.25rem] justify-center rounded-full border-0 px-2 py-0 text-xs font-bold text-white"
            style={{ backgroundColor: storeColor || "#10B981", color: "white" }}
          >
            {formatStopOrder(delivery?.display_stop_order || delivery?.stop_order)}
          </Badge>

          <div className="min-w-0 truncate text-center text-sm font-semibold text-slate-900 dark:text-white">
            {finalDisplayName}
          </div>

          <Badge
            variant="secondary"
            className="h-6 shrink-0 rounded-full border-0 px-2 py-0 text-xs font-bold text-white"
            style={{ backgroundColor: `${storeColor}`, color: "white" }}
          >
            {formatEta(liveEta)}
          </Badge>
        </div>

        <div className="mt-1 grid grid-cols-[auto_1fr_auto] items-center gap-2 text-slate-800 dark:text-white">
          <div className="flex items-center gap-1.5 overflow-hidden">
            {batchTracking && (
              <Badge
                variant="secondary"
                className="h-5 shrink-0 rounded-full border-0 px-2 py-0 text-[11px] font-bold text-white"
                style={{ backgroundColor: `${storeColor}`, color: "white" }}
              >
                {batchTracking}
              </Badge>
            )}
            <div className="flex shrink-0 items-center">
              <SpecialSymbolsBadges delivery={delivery} patient={patient} isPickup={isPickup} size="card" />
            </div>
          </div>

          <div className="min-w-0 truncate text-center text-xs font-medium text-slate-800 dark:text-white">
            {resolvedAddress}
          </div>

          <Badge
            variant="secondary"
            className="h-5 shrink-0 rounded-full border-0 px-2 py-0 text-[11px] font-bold text-white"
            style={{ backgroundColor: `${storeColor}`, color: "white" }}
          >
            {formatDistance(remainingDistanceKm)}
          </Badge>
        </div>
      </div>
    </div>
  );
}