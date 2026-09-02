import React from "react";
import { Checkbox } from "@/components/ui/checkbox";

export default function StopCardCheckboxToggle({
  checked = false,
  onCheckedChange,
  stopCardsHeight = 0,
  hasVisibleCards = false,
  immersiveHidden = false,
  hideCheckbox = false,
  children = null
}) {
  const bottomPixels = ((hasVisibleCards && !immersiveHidden) ? stopCardsHeight : 0) + 10;
  return (
    <div
      className="absolute z-[100] pointer-events-auto flex items-center gap-2 bg-transparent opacity-50 hover:opacity-100 transition-opacity duration-200"
      style={{ left: "0.75rem", bottom: `${bottomPixels}px` }}
    >
      {!immersiveHidden && !hideCheckbox && (
        <label className="flex items-center cursor-pointer">
          <Checkbox checked={checked} onCheckedChange={onCheckedChange} aria-label="Show stop checkboxes" />
        </label>
      )}
      {children}
    </div>
  );
}