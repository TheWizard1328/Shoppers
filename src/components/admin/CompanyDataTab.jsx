/**
 * CompanyDataTab.jsx
 * Admin Companies tab: which entities belong to each company.
 *
 * Nov 8 2026 (owner request):
 * 1. "Backfill Company IDs" runs a server-side backfill (backfillCompanyIds) that
 *    stamps every blank company_id on Store / Delivery / Payroll / AppUser with the
 *    single company's real record id, then reloads the counts.
 * 2. "Refresh" reloads the counts from IndexedDB first (fast, no rate limit) and
 *    falls back to paced server reads when IDB has nothing.
 * 3. Counts are no longer truncated: the old code read only the newest 500
 *    deliveries, which is why the totals disagreed with reality.
 */
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Building2, Users, Package, MapPin, HeartPulse, DollarSign, RefreshCw, DatabaseZap } from 'lucide-react';
import { offlineDB } from '@/components/utils/offlineDatabase';

const RGISTICS_LABEL = 'RGistics (default)';
const PAGE = 500;
const MAX_PAGES = 60; // hard stop: 30k records per entity

// entity key → { server entity name, IDB store }
const SOURCES = {
  appUsers: { entity: 'AppUser', store: 'app_users' },
  deliveries: { entity: 'Delivery', store: 'deliveries' },
  stores: { entity: 'Store', store: 'stores' },
  patients: { entity: 'Patient', store: 'patients' },
  payrolls: { entity: 'Payroll', store: 'payroll' },
  interStores: { entity: 'InterStoreLocation', store: 'inter_store_locations' },
};

const buildCounts = (records) => {
  const map = {};
  (records || []).forEach((r) => {
    const key = r?.company_id ? String(r.company_id).trim() : 'default';
    const k = key || 'default';
    map[k] = (map[k] || 0) + 1;
  });
  return map;
};

