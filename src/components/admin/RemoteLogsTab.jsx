import React, { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import MultiSelect from '@/components/ui/multi-select';
import { Label } from '@/components/ui/label';
import { sortUsers, sortStores } from '@/components/utils/sorting';
import { clearRemoteLogs } from '@/functions/clearRemoteLogs';

export default function RemoteLogsTab({ appUsers = [] }) {
  const [logs, setLogs] = useState([]);
  const [settings, setSettings] = useState(null);
  const [search, setSearch] = useState('');
  const [level, setLevel] = useState('all');
  const [selectedUsers, setSelectedUsers] = useState([]);
  const [logUserFilter, setLogUserFilter] = useState('all');
  const [live, setLive] = useState(false);

  const loadData = async () => {
    try {
      // Settings first — fast single record, needed immediately for toggle/selection state
      const allSettings = await base44.entities.RemoteLoggingSettings.filter({ scope: 'global' }, '-updated_date', 10);
      const valid = (allSettings || []).filter((s) => s?.scope === 'global');
      const latest = valid.sort((a, b) => new Date(b.updated_date || 0) - new Date(a.updated_date || 0))[0] || null;
      setSettings(latest);
      setSelectedUsers(latest?.included_user_ids || []);
      // Logs — slow, non-blocking
      try {
        // CRITICAL: sort by created_date (platform-indexed) — sorting by the
        // custom 'timestamp' field does an unindexed collection scan over 500k+
        // rows and times out, leaving the list silently empty.
        const logRows = await base44.entities.RemoteLogEntry.list('-created_date', 100);
        setLogs(logRows || []);
      } catch (_) {}
    } catch (e) {
      // Non-critical admin panel — empty state is fine
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => loadData(), 50);
    return () => clearTimeout(timer);
  }, []);

  // ── LIVE WS FEED ──────────────────────────────────────────────────────
  // Subscribe to RemoteLogEntry broadcasts while the tab is open so new
  // entries stream in live (the bulk list load only runs once on mount,
  // which made the panel look frozen even while logs were flowing).
  // Events are batched (bulkCreate flushes up to 20 records per burst) to
  // avoid re-render storms.
  useEffect(() => {
    let unsub = null;
    let pending = [];
    let flushTimer = null;

    const flushPending = () => {
      flushTimer = null;
      if (pending.length === 0) return;
      const incoming = pending;
      pending = [];
      setLogs((prev) => {
        const map = new Map((prev || []).map((l) => [l?.id, l]).filter(([id]) => !!id));
        for (const rec of incoming) {
          if (!rec?.id) continue;
          if (rec.__deleted) { map.delete(rec.id); continue; }
          map.set(rec.id, rec);
        }
        const merged = Array.from(map.values());
        merged.sort((a, b) =>
          new Date(b?.timestamp || b?.created_date || 0) - new Date(a?.timestamp || a?.created_date || 0)
        );
        return merged.slice(0, 200);
      });
    };

    const scheduleFlush = () => {
      if (!flushTimer) flushTimer = setTimeout(flushPending, 1200);
    };

    try {
      unsub = base44.entities.RemoteLogEntry.subscribe((event) => {
        const { type, id, data } = event || {};
        if (type === 'create' && data) {
          pending.push(data);
          scheduleFlush();
        } else if (type === 'update' && data) {
          pending.push(data);
          scheduleFlush();
        } else if (type === 'delete') {
          pending.push({ id, __deleted: true });
          scheduleFlush();
        }
      });
      if (typeof unsub === 'function') setLive(true);
    } catch (e) {
      setLive(false);
    }

    return () => {
      try { if (typeof unsub === 'function') unsub(); } catch (_) {}
      if (flushTimer) clearTimeout(flushTimer);
    };
  }, []);

  const ensureSettings = async () => {
    if (settings?.id) return settings;
    const existing = await base44.entities.RemoteLoggingSettings.filter({ scope: 'global' }, '-updated_date', 100)
      .then((rows) => (rows || []).filter((s) => s?.scope === 'global')
        .sort((a, b) => new Date(b.updated_date || 0) - new Date(a.updated_date || 0))[0] || null);
    if (existing) {
      setSettings(existing);
      setSelectedUsers(existing.included_user_ids || []);
      return existing;
    }
    const created = await base44.entities.RemoteLoggingSettings.create({
      scope: 'global',
      enabled: false,
      capture_levels: ['warn', 'error', 'debug'],
      included_user_ids: [],
      excluded_user_ids: [],
      batch_size: 20,
      flush_interval_ms: 15000
    });
    setSettings(created);
    return created;
  };

  const updateSettings = async (patch) => {
    const current = await ensureSettings();
    const merged = { ...current, ...patch };
    const updated = await base44.entities.RemoteLoggingSettings.update(current.id, merged);
    setSettings(updated);
    window.__remoteLogSettingsCache = null;
  };

  const clearLogs = async () => {
    try {
      await clearRemoteLogs({});
    } catch (e) {
      console.warn('[RemoteLogsTab] Clear failed:', e?.message || e);
    }
    await loadData();
  };


  const filteredLogs = useMemo(() => {
    return (logs || []).filter((log) => {
      if (level !== 'all' && log.level !== level) return false;
      if (search && !`${log.message} ${log.user_name || ''} ${log.page || ''}`.toLowerCase().includes(search.toLowerCase())) return false;
      if (logUserFilter !== 'all' && log.user_id !== logUserFilter) return false;
      return true;
    });
  }, [logs, search, level, logUserFilter]);

  const driverUsers = useMemo(() => {
    return sortUsers((appUsers || []).filter((user) => user?.status === 'active' && user?.app_roles?.includes('driver')));
  }, [appUsers]);

  const storeUsers = useMemo(() => {
    return sortStores((appUsers || []).filter((user) => user?.status === 'active' && user?.app_roles?.includes('dispatcher')));
  }, [appUsers]);

  const driverOptions = useMemo(() => {
    return driverUsers.map((user) => ({
      value: user.user_id || user.id,
      label: user.user_name || user.full_name || user.id
    }));
  }, [driverUsers]);

  const storeOptions = useMemo(() => {
    return storeUsers.map((user) => ({
      value: user.user_id || user.id,
      label: user.user_name || user.full_name || user.id
    }));
  }, [storeUsers]);

  const selectedDriverUsers = useMemo(() => {
    return selectedUsers.filter((id) => driverOptions.some((user) => user.value === id));
  }, [selectedUsers, driverOptions]);

  const selectedStoreUsers = useMemo(() => {
    return selectedUsers.filter((id) => storeOptions.some((user) => user.value === id));
  }, [selectedUsers, storeOptions]);

  const logFilterOptions = useMemo(() => {
    return Array.from(new Map((logs || []).
    filter((row) => row?.user_id).
    map((row) => [row.user_id, { value: row.user_id, label: row.user_name || row.user_id }])).values());
  }, [logs]);

  return (
    <div className="space-y-">
      <Card>
        <CardHeader className="px-6 py-3 flex flex-col space-y-1.5">
          <CardTitle>Remote Logging</CardTitle>
        </CardHeader>
        <CardContent className="px-6 py-3 space-y-4">
          <div className="flex items-center justify-between">
            <span className="font-medium">Global logging</span>
            <Switch checked={settings?.enabled === true} onCheckedChange={(checked) => updateSettings({ enabled: checked, capture_levels: ['log', 'info', 'warn', 'error', 'debug'], included_user_ids: settings?.included_user_ids || [] })} />
          </div>
          <div className="space-y-1">
            <div className="font-medium">Only log selected users</div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <div className="text-sm font-medium text-slate-700 dark:text-slate-300">Drivers</div>
                <MultiSelect
                  options={driverOptions}
                  value={selectedDriverUsers}
                  onChange={(nextSelected) => {
                    const currentStoreIds = new Set(selectedUsers.filter((id) => storeOptions.some((o) => o.value === id)));
                    const next = [...new Set([...nextSelected, ...currentStoreIds])];
                    setSelectedUsers(next);
                    updateSettings({ included_user_ids: next });
                  }}
                  placeholder="Select drivers" className="bg-background px-4 text-sm font-medium rounded-md h-auto inline-flex min-w-11 items-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 border shadow-sm hover:bg-accent hover:text-accent-foreground w-full justify-between min-h-[52px] border-black undefined" />
                
              </div>
              <div className="space-y-2">
                <div className="text-sm font-medium text-slate-700 dark:text-slate-300">Stores</div>
                <MultiSelect
                  options={storeOptions}
                  value={selectedStoreUsers}
                  onChange={(nextSelected) => {
                    const currentDriverIds = new Set(selectedUsers.filter((id) => driverOptions.some((o) => o.value === id)));
                    const next = [...new Set([...currentDriverIds, ...nextSelected])];
                    setSelectedUsers(next);
                    updateSettings({ included_user_ids: next });
                  }}
                  placeholder="Select stores" className="h-auto inline-flex min-w-11 items-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 border bg-background shadow-sm hover:bg-accent hover:text-accept-foreground px-4 w-full justify-between min-h-[52px] border-black undefined" />
                
              </div>
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">If nobody is selected, logging applies to all users except excluded ones.</div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="px-6 py-3 flex flex-col space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            Recent Remote Logs
            {live && (
              <span className="inline-flex items-center gap-1.5 text-xs font-normal text-green-600 dark:text-green-400">
                <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                Live
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-2 md:flex-row">
            <Input placeholder="Search logs..." value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="w-full md:w-72">
              
              <Select value={logUserFilter} onValueChange={setLogUserFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="Filter user" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All users</SelectItem>
                  {logFilterOptions.map((user) =>
                  <SelectItem key={user.value} value={user.value}>{user.label}</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            <Select value={level} onValueChange={setLevel}>
              <SelectTrigger className="w-full md:w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All levels</SelectItem>
                <SelectItem value="log">log</SelectItem>
                <SelectItem value="info">info</SelectItem>
                <SelectItem value="warn">warn</SelectItem>
                <SelectItem value="error">error</SelectItem>
                <SelectItem value="debug">debug</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={loadData}>Refresh</Button>
            <Button variant="destructive" onClick={clearLogs}>Clear Logs</Button>
          </div>

          <div className="max-h-[600px] overflow-auto rounded border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white dark:bg-slate-900 border-b">
                <tr>
                  <th className="p-2 text-left">Time</th>
                  <th className="p-2 text-left">Level</th>
                  <th className="p-2 text-left">User</th>
                  <th className="p-2 text-left">Page</th>
                  <th className="p-2 text-left">Message</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.map((log) =>
                <tr key={log.id} className="border-b align-top">
                    <td className="p-2 whitespace-nowrap">{log.timestamp?.replace('T', ' ').slice(0, 19)}</td>
                    <td className="p-2 whitespace-nowrap">{log.level}</td>
                    <td className="p-2 whitespace-nowrap">{log.user_name || log.user_id || '-'}</td>
                    <td className="p-2 whitespace-nowrap">{log.page || '-'}</td>
                    <td className="p-2 break-words">{log.message}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>);

}