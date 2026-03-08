import React from "react";

export default function InlineDriverLegend({ driverRoutes, onHover }) {
  if (!driverRoutes || driverRoutes.length === 0) return null;
  return (
    <div
      className="backdrop-blur-sm rounded-lg shadow-lg border px-1 py-1"
      style={{ background: 'var(--bg-white)', opacity: 0.95, borderColor: 'var(--border-slate-200)' }}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
    >
      <div className="flex flex-wrap gap-x-1 gap-y-1 items-center justify-center">
        {[...driverRoutes]
          .sort((a, b) => (a.driverName || '').localeCompare(b.driverName || ''))
          .map((route) => {
            const displayName = route.driverName || 'Unknown';
            const routeColor = route.color;
            return (
              <div key={route.driverId} className="flex items-center gap-1.5">
                <div
                  className="w-3 h-3 rounded-full border-2 border-white shadow-sm flex-shrink-0"
                  style={{ backgroundColor: routeColor }}
                />
                <span className="text-xs font-medium whitespace-nowrap" style={{ color: 'var(--text-slate-700)' }}>
                  {displayName}
                </span>
                <span className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
                  ({route.totalStops})
                </span>
              </div>
            );
          })}
      </div>
    </div>
  );
}