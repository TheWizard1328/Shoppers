import React, { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import MultiSelect from '@/components/ui/multi-select';
import { sortUsers, sortStores } from '@/components/utils/sorting';

export default function RemoteLogsTab({ appUsers = [] }) {
  const [logs, setLogs] = useState([]);
  const [settings, setSettings] = useState(null);
  const [search, setSearch] = useState('');
  const [level, setLevel] = useState('all');
  const [selectedUsers, setSelectedUsers] = useState([]);

  const loadData = async () => {
    const [logRows, settingsRows] = await Promise.all([
    base44.entities.RemoteLogEntry.list('-timestamp', 300),
    base44.entities.RemoteLoggingSettings.filter({ scope: 'global' }, '-updated_date', 1)]
    );
    setLogs(logRows || []);
    setSettings(settingsRows?.[0] || null);
    setSelectedUsers(settingsRows?.[0]?.included_user_ids || []);
  };

  useEffect(() => {
    loadData();
  }, []);

  const ensureSettings = async () => {
    if (settings?.id) return settings;
    const created = await base44.entities.RemoteLoggingSettings.create({
      scope: 'global',
      enabled: false,
      capture_levels: ['log', 'info', 'warn', 'error', 'debug'],
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
    const updated = await base44.entities.RemoteLoggingSettings.update(current.id, { ...current, ...patch });
    setSettings(updated);
  };


  const filteredLogs = useMemo(() => {
    return (logs || []).filter((log) => {
      if (level !== 'all' && log.level !== level) return false;
      if (search && !`${log.message} ${log.user_name || ''} ${log.page || ''}`.toLowerCase().includes(search.toLowerCase())) return false;
      if (selectedUsers.length > 0 && !selectedUsers.includes(log.user_id)) return false;
      return true;
    });
  }, [logs, search, level, selectedUsers]);

  const driverUsers = useMemo(() => {
    return sortUsers((appUsers || []).filter((user) => user?.status === 'active' && user?.app_roles?.includes('driver')));
  }, [appUsers]);

  const storeUsers = useMemo(() => {
    return sortStores((appUsers || []).filter((user) => user?.status === 'active' && user?.app_roles?.includes('dispatcher')));
  }, [appUsers]);

  const combinedUserOptions = useMemo(() => {
    const drivers = driverUsers.map((user) => ({
      value: user.user_id || user.id,
      label: user.user_name || user.full_name || user.id
    }));
    const stores = storeUsers.map((user) => ({
      value: user.user_id || user.id,
      label: user.user_name || user.full_name || user.id
    }));
    return [...drivers, ...stores];
  }, [driverUsers, storeUsers]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Remote Logging</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="font-medium">Global logging</span>
            <Switch checked={settings?.enabled === true} onCheckedChange={(checked) => updateSettings({ enabled: checked })} />
          </div>
          <div className="space-y-1">
            <div className="font-medium">Only log selected users</div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <div className="text-sm font-medium text-slate-700">Drivers</div>
                <MultiSelect
                  options={driverUsers.map((user) => ({
                    value: user.user_id || user.id,
                    label: user.user_name || user.full_name || user.id
                  }))}
                  selected={selectedUsers.filter((id) => driverUsers.some((user) => (user.user_id || user.id) === id))}
                  onChange={(nextSelected) => {
                    const storeSelected = selectedUsers.filter((id) => storeUsers.some((user) => (user.user_id || user.id) === id));
                    const next = [...new Set([...storeSelected, ...nextSelected])];
                    setSelectedUsers(next);
                    updateSettings({ included_user_ids: next });
                  }}
                  placeholder="Select drivers"
                />
              </div>
              <div className="space-y-2">
                <div className="text-sm font-medium text-slate-700">Stores</div>
                <MultiSelect
                  options={storeUsers.map((user) => ({
                    value: user.user_id || user.id,
                    label: user.user_name || user.full_name || user.id
                  }))}
                  selected={selectedUsers.filter((id) => storeUsers.some((user) => (user.user_id || user.id) === id))}
                  onChange={(nextSelected) => {
                    const driverSelected = selectedUsers.filter((id) => driverUsers.some((user) => (user.user_id || user.id) === id));
                    const next = [...new Set([...driverSelected, ...nextSelected])];
                    setSelectedUsers(next);
                    updateSettings({ included_user_ids: next });
                  }}
                  placeholder="Select stores"
                />
              </div>
            </div>
            <div className="text-xs text-slate-500">If nobody is selected, logging applies to all users except excluded ones.</div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent Remote Logs</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-2 md:flex-row">
            <Input placeholder="Search logs..." value={search} onChange={(e) => setSearch(e.target.value)} />
            <MultiSelect
              options={combinedUserOptions}
              value={selectedUsers}
              onChange={setSelectedUsers}
              placeholder="Filter users"
              className="md:w-72"
            />
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
          </div>

          <div className="max-h-[600px] overflow-auto rounded border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white border-b">
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