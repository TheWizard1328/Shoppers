import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, Save, Activity, Clock3, Zap } from 'lucide-react';
import { formatDistanceToNowStrict } from 'date-fns';

const DEFAULT_SETTINGS = {
  enabled: true,
  threshold_credits: 10,
  window_minutes: 15,
  recipient_name: 'Robert T'
};

const TIMEFRAME_OPTIONS = [
  { value: '15', label: 'Last 15 min' },
  { value: '60', label: 'Last hour' },
  { value: '1440', label: 'Last 24 hours' }
];

const formatDuration = (value) => {
  if (!value) return '—';
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
};

export default function IntegrationCreditsTab() {
  const [logs, setLogs] = useState([]);
  const [timeframeMinutes, setTimeframeMinutes] = useState('60');
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [savedSettings, setSavedSettings] = useState(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [logData, config] = await Promise.all([
        base44.entities.IntegrationUsageLog.list('-timestamp', 250),
        base44.entities.AppSettings.filter({ setting_key: 'integration_credit_monitor' })
      ]);

      setLogs(logData || []);

      const loadedSettings = {
        ...DEFAULT_SETTINGS,
        ...(config?.[0]?.setting_value || {})
      };
      setSettings(loadedSettings);
      setSavedSettings(loadedSettings);
    } catch (error) {
      console.error('Failed to load integration credit monitor data:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const unsubscribe = base44.entities.IntegrationUsageLog.subscribe((event) => {
      if (event.type === 'create' && event.data) {
        setLogs((prev) => [event.data, ...prev.filter((item) => item?.id !== event.data.id)].slice(0, 250));
      }
      if (event.type === 'update' && event.data) {
        setLogs((prev) => prev.map((item) => item?.id === event.data.id ? event.data : item));
      }
    });

    return unsubscribe;
  }, []);

  const filteredLogs = useMemo(() => {
    const cutoff = Date.now() - Number(timeframeMinutes) * 60 * 1000;
    return logs.filter((log) => new Date(log.timestamp || log.created_date).getTime() >= cutoff);
  }, [logs, timeframeMinutes]);

  const summary = useMemo(() => {
    const totalEstimatedCredits = filteredLogs.reduce((sum, log) => sum + Number(log.estimated_credits_used || 0), 0);
    const successfulCalls = filteredLogs.filter((log) => log.success).length;
    const avgDuration = filteredLogs.length
      ? Math.round(filteredLogs.reduce((sum, log) => sum + Number(log.duration_ms || 0), 0) / filteredLogs.length)
      : 0;

    const groupedTasks = filteredLogs.reduce((acc, log) => {
      const key = log.feature || log.operation_name || 'Unknown task';
      if (!acc[key]) {
        acc[key] = { name: key, credits: 0, calls: 0, integration: `${log.integration_name}.${log.operation_name}` };
      }
      acc[key].credits += Number(log.estimated_credits_used || 0);
      acc[key].calls += 1;
      return acc;
    }, {});

    const topTasks = Object.values(groupedTasks)
      .sort((a, b) => b.credits - a.credits)
      .slice(0, 5);

    return {
      totalEstimatedCredits,
      successfulCalls,
      avgDuration,
      topTasks
    };
  }, [filteredLogs]);

  const hasChanges = JSON.stringify(settings) !== JSON.stringify(savedSettings);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const existing = await base44.entities.AppSettings.filter({ setting_key: 'integration_credit_monitor' });
      if (existing?.length) {
        await base44.entities.AppSettings.update(existing[0].id, {
          setting_value: settings,
          description: 'Integration credit usage monitoring settings'
        });
      } else {
        await base44.entities.AppSettings.create({
          setting_key: 'integration_credit_monitor',
          setting_value: settings,
          description: 'Integration credit usage monitoring settings'
        });
      }
      setSavedSettings(settings);
    } catch (error) {
      console.error('Failed to save integration credit settings:', error);
      alert(`Failed to save settings: ${error.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-emerald-500 mr-2" />
          <span className="text-slate-600">Loading credit monitoring...</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Alert>
        <AlertDescription>
          This tracks estimated credits used by the app’s wrapped integrations. Actual platform/account credit totals are not exposed here yet.
        </AlertDescription>
      </Alert>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Integration Credits</h2>
          <p className="text-sm text-slate-500">Monitor estimated credit usage by task, user, and integration call.</p>
        </div>
        <div className="w-full lg:w-56">
          <Select value={timeframeMinutes} onValueChange={setTimeframeMinutes}>
            <SelectTrigger>
              <SelectValue placeholder="Select timeframe" />
            </SelectTrigger>
            <SelectContent>
              {TIMEFRAME_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2"><Zap className="w-4 h-4" />Estimated Credits</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-slate-900">{summary.totalEstimatedCredits}</div>
            <p className="text-xs text-slate-500 mt-1">In the selected timeframe</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2"><Activity className="w-4 h-4" />Successful Calls</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-slate-900">{summary.successfulCalls}</div>
            <p className="text-xs text-slate-500 mt-1">Out of {filteredLogs.length} tracked calls</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2"><Clock3 className="w-4 h-4" />Average Duration</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-slate-900">{formatDuration(summary.avgDuration)}</div>
            <p className="text-xs text-slate-500 mt-1">Average integration runtime</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle>Usage by Task</CardTitle>
            <CardDescription>Grouped by feature/task name so you can see which workflows are using credits.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {summary.topTasks.length === 0 && (
                <div className="text-sm text-slate-500">No tracked integration usage yet.</div>
              )}
              {summary.topTasks.map((task) => (
                <div key={task.name} className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <div className="font-medium text-slate-900">{task.name}</div>
                    <div className="text-xs text-slate-500">{task.integration}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold text-slate-900">{task.credits} credits</div>
                    <div className="text-xs text-slate-500">{task.calls} call{task.calls === 1 ? '' : 's'}</div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Credit Alert Settings</CardTitle>
            <CardDescription>Send an in-app message to Robert T when usage spikes within a short window.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label className="text-sm font-medium">Enable monitoring</Label>
                <p className="text-xs text-slate-500">Runs on a schedule and checks recent estimated credit usage.</p>
              </div>
              <Switch
                checked={settings.enabled}
                onCheckedChange={(checked) => setSettings((prev) => ({ ...prev, enabled: checked }))}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="recipient_name">Alert recipient</Label>
              <Input
                id="recipient_name"
                value={settings.recipient_name}
                onChange={(e) => setSettings((prev) => ({ ...prev, recipient_name: e.target.value }))}
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="threshold_credits">Credits threshold</Label>
                <Input
                  id="threshold_credits"
                  type="number"
                  min="1"
                  value={settings.threshold_credits}
                  onChange={(e) => setSettings((prev) => ({ ...prev, threshold_credits: Number(e.target.value || 0) }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="window_minutes">Window minutes</Label>
                <Input
                  id="window_minutes"
                  type="number"
                  min="1"
                  value={settings.window_minutes}
                  onChange={(e) => setSettings((prev) => ({ ...prev, window_minutes: Number(e.target.value || 0) }))}
                />
              </div>
            </div>

            <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
              Current rule: message {settings.recipient_name || 'Robert T'} if estimated usage reaches <span className="font-semibold text-slate-900">{settings.threshold_credits}</span> credits inside <span className="font-semibold text-slate-900">{settings.window_minutes}</span> minutes.
            </div>

            <Button onClick={handleSave} disabled={!hasChanges || isSaving} className="w-full gap-2">
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {isSaving ? 'Saving...' : 'Save Credit Settings'}
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent Integration Usage</CardTitle>
          <CardDescription>Latest wrapped integration calls with user, task, duration, and estimated credits.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left">
                <tr>
                  <th className="p-3 font-semibold">When</th>
                  <th className="p-3 font-semibold">User</th>
                  <th className="p-3 font-semibold">Task</th>
                  <th className="p-3 font-semibold">Integration</th>
                  <th className="p-3 font-semibold">Credits</th>
                  <th className="p-3 font-semibold">Duration</th>
                  <th className="p-3 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {logs.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-6 text-center text-slate-500">No integration usage has been logged yet.</td>
                  </tr>
                )}
                {logs.map((log) => (
                  <tr key={log.id} className="border-t">
                    <td className="p-3 text-slate-600">{formatDistanceToNowStrict(new Date(log.timestamp || log.created_date), { addSuffix: true })}</td>
                    <td className="p-3 text-slate-900">{log.app_user_name || 'Unknown user'}</td>
                    <td className="p-3 text-slate-900">{log.feature || '—'}</td>
                    <td className="p-3 text-slate-600">{log.integration_name}.{log.operation_name}</td>
                    <td className="p-3 text-slate-900">{log.estimated_credits_used || 0}</td>
                    <td className="p-3 text-slate-600">{formatDuration(log.duration_ms)}</td>
                    <td className="p-3">
                      <Badge variant={log.success ? 'default' : 'destructive'}>{log.success ? 'Success' : 'Failed'}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}