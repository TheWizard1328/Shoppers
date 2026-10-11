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
  // Match the exact formula every other item on this row uses (LiveTempBadge's
  // tempBadgeBottom, FABControls/MapViewCycleFAB/RouteActionButtons' bottomPixels):
  // stopCardsHeight + bottomNavHeight + 10. This component was missing
  // bottomNavHeight, so on devices with a nonzero --bottom-nav-height it sat
  // higher than the pair badge / FABs on the same row instead of level with them.
  let bottomNavHeight = 0;
  try {
    bottomNavHeight = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--bottom-nav-height') || '0', 10) || 0;
  } catch { /* default 0 */ }
  const bottomPixels = ((hasVisibleCards && !immersiveHidden) ? stopCardsHeight + bottomNavHeight : bottomNavHeight) + 10;
  // This pill is shorter (py-1, ~26px tall) than its taller row-mates on the
  // same bottom line — the "Tap to pair" pill and the round FAB buttons
  // (h-10, 40px) — so bottom-anchoring at the same value left it looking
  // noticeably higher than them. Nudge down a few px to bring its vertical
  // center closer to theirs.
  const rowCenterNudge = 6;
  return (
    <div
      data-bulk-select-toggle
      className="absolute z-[100] pointer-events-auto flex items-center gap-2 rounded-lg px-2 py-1 bg-white/50 dark:bg-slate-900/50 transition-colors duration-200"
      style={{ left: "0.75rem", bottom: `${Math.max(0, bottomPixels - rowCenterNudge)}px` }}
    >
      {!immersiveHidden && !hideCheckbox && (
        <label className="flex items-center cursor-pointer opacity-100">
          <Checkbox checked={checked} onCheckedChange={onCheckedChange} aria-label="Show stop checkboxes" />
        </label>
      )}
      <div className="opacity-100">{children}</div>
    </div>
  );
}