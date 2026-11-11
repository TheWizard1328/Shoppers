import { UserRound } from "lucide-react";
import { generateDriverColor, getContrastColor } from "@/components/utils/colorGenerator";

/**
 * Shared COD card badges (owner request Nov 10 2026).
 *
 * The store-abbreviation badge and the assigned-driver badge must read as the
 * SAME pill: same height, same rounding, same text size. A fixed height keeps
 * them identical no matter what the content is (two letters vs. icon + name),
 * which is what the row layout aligns on.
 */
const PILL = "inline-flex items-center shrink-0 h-[18px] rounded-full px-1.5 text-[11px] leading-none";

export function StoreAbbrevBadge({ abbrev, color }) {
  return (
    <span
      className={`${PILL} justify-center font-bold text-white`}
      style={{ backgroundColor: color || '#64748b' }}>
      {abbrev || '—'}
    </span>
  );
}

export function DriverBadge({ name }) {
  if (!name) return null;
  // Colour-coded to the driver's own map colour (same hash the driver markers
  // and polylines use), with the text colour picked for contrast.
  const bg = generateDriverColor(name);
  return (
    <span
      title={`Assigned to ${name}`}
      className={`${PILL} gap-0.5 min-w-0 font-medium`}
      style={{ backgroundColor: bg, color: getContrastColor(bg) }}>
      <UserRound className="w-3 h-3 shrink-0" />
      <span className="truncate max-w-[76px]">{name}</span>
    </span>
  );
}