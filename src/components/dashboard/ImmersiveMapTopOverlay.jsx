import React from "react";
import { Badge } from "@/components/ui/badge";
import SpecialSymbolsBadges from "../utils/SpecialSymbolsBadges";

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

export default function ImmersiveMapTopOverlay({ delivery, store, patient, isPickup, storeColor, finalDisplayName, topOffset = 0, remainingDistanceKm = null }) {
  if (!delivery) return null;
  const batchTracking = formatBatchTracking(delivery, store);

  return (
    <div className="absolute left-2 right-2 z-[700] pointer-events-none" style={{ top: `${Math.max(8, topOffset + 8)}px` }}>
      <div className="rounded-2xl border border-white/20 bg-white/10 px-2.5 py-1.5 shadow-md backdrop-blur-md">
        <div className="flex items-center justify-between gap-2 text-white">
          <div className="flex min-w-0 items-center gap-1.5">
            <Badge
              variant="secondary"
              className="h-6 min-w-[2.25rem] justify-center rounded-full border-0 px-2 py-0 text-xs font-bold text-white"
              style={{ backgroundColor: storeColor || "#10B981", color: "white" }}
            >
              {formatStopOrder(delivery?.display_stop_order || delivery?.stop_order)}
            </Badge>
            <div className="min-w-0 truncate text-sm font-semibold text-white">
              {finalDisplayName}
            </div>
          </div>

          <Badge
            variant="secondary"
            className="h-6 shrink-0 rounded-full border-0 px-2 py-0 text-xs font-bold text-white"
            style={{ backgroundColor: `${storeColor}`, color: "white" }}
          >
            ETA {formatEta(delivery?.delivery_time_eta || delivery?.delivery_time_start)}
          </Badge>
        </div>

        <div className="mt-1 flex items-center justify-between gap-2 text-white/95">
          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
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
            <div className="min-w-0 truncate text-xs font-medium text-white/95">
              {patient?.address || store?.address || '--'}
            </div>
          </div>

          <div className="shrink-0 text-xs font-semibold text-white">
            {formatDistance(remainingDistanceKm)}
          </div>
        </div>
      </div>
    </div>
  );
}