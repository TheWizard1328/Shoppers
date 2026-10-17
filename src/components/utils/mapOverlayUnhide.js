/**
 * Stats-overlay "unhide" for phase map fits (owner spec, Oct 16 2026).
 *
 * When the map cycle FAB is in phase 1/2/3 (locked, stats card NOT expanded),
 * the phase fit must not leave the driver live/shared dot or any incomplete
 * stop markers underneath the stats-cards parent container. After the fit,
 * if any candidate marker would sit under the overlay, add TOP or LEFT map
 * padding — whichever needs the SMALLER shift — so ONE padding value changes
 * and the markers clear the panel. Free-floating / unlocked maps and expanded
 * stats cards are never touched (gated by the caller).
 *
 * Pure math only — no Leaflet dependency — so it is unit-testable in node.
 */

/**
 * @param {object}   args
 * @param {object}   args.overlayRect   {left, top, right, bottom} in MAP-CONTAINER pixel space
 * @param {{x:number,y:number}} args.mapSize container size in px
 * @param {Array}    args.points        [{x, y, r}] post-fit container-pixel positions of candidate
 *                                       markers (r = visual radius in px)
 * @param {number}   [args.marginPx=8]  breathing gap kept around the overlay
 * @param {number}   [args.minShiftPx=10] below this the marker is considered acceptably clear
 * @param {number}   [args.maxShiftFrac=0.3] cap: never shift more than this fraction of the axis
 * @returns {{axis: 'top'|'left'|null, shiftPx: number, hiddenCount: number}}
 *   axis = the single padding side to grow; shiftPx = how far the CONTENT must
 *   move (px). The caller doubles this into padding (fitBounds center moves by
 *   half the padding delta).
 */
export function computeOverlayUnhide({
  overlayRect,
  mapSize,
  points,
  marginPx = 8,
  minShiftPx = 10,
  maxShiftFrac = 0.3,
} = {}) {
  const empty = { axis: null, shiftPx: 0, hiddenCount: 0 };
  if (!overlayRect) return empty;
  const L = overlayRect.left, T = overlayRect.top;
  const R = overlayRect.right, B = overlayRect.bottom;
  if (!Number.isFinite(L) || !Number.isFinite(T) || !Number.isFinite(R) || !Number.isFinite(B)) return empty;
  if (R - L < 4 || B - T < 4) return empty; // collapsed/hidden panel

  // Margin-inflated rect: a marker within margin of the panel still counts.
  const iL = L - marginPx, iT = T - marginPx, iR = R + marginPx, iB = B + marginPx;

  let hiddenCount = 0;
  let needTop = 0;
  let needLeft = 0;

  for (const p of points || []) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const r = Number.isFinite(p.r) ? Math.abs(p.r) : 12;

    // circle-vs-rect intersection
    const cx = Math.max(iL, Math.min(p.x, iR));
    const cy = Math.max(iT, Math.min(p.y, iB));
    const dx = p.x - cx, dy = p.y - cy;
    if (dx * dx + dy * dy >= r * r) continue; // not hidden

    hiddenCount++;
    // Move DOWN until the marker's top edge clears the panel bottom (+ margin)
    needTop = Math.max(needTop, iB - (p.y - r));
    // Move RIGHT until the marker's left edge clears the panel right (+ margin)
    needLeft = Math.max(needLeft, iR - (p.x - r));
  }

  if (hiddenCount === 0) return empty;

  const capTop = Math.round((mapSize?.y || 0) * maxShiftFrac);
  const capLeft = Math.round((mapSize?.x || 0) * maxShiftFrac);
  needTop = Math.min(needTop, capTop);
  needLeft = Math.min(needLeft, capLeft);

  // Owner rule: pick the axis needing the SMALLER shift — change ONE padding value.
  const axis = needTop <= needLeft ? 'top' : 'left';
  const shiftPx = axis === 'top' ? needTop : needLeft;

  if (!Number.isFinite(shiftPx) || shiftPx < minShiftPx) return { axis: null, shiftPx: 0, hiddenCount };

  return { axis, shiftPx, hiddenCount };
}
