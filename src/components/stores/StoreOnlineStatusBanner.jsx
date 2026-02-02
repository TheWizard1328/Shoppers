import React, { useMemo } from 'react';
import { Card } from '@/components/ui/card';

export default function StoreOnlineStatusBanner({ stores, appUsers }) {
  // Calculate online status for each store
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
        
        return {
          id: store.id,
          name: store.name,
          abbreviation: store.abbreviation,
          color: store.color || '#64748b',
          isOnline: onlineDispatchers.length > 0
        };
      });
  }, [stores, appUsers]);

  if (storeStatuses.length === 0) return null;

  return (
    <Card className="mb-6 p-4" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {storeStatuses.map(store => (
          <div key={store.id} className="flex items-center gap-2">
            <div
              className="w-3 h-3 rounded-full flex-shrink-0"
              style={{ 
                backgroundColor: store.isOnline ? store.color : '#cbd5e1',
                boxShadow: store.isOnline ? `0 0 6px ${store.color}40` : 'none'
              }}
            />
            <span 
              className="text-sm font-medium whitespace-nowrap"
              style={{ color: store.isOnline ? 'var(--text-slate-900)' : 'var(--text-slate-500)' }}
            >
              {store.abbreviation || store.name}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}