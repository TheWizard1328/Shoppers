import React from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { updateStoreLocal } from "@/components/utils/offlineMutations";
import { CalendarClock } from "lucide-react";

/**
 * Admin-only row on each Store card: a "Stats" checkbox + a driver dropdown.
 * When the checkbox is on, the selected driver becomes this store's default
 * for stat holidays. Styled as a tinted rounded card, indigo accent to
 * differentiate from the amber "App Fees" row. Uses semantic tokens so it
 * renders correctly in light and dark mode.
 */
export default function StoreStatHolidayRow({ store, drivers, onUpdated }) {
  if (!store) return null;

  const enabled = !!store.stat_holiday_enabled;
  const selectedDriverId = store.stat_holiday_driver_id || "none";

  const persist = async (patch) => {
    try {
      const updatedStore = await updateStoreLocal(store.id, patch);
      const { invalidate } = await import("@/components/utils/dataManager");
      invalidate("Store");
      const { broadcastMutation } = await import("@/components/utils/realtimeSync");
      broadcastMutation("Store", "update", store.id, updatedStore);
      window.dispatchEvent(
        new CustomEvent("storeUpdated", { detail: { storeId: store.id, updatedStore } })
      );
      onUpdated?.(updatedStore);
    } catch (error) {
      console.error("Error saving stat holiday driver:", error);
    }
  };

  const handleToggle = (checked) => {
    const patch = { stat_holiday_enabled: checked };
    if (!checked) patch.stat_holiday_driver_id = null;
    persist(patch);
  };

  const handleDriverSelect = (driverId) => {
    persist({ stat_holiday_driver_id: driverId === "none" ? null : driverId });
  };

  return (
    <div
      className="px-2 rounded-lg flex flex-wrap items-center gap-2 min-h-[46px]"
      style={{
        background: "var(--bg-indigo-50, #eef2ff)",
        border: "1px solid var(--border-indigo-200, #c7d2fe)",
      }}
    >
      <div className="flex items-center gap-2">
        <Checkbox
          id={`stat-holiday-${store.id}`}
          checked={enabled}
          onCheckedChange={handleToggle}
        />
        <label
          htmlFor={`stat-holiday-${store.id}`}
          className="text-sm font-medium cursor-pointer flex items-center gap-1"
          style={{ color: "var(--text-indigo-800, #3730a3)" }}
        >
          <CalendarClock className="w-3.5 h-3.5" />
          Stats
        </label>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <span
          className="text-xs font-medium"
          style={{ color: "var(--text-indigo-700, #4338ca)" }}
        >
          Holiday Driver:
        </span>
        <Select
          value={selectedDriverId}
          onValueChange={handleDriverSelect}
          disabled={!enabled}
        >
          <SelectTrigger
            className="h-8 w-[170px] text-xs bg-surface border-surface"
            disabled={!enabled}
          >
            <SelectValue placeholder={enabled ? "Select driver" : "—"} />
          </SelectTrigger>
          <SelectContent className="z-[10002] bg-surface border-surface">
            <SelectItem value="none" className="text-soft">
              No Driver
            </SelectItem>
            {(drivers || [])
              .filter((d) => d?.app_roles?.includes("driver"))
              .map((driver) => (
                <SelectItem key={driver.id} value={driver.id} className="text-body">
                  {driver.user_name || driver.full_name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}