import React, { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';

const formatHeartbeatAgo = (ts) => {
  if (!ts) return 'No heartbeat recorded';
  const diff = Date.now() - new Date(ts).getTime();
  if (Number.isNaN(diff) || diff < 0) return 'No heartbeat recorded';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Last heartbeat: just now';
  if (mins < 60) return `Last heartbeat: ${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  const remMin = mins % 60;
  return `Last heartbeat: ${hrs}h ${remMin}m ago`;
};

export default function StoreOnlineStatusBanner({ stores, appUsers }) {
  const [hoveredStore, setHoveredStore] = useState(null);

  // Calculate online status + last heartbeat for each store
  const storeStatuses = useMemo(() => {
    if (!stores || !appUsers) return [];

    return stores
      .filter(s => s && s.status === 'active')
      .sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity))
      .map(store => {
        // A store is online if it has at least one dispatcher with status 'online'
        const onlineDispatchers = appUsers.filter(
          au => au?.app_roles?.includes('dispatcher') &&
                au.driver_status === 'online' &&
                au.store_ids?.includes(store.id)
        );

        // Check if any online dispatcher has stale location (5+ minutes old)
        let isStale = false;
        if (onlineDispatchers.length > 0) {
          const now = Date.now();
          isStale = onlineDispatchers.some(au => {
            if (!au.location_updated_at) return true; // No location = stale
            const lastUpdate = new Date(au.location_updated_at).getTime();
            return (now - lastUpdate) > 5 * 60 * 1000; // 5 minutes
          });
        }

        // Determine bullet color: green (online), orange (stale), grey (offline)
        let bulletColor = '#cbd5e1'; // grey (offline)
        if (onlineDispatchers.length > 0) {
          bulletColor = isStale ? '#f97316' : '#10b981'; // orange (stale) : green (online)
        }

        // Most recent heartbeat (location_updated_at) across online dispatchers
        let lastHeartbeatAt = null;
        let lastHeartbeatName = null;
        for (const au of onlineDispatchers) {
          if (!au?.location_updated_at) continue;
          const t = new Date(au.location_updated_at).getTime();
          if (!Number.isNaN(t) && (!lastHeartbeatAt || t > lastHeartbeatAt)) {
            lastHeartbeatAt = t;
            lastHeartbeatName = au.user_name || null;
          }
        }

        return {
          id: store.id,
          name: store.name,
          abbreviation: store.abbreviation,
          bulletColor: bulletColor,
          isOnline: onlineDispatchers.length > 0,
          lastHeartbeatAt: lastHeartbeatAt || null,
          lastHeartbeatName: lastHeartbeatName
        };
      });
  }, [stores, appUsers]);

  if (storeStatuses.length === 0) return null;

  return (
    <Card className="mb-6 p-4" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {storeStatuses.map(store => {
          const isHovered = hoveredStore === store.id;
          const heartbeatLabel = store.lastHeartbeatAt
            ? `${formatHeartbeatAgo(new Date(store.lastHeartbeatAt).toISOString())}${store.lastHeartbeatName ? ` (${store.lastHeartbeatName})` : ''}`
            : 'No heartbeat recorded';
          return (
            <div
              key={store.id}
              className="flex items-center gap-2 relative cursor-default outline-none"
              tabIndex={0}
              onMouseEnter={() => setHoveredStore(store.id)}
              onMouseLeave={() => setHoveredStore(null)}
              onFocus={() => setHoveredStore(store.id)}
              onBlur={() => setHoveredStore(null)}
              title={heartbeatLabel}
            >
              <div
                className={`w-3 h-3 rounded-full flex-shrink-0 transition-transform ${isHovered ? 'scale-125' : ''}`}
                style={{
                  backgroundColor: store.bulletColor,
                  boxShadow: store.isOnline ? `0 0 6px ${store.bulletColor}40` : 'none'
                }}
              />
              <span
                className="text-sm font-medium whitespace-nowrap"
                style={{ color: store.isOnline ? 'var(--text-slate-900)' : 'var(--text-slate-500)' }}
              >
                {store.abbreviation || store.name}
              </span>
              {isHovered && (
                <div
                  role="tooltip"
                  className="absolute bottom-full left-0 mb-1 z-50 px-2.5 py-1.5 rounded-md text-xs whitespace-nowrap pointer-events-none shadow-lg"
                  style={{
                    background: 'var(--bg-slate-900,#0f172a)',
                    color: 'var(--text-slate-50,#f8fafc)',
                    border: '1px solid var(--border-slate-200)'
                  }}
                >
                  {heartbeatLabel}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}