export default function CompanyDataTab() {
  const [companies, setCompanies] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [source, setSource] = useState('server');
  const [backfill, setBackfill] = useState(null); // { running, log[], summary }
  const [backfillError, setBackfillError] = useState('');

  // Read one entity, IDB first (unless we are doing an explicit server reconcile).
  const readEntity = useCallback(async (key, preferIdb) => {
    const cfg = SOURCES[key];
    if (preferIdb) {
      try {
        const rows = await offlineDB.getAll(cfg.store);
        if (Array.isArray(rows) && rows.length) return { rows, from: 'idb' };
      } catch {
        /* fall through to server */
      }
    }
    const rows = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const chunk = await base44.entities[cfg.entity].list('-created_date', PAGE, page * PAGE).catch(() => []);
      if (!Array.isArray(chunk) || chunk.length === 0) break;
      rows.push(...chunk);
      if (chunk.length < PAGE) break;
    }
    return { rows, from: 'server' };
  }, []);

  const load = useCallback(async ({ preferIdb }) => {
    const keys = Object.keys(SOURCES);
    const [companyList, ...reads] = await Promise.all([
      preferIdb
        ? offlineDB.getAll('companies').catch(() => []).then((r) => (r?.length ? r : base44.entities.Company.list('-created_date', 50).catch(() => [])))
        : base44.entities.Company.list('-created_date', 50).catch(() => []),
      ...keys.map((k) => readEntity(k, preferIdb)),
    ]);

    const next = {};
    let anyIdb = false;
    keys.forEach((k, i) => {
      next[k] = buildCounts(reads[i]?.rows);
      if (reads[i]?.from === 'idb') anyIdb = true;
    });
    setCounts(next);
    setCompanies(Array.isArray(companyList) ? companyList : []);
    setSource(anyIdb ? 'IndexedDB' : 'server');
  }, [readEntity]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await load({ preferIdb: true });
      } catch (err) {
        console.error('CompanyDataTab load error:', err);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [load]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await load({ preferIdb: true });
    } finally {
      setRefreshing(false);
    }
  };

  const handleBackfill = async () => {
    setBackfillError('');
    setBackfill({ running: true, log: [], summary: null });
    const log = [];
    const push = (line) => {
      log.push(line);
      setBackfill({ running: true, log: [...log], summary: null });
    };
    try {
      for (let pass = 1; pass <= 12; pass += 1) {
        const res = await base44.functions.invoke('backfillCompanyIds', {});
        const data = res?.data || res;
        if (data?.error) throw new Error(data.error);
        const parts = Object.entries(data?.results || {}).map(([name, r]) => `${name}: ${r.updated} updated${r.remaining ? `, ${r.remaining} left` : ''}`);
        push(`Pass ${pass} — ${data?.company_name || 'company'} — ${parts.join(' | ')}`);
        if (data?.done) {
          setBackfill({
            running: false,
            log: [...log],
            summary: `Done. ${data?.updated_this_run ?? 0} records stamped with ${data?.company_name || 'the company'} on this pass.`,
          });
          break;
        }
        if (pass === 12) {
          push('Stopped after 12 passes — press Backfill again to continue.');
          setBackfill({ running: false, log: [...log], summary: 'More blanks remain. Press Backfill again.' });
        }
      }
      // Reconcile from the server so the counts reflect the writes just made.
      await load({ preferIdb: false });
    } catch (err) {
      setBackfillError(err?.message || 'Backfill failed');
      setBackfill((b) => ({ running: false, log: b?.log || [], summary: null }));
    }
  };

  // Rows: default (blank) + real companies + orphaned ids
  const rows = useMemo(() => {
    const realIds = new Set(companies.map((c) => c.id));
    const allKeys = new Set(Object.values(counts).flatMap((m) => Object.keys(m)));
    const result = [];

    const hasDefaultRecords = Object.values(counts).some((m) => m['default'] > 0);
    if (hasDefaultRecords) result.push({ id: 'default', name: RGISTICS_LABEL, isDefault: true });

    companies.forEach((c) => result.push({ id: c.id, name: c.name, isDefault: false, company: c }));

    allKeys.forEach((key) => {
      if (key !== 'default' && !realIds.has(key)) {
        result.push({ id: key, name: `Unknown (${key.substring(0, 8)}…)`, isDefault: false, isOrphaned: true });
      }
    });
    return result;
  }, [companies, counts]);

  const getCount = (entity, companyId) => counts[entity]?.[companyId] ?? 0;

  const statDefs = [
    { key: 'stores', label: 'Stores', Icon: MapPin, color: 'text-emerald-600 dark:text-emerald-400' },
    { key: 'patients', label: 'Patients', Icon: HeartPulse, color: 'text-blue-600 dark:text-blue-400' },
    { key: 'appUsers', label: 'App Users', Icon: Users, color: 'text-purple-600 dark:text-purple-400' },
    { key: 'deliveries', label: 'Deliveries', Icon: Package, color: 'text-orange-600 dark:text-orange-400' },
    { key: 'payrolls', label: 'Payrolls', Icon: DollarSign, color: 'text-yellow-600 dark:text-yellow-400' },
    { key: 'interStores', label: 'ISP Locations', Icon: Building2, color: 'text-slate-600 dark:text-slate-400' },
  ];

  if (loading) {
    return (
      <div className="flex justify-center items-center h-40">
        <Loader2 className="w-8 h-8 animate-spin text-emerald-500 dark:text-emerald-400" />
        <span className="ml-3 text-slate-600 dark:text-slate-400">Loading company data...</span>
      </div>
    );
  }

  const blankTotal = statDefs.reduce((sum, s) => sum + getCount(s.key, 'default'), 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={handleRefresh} disabled={refreshing || backfill?.running} className="gap-2">
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
        </Button>
        <Button size="sm" onClick={handleBackfill} disabled={backfill?.running} className="gap-2 bg-emerald-600 hover:bg-emerald-500 text-white">
          {backfill?.running ? <Loader2 className="w-4 h-4 animate-spin" /> : <DatabaseZap className="w-4 h-4" />}
          {backfill?.running ? 'Backfilling…' : 'Backfill Companies'}
        </Button>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          Source: {source} · {blankTotal.toLocaleString()} blank company_id
        </span>
      </div>

      {backfillError && (
        <div className="text-sm rounded-lg border border-red-300 bg-red-50 text-red-700 px-3 py-2 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {backfillError}
        </div>
      )}

      {backfill && (
        <div className="text-xs font-mono rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 space-y-0.5 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
          {backfill.log.map((line, i) => <div key={i}>{line}</div>)}
          {backfill.summary && <div className="font-semibold text-emerald-700 dark:text-emerald-400">{backfill.summary}</div>}
        </div>
      )}

      <div className="text-sm text-slate-500 dark:text-slate-400 bg-blue-50 dark:bg-blue-950 border border-blue-200 rounded-lg px-3 py-2 dark:border-blue-800">
        Records with a blank <code className="font-mono text-xs bg-blue-100 px-1 rounded dark:bg-blue-900">company_id</code> are counted under <strong>RGistics (default)</strong>. Backfill Companies stamps them with the single company's real record id.
      </div>

      {rows.map((row) => {
        const total = statDefs.reduce((sum, s) => sum + getCount(s.key, row.id), 0);
        return (
          <Card key={row.id} className="bg-surface border-surface">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base text-body">
                <Building2 className="w-5 h-5 text-slate-500 dark:text-slate-400" />
                {row.name}
                {row.isDefault && <Badge variant="secondary" className="text-xs">Default</Badge>}
                {row.isOrphaned && <Badge variant="destructive" className="text-xs">Orphaned ID</Badge>}
                <span className="ml-auto text-sm font-normal text-slate-500 dark:text-slate-400">{total.toLocaleString()} total records</span>
              </CardTitle>
              {row.company && (
                <CardDescription className="text-soft">
                  {row.company.contact_email || row.company.website_url || ''}
                </CardDescription>
              )}
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                {statDefs.map(({ key, label, Icon, color }) => (
                  <div
                    key={key}
                    className="flex flex-col items-center justify-center rounded-lg border p-3 gap-1 border-surface" style={{ background: 'var(--bg-slate-50)' }}
                  >
                    <Icon className={`w-4 h-4 ${color}`} />
                    <span className="text-xl font-bold text-body">
                      {getCount(key, row.id).toLocaleString()}
                    </span>
                    <span className="text-xs text-center text-soft">{label}</span>
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
