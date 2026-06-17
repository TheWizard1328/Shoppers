import React from "react";

export default function DashboardDriverLegend({
  legendRef,
  cardWidth,
  legendData,
  appUsers,
  isAllDriversMode,
  getDriverColor,
  handleCardInteraction,
  handleDriverChange,
  selectedDriverId,
}) {
  if (!legendData?.length) return null;

  return (
    <div
      ref={legendRef}
      data-driver-legend
      className="rounded-lg backdrop-blur-sm shadow-lg border"
      style={{
        background: 'var(--bg-white)',
        opacity: 0.95,
        borderColor: 'var(--border-slate-200)',
        width: cardWidth
      }}
      onMouseEnter={() => handleCardInteraction(true)}
      onMouseLeave={() => handleCardInteraction(false)}
    >
      <div className="flex w-full flex-wrap gap-x-1.5 gap-y-0.5 items-center justify-center">
        {legendData.map((route) => {
          const au = (appUsers || []).find((a) => a && a.user_id === route.driverId);
          const s = au?.driver_status;
          const isOnline = s === 'on_duty' || s === 'online' || au?.location_updated_at && Date.now() - new Date(au.location_updated_at).getTime() < 300000;
          const c = s === 'on_duty' ? '#16a34a' : s === 'on_break' ? '#3b82f6' : s === 'off_duty' ? '#dc2626' : '#94a3b8';
          const bg = isAllDriversMode ? route.color : c;
          const bd = isAllDriversMode ? `3px solid ${c}` : '0 solid transparent';
          const isSelected = selectedDriverId === route.driverId;

          return (
            <button
              key={route.driverId}
              type="button"
              className={`flex items-center gap-1.0 px-1 py-0.5 rounded transition-colors hover:bg-slate-100 ${isSelected ? 'underline underline-offset-2 font-semibold' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                if (handleDriverChange) {
                  // Toggle: clicking the already-selected driver switches back to "All Drivers"
                  handleDriverChange(isSelected ? 'all' : route.driverId);
                }
              }}
            >
              <div className="relative flex items-center justify-center w-3 h-3">
                {isOnline && <div className="opacity-75 rounded-full absolute inset-0 animate-ping" style={{ backgroundColor: c }} />}
                <div className="rounded-full relative w-3 h-3 shadow-sm flex-shrink-0" style={{ backgroundColor: bg, border: bd }} />
              </div>
              <span className="text-xs font-medium whitespace-nowrap" style={{ color: 'var(--text-slate-700)' }}>
                {route.driverName || 'Unknown'}
              </span>
              <span className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
                ({route.totalStops})
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}