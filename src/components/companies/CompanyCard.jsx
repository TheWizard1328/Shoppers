import React, { useMemo } from 'react';
import { Building2, Edit, Globe, Mail, Phone, Settings, Store as StoreIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getContrastColor } from '@/components/utils/colorGenerator';
import { getDriverColor } from '@/components/utils/driverUtils';

// Returns the default driver ID for a store — prefers weekday_am, falls back to other slots
function getStoreDefaultDriverId(store) {
  return store.weekday_am_driver_id
    || store.weekday_pm_driver_id
    || store.saturday_am_driver_id
    || store.saturday_pm_driver_id
    || null;
}

export default function CompanyCard({ company, stores = [], appUsers = [], onEdit, onDelete }) {
  const linkedStores = stores
    .filter((store) => (company.store_ids || []).includes(store.id))
    .sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));

  // Build a map from user_id → sort_order for quick lookups
  const driverSortOrderMap = React.useMemo(() => {
    const map = {};
    appUsers.forEach((au) => { if (au?.user_id) map[au.user_id] = au; });
    return map;
  }, [appUsers]);

  return (
    <Card className="hover:shadow-lg transition-shadow" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
      <CardContent className="p-6 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0 flex-1">
            <div className="w-12 h-12 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: `${company.primary_color || '#16a34a'}20` }}>
              {company.logo_url ? (
                <img src={company.logo_url} alt={company.name} className="w-10 h-10 rounded-full object-cover" />
              ) : (
                <Building2 className="w-6 h-6" style={{ color: company.primary_color || '#16a34a' }} />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap min-h-12">
                <h3 className="text-lg font-semibold truncate" style={{ color: 'var(--text-slate-900)' }}>{company.name}</h3>
                <Badge variant={company.status === 'active' ? 'default' : 'secondary'}>
                  {company.status || 'active'}
                </Badge>
              </div>
              {company.contact_name && <p className="text-sm" style={{ color: 'var(--text-slate-600)' }}>{company.contact_name}</p>}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button variant="ghost" size="sm" className="text-red-600 hover:text-red-700" onClick={() => onDelete(company)}>
              Delete
            </Button>
            <Button variant="ghost" size="icon" onClick={() => onEdit(company)}>
              <Edit className="w-4 h-4" />
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          {company.contact_email && <div className="flex items-center gap-2" style={{ color: 'var(--text-slate-600)' }}><Mail className="w-4 h-4" />{company.contact_email}</div>}
          {company.contact_phone && <div className="flex items-center gap-2" style={{ color: 'var(--text-slate-600)' }}><Phone className="w-4 h-4" />{company.contact_phone}</div>}
          {company.website_url && <div className="flex items-center gap-2" style={{ color: 'var(--text-slate-600)' }}><Globe className="w-4 h-4" />{company.website_url}</div>}
          {company.timezone && <div className="flex items-center gap-2" style={{ color: 'var(--text-slate-600)' }}><Settings className="w-4 h-4" />{company.timezone}</div>}
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--text-slate-700)' }}>
            <StoreIcon className="w-4 h-4" />
            Associated Stores ({linkedStores.length})
          </div>
          <div className="grid w-full grid-cols-2 md:grid-cols-4 gap-1 items-stretch">
            {linkedStores.length === 0 ? (
              <span className="text-sm col-span-full" style={{ color: 'var(--text-slate-500)' }}>No stores linked yet.</span>
            ) : linkedStores.map((store) => (
              <Badge
                key={store.id}
                variant="secondary"
                className="flex w-full min-w-0 items-center justify-start truncate px-2 py-1"
                style={store.status === 'inactive'
                  ? { background: '#fee2e2', color: '#dc2626', borderColor: '#fca5a5' }
                  : (() => {
                      const driverId = getStoreDefaultDriverId(store);
                      const driver = driverId ? driverSortOrderMap[driverId] : null;
                      const bg = getDriverColor({ id: driverId || store.id, sort_order: driver?.sort_order });
                      return { background: bg, color: getContrastColor(bg), borderColor: bg };
                    })()
                }
              >
                {store.name}
              </Badge>
            ))}
          </div>
        </div>

        {(company.notes || company.support_email || company.support_phone) && (
          <div className="pt-3 border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
            {company.support_email && <p className="text-sm" style={{ color: 'var(--text-slate-600)' }}>Support: {company.support_email}</p>}
            {company.support_phone && <p className="text-sm" style={{ color: 'var(--text-slate-600)' }}>{company.support_phone}</p>}
            {company.notes && <p className="text-sm mt-2" style={{ color: 'var(--text-slate-500)' }}>{company.notes}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}