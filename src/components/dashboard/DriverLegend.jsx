import React from "react";

export default function DriverLegend({ legendRef, legendLeft, isStatsCardExpanded, driverRoutes, highlightedRouteId, setHighlightedRouteId, onLegendInteraction }) {
  if (!driverRoutes || driverRoutes.length === 0) return null;
  return (
    <div
      ref={legendRef}
      className="absolute z-[10] pointer-events-auto transition-opacity duration-300"
      style={{
        top: isStatsCardExpanded ? '220px' : '120px',
        left: legendLeft ? `${legendLeft}px` : '50%',
        transform: legendLeft ? 'none' : 'translateX(-50%)'
      }}
      onMouseEnter={() => onLegendInteraction(true)}
      onMouseLeave={() => onLegendInteraction(false)}
    >
      <div className="backdrop-blur-sm rounded-lg shadow-lg border px-3 py-2" style={{ background: 'var(--bg-white)', opacity: 0.95, borderColor: 'var(--border-slate-200)' }}>
        <div className="flex flex-wrap gap-x-3 gap-y-1.5 items-center justify-center">
          {driverRoutes.map((route) => (
            <div
              key={route.driverId}
              className="flex items-center gap-1.5 cursor-pointer hover:opacity-70 transition-opacity"
              onMouseEnter={() => setHighlightedRouteId(route.driverId)}
              onMouseLeave={() => setHighlightedRouteId(null)}
              onClick={() => setHighlightedRouteId(highlightedRouteId === route.driverId ? null : route.driverId)}
            >
              <div
                className="w-3 h-3 rounded-full border-2 border-white shadow-sm flex-shrink-0"
                style={{ backgroundColor: route.color }}
              />
              <span className="text-xs font-medium whitespace-nowrap" style={{ color: 'var(--text-slate-700)' }}>
                {route.driverName}
              </span>
              <span className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
                ({route.totalStops})
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}