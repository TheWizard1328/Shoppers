import React, { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { RefreshCw, Activity, Wifi, AlertTriangle } from 'lucide-react';
import { forceDriverSyncRefresh } from '@/functions/forceDriverSyncRefresh';

const HEARTBEAT_WARNING_MS = 2 * 60 * 1000;
const HEARTBEAT_STALE_MS = 5 * 60 * 1000;

function formatTimeAgo(value) {
  if (!value) return 'Never';
  const diffMs = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return 'Just now';
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function getHeartbeatState(timestamp) {
  if (!timestamp) return { label: 'No heartbeat', variant: 'destructive' };
  const age = Date.now() - new Date(timestamp).getTime();
  if (age >= HEARTBEAT_STALE_MS) return { label: 'Stale', variant: 'destructive' };
  if (age >= HEARTBEAT_WARNING_MS) return { label: 'Delayed', variant: 'secondary' };
  return { label: 'Healthy', variant: 'default' };
}

export default function DriverSyncManagementTab({ appUsers = [] }) {
  const [search, setSearch] = useState('');
  const [refreshingIds, setRefreshingIds] = useState([]);

  const drivers = useMemo(() => {
    return (appUsers || [])
      .filter((user) => user?.status === 'active' && user?.app_roles?.includes('driver'))
      .filter((user) => {
        if (!search.trim()) return true;
        const haystack = `${user.user_name || ''} ${user.user_id || ''}`.toLowerCase();
        return haystack.includes(search.toLowerCase());
      })
      .sort((a, b) => (a.user_name || '').localeCompare(b.user_name || ''));
  }, [appUsers, search]);

  const summary = useMemo(() => {
    const counts = { healthy: 0, delayed: 0, stale: 0, noHeartbeat: 0 };
    drivers.forEach((driver) => {
      const state = getHeartbeatState(driver.location_updated_at);
      if (state.label === 'Healthy') counts.healthy += 1;
      else if (state.label === 'Delayed') counts.delayed += 1;
      else if (state.label === 'Stale') counts.stale += 1;
      else counts.noHeartbeat += 1;
    });
    return counts;
  }, [drivers]);

  const handleRefresh = async (driver) => {
    setRefreshingIds((prev) => [...prev, driver.id]);
    try {
      await forceDriverSyncRefresh({ driverUserId: driver.user_id, driverAppUserId: driver.id });
    } finally {
      setRefreshingIds((prev) => prev.filter((id) => id !== driver.id));
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Driver Sync Management</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-4">
            <div className="rounded-lg border p-3"><div className="text-xs text-muted-foreground">Healthy</div><div className="text-2xl font-semibold">{summary.healthy}</div></div>
            <div className="rounded-lg border p-3"><div className="text-xs text-muted-foreground">Delayed</div><div className="text-2xl font-semibold">{summary.delayed}</div></div>
            <div className="rounded-lg border p-3"><div className="text-xs text-muted-foreground">Stale</div><div className="text-2xl font-semibold">{summary.stale}</div></div>
            <div className="rounded-lg border p-3"><div className="text-xs text-muted-foreground">No heartbeat</div><div className="text-2xl font-semibold">{summary.noHeartbeat}</div></div>
          </div>

          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <AlertTriangle className="h-4 w-4" />
            Use this to spot stale driver devices and manually request a full sync refresh for one driver.
          </div>

          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search drivers..."
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Driver</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Heartbeat</TableHead>
                <TableHead>Duty</TableHead>
                <TableHead>Tracking</TableHead>
                <TableHead>Location</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {drivers.map((driver) => {
                const heartbeat = getHeartbeatState(driver.location_updated_at);
                const isRefreshing = refreshingIds.includes(driver.id);
                return (
                  <TableRow key={driver.id}>
                    <TableCell>
                      <div className="font-medium">{driver.user_name || 'Unnamed Driver'}</div>
                      <div className="text-xs text-muted-foreground">{driver.user_id}</div>
                    </TableCell>
                    <TableCell><Badge variant={heartbeat.variant}>{heartbeat.label}</Badge></TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Activity className="h-4 w-4 text-muted-foreground" />
                        {formatTimeAgo(driver.location_updated_at)}
                      </div>
                    </TableCell>
                    <TableCell>{driver.driver_status || '-'}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Wifi className="h-4 w-4 text-muted-foreground" />
                        {driver.location_tracking_enabled ? 'Enabled' : 'Off'}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {driver.current_latitude && driver.current_longitude
                        ? `${Number(driver.current_latitude).toFixed(5)}, ${Number(driver.current_longitude).toFixed(5)}`
                        : 'No location'}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="outline" onClick={() => handleRefresh(driver)} disabled={isRefreshing}>
                        <RefreshCw className={`mr-2 h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                        Refresh Driver
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}