import React from 'react';
import { Building2, Edit, Globe, Mail, Phone, Settings, Store as StoreIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export default function CompanyCard({ company, stores = [], onEdit }) {
  const linkedStores = stores.filter((store) => (company.store_ids || []).includes(store.id));

  return (
    <Card className="hover:shadow-lg transition-shadow" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
      <CardContent className="p-6 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ backgroundColor: `${company.primary_color || '#16a34a'}20` }}>
              {company.logo_url ? (
                <img src={company.logo_url} alt={company.name} className="w-10 h-10 rounded-full object-cover" />
              ) : (
                <Building2 className="w-6 h-6" style={{ color: company.primary_color || '#16a34a' }} />
              )}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-lg font-semibold truncate" style={{ color: 'var(--text-slate-900)' }}>{company.name}</h3>
                <Badge variant={company.status === 'active' ? 'default' : 'secondary'}>
                  {company.status || 'active'}
                </Badge>
              </div>
              {company.contact_name && <p className="text-sm" style={{ color: 'var(--text-slate-600)' }}>{company.contact_name}</p>}
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={() => onEdit(company)}>
            <Edit className="w-4 h-4" />
          </Button>
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
          <div className="flex flex-wrap gap-2">
            {linkedStores.length === 0 ? (
              <span className="text-sm" style={{ color: 'var(--text-slate-500)' }}>No stores linked yet.</span>
            ) : linkedStores.map((store) => (
              <Badge key={store.id} variant="secondary">{store.name}</Badge>
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