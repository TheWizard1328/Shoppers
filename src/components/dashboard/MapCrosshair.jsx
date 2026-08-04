import React from 'react';

/**
 * Map Crosshair Overlay Component
 *
 * Renders a fixed crosshair at the visual center of the map's visible area,
 * shifted so it sits at the center of the SAME padded region the map uses for
 * fit-bounds (buildMapPadding in DashboardHelpers.jsx).
 *
 * Props `topPadding` / `bottomPadding` are BASE (non-expanded) paddings, so
 * expanding the stats card or a stop card does NOT shift this crosshair — the
 * map center and crosshair stay locked to the collapsed layout.
 *
 * This is a pure overlay - not part of the map, so it doesn't move when panning.
 */
export default function MapCrosshair({ topPadding = 0, bottomPadding = 0 }) {
  const verticalShift = topPadding === 0 && bottomPadding === 0
    ? 0
    : Math.round((topPadding - bottomPadding) / 2);

  return (
    <div
      className="absolute inset-0 pointer-events-none z-[10]"
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      {/* Crosshair container - shifted to center in the visible (padded) map area */}
      <div
        className="relative w-6 h-6"
        style={{ transform: verticalShift !== 0 ? `translateY(${verticalShift}px)` : 'none' }}
      >
        {/* Horizontal line */}
        <div
          className="absolute top-1/2 left-0 right-0 h-[2px] bg-slate-800/60 -translate-y-1/2"
          style={{ boxShadow: '0 0 2px rgba(255,255,255,0.8)' }}
        />
        {/* Vertical line */}
        <div
          className="absolute left-1/2 top-0 bottom-0 w-[2px] bg-slate-800/60 -translate-x-1/2"
          style={{ boxShadow: '0 0 2px rgba(255,255,255,0.8)' }}
        />
        {/* Center dot */}
        <div
          className="absolute top-1/2 left-1/2 w-2 h-2 bg-slate-800/80 rounded-full -translate-x-1/2 -translate-y-1/2"
          style={{ boxShadow: '0 0 3px rgba(255,255,255,0.9)' }}
        />
      </div>
    </div>
  );
}