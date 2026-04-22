import React from "react";
import { getDriverColor } from "@/components/dashboard/DeliveryMap";
import { sortUsers } from "@/components/utils/sorting";

export default function DriverLegendBar({
  legendRef,
  legendData,
  cardWidth,
  appUsers,
  isAllDriversMode,
  onMouseEnter,
  onMouseLeave
}) {
  if (!legendData.length) return null;

  const sortedLegendData = sortUsers(legendData.map((route) => ({
    ...route,
    user_name: route.driverName,
  })));

  return (
    <div
      ref={legendRef}
      className="rounded-lg backdrop-blur-sm shadow-lg border"
      style={{ background: 'var(--bg-white)', opacity: 0.95, borderColor: 'var(--border-slate-200)', width: cardWidth }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="flex w-full flex-wrap gap-x-0.5 gap-y-0.5 items-center justify-center">
        {sortedLegendData.map((route) => {
          const au = (appUsers || []).find((a) => a && a.user_id === route.driverId);
          const s = au?.driver_status;
          const isOnline = s === 'on_duty' || s === 'online' || (au?.location_updated_at && (Date.now() - new Date(au.location_updated_at).getTime() < 300000));
          const c = s === 'on_duty' ? '#16a34a' : s === 'on_break' ? '#3b82f6' : s === 'off_duty' ? '#dc2626' : '#94a3b8';
          const bg = isAllDriversMode ? route.color : c;
          const bd = isAllDriversMode ? `3px solid ${c}` : '0 solid transparent';

          return (
            <div key={route.driverId} className="flex items-center gap-1.5">
              <div className="relative flex items-center justify-center w-3 h-3">
                {isOnline && <div className="absolute inset-0 rounded-full animate-ping opacity-75" style={{ backgroundColor: c }} />}
                <div className="relative w-3 h-3 rounded-full shadow-sm flex-shrink-0" style={{ backgroundColor: bg, border: bd }} />
              </div>
              <span className="text-xs font-medium whitespace-nowrap" style={{ color: 'var(--text-slate-700)' }}>{route.driverName || 'Unknown'}</span>
              <span className="text-xs" style={{ color: 'var(--text-slate-500)' }}>({route.totalStops})</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}