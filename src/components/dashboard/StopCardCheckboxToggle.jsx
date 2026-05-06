import React from "react";
import { Checkbox } from "@/components/ui/checkbox";

export default function StopCardCheckboxToggle({
  checked = false,
  onCheckedChange,
  stopCardsHeight = 0,
  immersiveHidden = false
}) {
  if (immersiveHidden) return null;

  return (
    <div
      className="absolute z-[110] pointer-events-auto"
      style={{ left: "0.75rem", bottom: `${Math.max((stopCardsHeight || 0) + 10, 16)}px` }}
    >
      <label className="flex items-center gap-2 rounded-md border bg-white/85 px-2 py-1 shadow-sm backdrop-blur-sm cursor-pointer">
        <Checkbox checked={checked} onCheckedChange={onCheckedChange} aria-label="Show stop checkboxes" />
      </label>
    </div>
  );
}