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

function formatDistance(value) {
  const km = Number(value);
  if (!Number.isFinite(km)) return "--";
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

export default function ImmersiveMapTopOverlay({ delivery, store, patient, isPickup, storeColor, finalDisplayName, topOffset = 0 }) {
  if (!delivery) return null;
  const batchTracking = formatBatchTracking(delivery, store);

  return (
    <div className="absolute left-2 right-2 z-[240] pointer-events-none" style={{ top: `${Math.max(8, topOffset + 8)}px` }}>
      <div className="flex items-center justify-between gap-2 rounded-2xl border border-slate-200/80 bg-white/95 px-3 py-2 shadow-lg backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-2">
          <Badge
            variant="secondary"
            className="h-7 min-w-[2.25rem] justify-center rounded-full px-2 text-xs font-bold text-white"
            style={{ backgroundColor: storeColor || "#10B981" }}
          >
            #{delivery?.display_stop_order || delivery?.stop_order || 0}
          </Badge>

          {batchTracking && (
            <Badge
              variant="secondary"
              className="h-7 rounded-full px-2 text-xs font-bold text-white"
              style={{ backgroundColor: storeColor || "#10B981" }}
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
          <Badge variant="secondary" className="h-7 rounded-full px-2 text-xs font-bold bg-slate-100 text-slate-700">
            PA
          </Badge>
          <Badge variant="secondary" className="h-7 rounded-full px-2 text-xs font-bold bg-slate-100 text-slate-700">
            {formatDistance(delivery?.travel_dist)}
          </Badge>
        </div>
      </div>
    </div>
  );
}