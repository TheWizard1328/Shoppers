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
      <div className="flex items-center justify-between gap-2 rounded-2xl border border-slate-200/80 bg-white/95 px-3 py-2 shadow-lg backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-2">
          <Badge
            variant="secondary"
            className="mt-1 h-7 min-w-[2.5rem] justify-center rounded-full border px-2 py-0.5 text-sm font-bold text-white transition-colors"
            style={{ backgroundColor: storeColor || "#10B981", color: "white" }}
          >
            {formatStopOrder(delivery?.display_stop_order || delivery?.stop_order)}
          </Badge>

          {batchTracking && (
            <Badge
              variant="secondary"
              className="mt-1 h-7 rounded-full px-2 py-0.5 text-sm font-bold"
              style={{ backgroundColor: `${storeColor}`, color: "White" }}
            >
              {batchTracking}
            </Badge>
          )}

          <div className="flex items-center">
            <SpecialSymbolsBadges delivery={delivery} patient={patient} isPickup={isPickup} size="card" />
          </div>

          <div className="min-w-0 truncate text-sm font-semibold text-slate-900">
            {finalDisplayName}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Badge
            variant="secondary"
            className="mt-1 h-7 rounded-full px-2 py-0.5 text-sm font-bold"
            style={{ backgroundColor: `${storeColor}`, color: "White" }}
          >
            {formatEta(delivery?.delivery_time_eta || delivery?.delivery_time_start)}
          </Badge>
          <Badge
            variant="secondary"
            className="mt-1 h-7 rounded-full px-2 py-0.5 text-sm font-bold"
            style={{ backgroundColor: `${storeColor}`, color: "White" }}
          >
            {formatDistance(remainingDistanceKm)}
          </Badge>
        </div>
      </div>
    </div>
  );
}