import React from "react";
import { Checkbox } from "@/components/ui/checkbox";

export default function StopCardCheckboxToggle({
  checked = false,
  onCheckedChange,
  stopCardsHeight = 0,
  immersiveHidden = false,
  children = null
}) {
  if (immersiveHidden) return null;

  return (
    <div
      className="absolute z-[110] pointer-events-auto flex items-center gap-2 bg-transparent"
      style={{ left: "0.75rem", bottom: `${Math.max((stopCardsHeight || 0) + 10, 16)}px` }}
    >
      <label className="flex items-center cursor-pointer">
        <Checkbox checked={checked} onCheckedChange={onCheckedChange} aria-label="Show stop checkboxes" />
      </label>
      {children}
    </div>
  );
}