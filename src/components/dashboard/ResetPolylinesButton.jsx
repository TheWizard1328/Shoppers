import React, { useMemo, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { clearHereCacheForDriverDate } from "@/components/utils/hereRouting";
import { Loader2, RotateCcw } from "lucide-react";

export default function ResetPolylinesButton({
  selectedDriverIds = [],
  selectedDate,
  mode = "inline",
  disabled = false,
  className = "",
}) {
  const [isResetting, setIsResetting] = useState(false);

  const driverIds = useMemo(() => {
    return Array.from(new Set((selectedDriverIds || []).filter(Boolean).filter((id) => id !== "all")));
  }, [selectedDriverIds]);

  const clearPolylineCache = () => {
    try {
      Object.keys(localStorage).forEach((key) => {
        if (key.startsWith("here_")) {
          localStorage.removeItem(key);
        }
      });
    } catch (_) {}
  };

  const handleReset = async () => {
    if (isResetting || disabled || driverIds.length === 0 || !selectedDate) return;

    setIsResetting(true);

    await Promise.all(driverIds.map((driverId) => clearHereCacheForDriverDate(driverId, selectedDate)));
    clearPolylineCache();
    window.dispatchEvent(new CustomEvent("polylineCacheCleared", {
      detail: { driverIds, deliveryDate: selectedDate, triggeredBy: "resetPolylines" }
    }));

    try {
      const results = await Promise.allSettled(
        driverIds.map((driverId) =>
          base44.functions.invoke("purgeAndRegeneratePolylines", {
            driverId,
            deliveryDate: selectedDate,
          })
        )
      );

      const hasSuccessfulUpdate = results.some((result) => result?.status === "fulfilled");

      if (hasSuccessfulUpdate) {
        clearPolylineCache();
        window.dispatchEvent(new CustomEvent("polylineCacheCleared", {
          detail: { driverIds, deliveryDate: selectedDate, triggeredBy: "resetPolylines" }
        }));
      }

      driverIds.forEach((driverId, index) => {
        if (results[index]?.status !== "fulfilled") return;
        window.dispatchEvent(new CustomEvent("deliveriesUpdated", {
          detail: { driverId, deliveryDate: selectedDate, triggeredBy: "resetPolylines" }
        }));
      });
    } finally {
      setIsResetting(false);
    }
  };

  if (mode === "fab") {
    return (
      <Button
        onClick={handleReset}
        disabled={disabled || isResetting || driverIds.length === 0}
        title="Reset and update all polylines"
        className={`inline-flex items-center justify-center h-10 w-10 rounded-lg shadow-2xl p-0 transition-all duration-200 bg-slate-700 hover:bg-slate-800 ${className}`}
        style={{ pointerEvents: "auto", touchAction: "manipulation" }}
      >
        {isResetting ? <Loader2 className="w-5 h-5 text-white animate-spin" /> : <RotateCcw className="w-5 h-5 text-white" />}
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={handleReset}
      disabled={disabled || isResetting || driverIds.length === 0}
      className={`h-8 gap-2 ${className}`}
      style={{ background: "var(--bg-white)", borderColor: "var(--border-slate-300)", color: "var(--text-slate-900)" }}
    >
      {isResetting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
      {isResetting ? "Updating..." : "Reset"}
    </Button>
  );
}