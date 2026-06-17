/**
 * CompanyDataTab.jsx
 * Admin Data tab for viewing Company records and which entities belong to each company.
 * Records with blank company_id are treated as belonging to RGistics (the default company).
 */
import React, { useState, useEffect, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, Building2, Users, Package, MapPin, HeartPulse, DollarSign } from 'lucide-react';

const RGISTICS_LABEL = 'RGistics (default)';

export default function CompanyDataTab() {
  const [companies, setCompanies] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const [companyList, appUsers, deliveries, stores, patients, payrolls, interStores] = await Promise.all([
          base44.entities.Company.list(),
          base44.entities.AppUser.list(),
          base44.entities.Delivery.list('-created_date', 500),
          base44.entities.Store.list(),
          base44.entities.Patient.list(),
          base44.entities.Payroll.list(),
          base44.entities.InterStoreLocation.list(),
        ]);

        // Build counts per company_id (null/blank → 'default')
        const buildCounts = (records) => {
          const map = {};
          (records || []).forEach((r) => {
            const key = r.company_id || 'default';
            map[key] = (map[key] || 0) + 1;
          });
          return map;
        };

        setCounts({
          appUsers: buildCounts(appUsers),
          deliveries: buildCounts(deliveries),
          stores: buildCounts(stores),
          patients: buildCounts(patients),
          payrolls: buildCounts(payrolls),
          interStores: buildCounts(interStores),
        });

        setCompanies(companyList || []);
      } catch (err) {
        console.error('CompanyDataTab load error:', err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  // Build rows: one per real company + "default" row only for records with blank company_id
  const rows = useMemo(() => {
    const realIds = new Set(companies.map((c) => c.id));
    const allKeys = new Set(Object.values(counts).flatMap((m) => Object.keys(m)));
    
    const result = [];

    // Only show the "default" row if there are actually records with blank company_id
    const hasDefaultRecords = Object.values(counts).some((m) => m['default'] > 0);
    if (hasDefaultRecords) {
      result.push({ id: 'default', name: RGISTICS_LABEL, isDefault: true });
    }

    // Real companies
    companies.forEach((c) => result.push({ id: c.id, name: c.name, isDefault: false, company: c }));

    // Any company_id in the data that doesn't match a real Company record (orphaned)
    allKeys.forEach((key) => {
      if (key !== 'default' && !realIds.has(key)) {
        result.push({ id: key, name: `Unknown (${key.substring(0, 8)}…)`, isDefault: false, isOrphaned: true });
      }
    });

    return result;
  }, [companies, counts]);

  const getCount = (entity, companyId) => counts[entity]?.[companyId] ?? 0;

  const statDefs = [
    { key: 'stores', label: 'Stores', Icon: MapPin, color: 'text-emerald-600' },
    { key: 'patients', label: 'Patients', Icon: HeartPulse, color: 'text-blue-600' },
    { key: 'appUsers', label: 'App Users', Icon: Users, color: 'text-purple-600' },
    { key: 'deliveries', label: 'Deliveries', Icon: Package, color: 'text-orange-600' },
    { key: 'payrolls', label: 'Payrolls', Icon: DollarSign, color: 'text-yellow-600' },
    { key: 'interStores', label: 'ISP Locations', Icon: Building2, color: 'text-slate-600' },
  ];

  if (loading) {
    return (
      <div className="flex justify-center items-center h-40">
        <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
        <span className="ml-3 text-slate-600">Loading company data...</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-sm text-slate-500 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
        Records with a blank <code className="font-mono text-xs bg-blue-100 px-1 rounded">company_id</code> are counted under <strong>RGistics (default)</strong>. As you add more companies and assign records, their counts will appear here.
      </div>

      {rows.map((row) => {
        const total = statDefs.reduce((sum, s) => sum + getCount(s.key, row.id), 0);
        return (
          <Card key={row.id} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base" style={{ color: 'var(--text-slate-900)' }}>
                <Building2 className="w-5 h-5 text-slate-500" />
                {row.name}
                {row.isDefault && <Badge variant="secondary" className="text-xs">Default</Badge>}
                {row.isOrphaned && <Badge variant="destructive" className="text-xs">Orphaned ID</Badge>}
                <span className="ml-auto text-sm font-normal text-slate-500">{total.toLocaleString()} total records</span>
              </CardTitle>
              {row.company && (
                <CardDescription style={{ color: 'var(--text-slate-500)' }}>
                  {row.company.contact_email || row.company.website_url || ''}
                </CardDescription>
              )}
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                {statDefs.map(({ key, label, Icon, color }) => (
                  <div
                    key={key}
                    className="flex flex-col items-center justify-center rounded-lg border p-3 gap-1"
                    style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}
                  >
                    <Icon className={`w-4 h-4 ${color}`} />
                    <span className="text-xl font-bold" style={{ color: 'var(--text-slate-900)' }}>
                      {getCount(key, row.id).toLocaleString()}
                    </span>
                    <span className="text-xs text-center" style={{ color: 'var(--text-slate-500)' }}>{label}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}