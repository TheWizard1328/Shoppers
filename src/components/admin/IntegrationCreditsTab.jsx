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
{ value: '1440', label: 'Last 24 hours' }];


const LOG_FETCH_LIMIT = 10000;

const getLogCallWeight = (log) => {
  const rawValue = Number(log?.metadata?.call_count ?? log?.metadata?.api_calls ?? 1);
  return Number.isFinite(rawValue) && rawValue > 0 ? rawValue : 1;
};

const normalizeApiLogToIntegrationLog = (log) => {
  const provider = String(log?.metadata?.api_provider || '').toLowerCase();
  const integrationName = provider === 'here' || String(log?.api_type || '').toLowerCase().includes('here') ? 'HERE' : 'Google';
  const errorMessage = log?.metadata?.error || null;
  const statusCode = Number(log?.metadata?.status_code);

  return {
    ...log,
    id: `api-log-${log.id}`,
    integration_name: integrationName,
    operation_name: log.api_type || 'API Call',
    feature: log.purpose || log.function_name || log.api_type || 'External API',
    app_user_id: log.user_id || null,
    app_user_name: log.user_name || null,
    auth_user_id: log.user_id || null,
    duration_ms: null,
    success: errorMessage ? false : !(Number.isFinite(statusCode) && statusCode >= 400),
    estimated_credits_used: 0,
    error_message: errorMessage,
    metadata: {
      ...(log.metadata || {}),
      source_entity: 'GoogleAPILog'
    }
  };
};

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
      const [logData, apiLogData, config] = await Promise.all([
      base44.entities.IntegrationUsageLog.list('-timestamp', LOG_FETCH_LIMIT),
      base44.entities.GoogleAPILog.list('-timestamp', LOG_FETCH_LIMIT),
      base44.entities.AppSettings.filter({ setting_key: 'integration_credit_monitor' })]
      );

      const mergedLogs = [
      ...(logData || []),
      ...(apiLogData || []).map(normalizeApiLogToIntegrationLog)].
      sort((a, b) => new Date(b.timestamp || b.created_date).getTime() - new Date(a.timestamp || a.created_date).getTime()).
      slice(0, LOG_FETCH_LIMIT);

      setLogs(mergedLogs);

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
    const mergeLiveLog = (nextLog) => {
      setLogs((prev) => [nextLog, ...prev.filter((item) => item?.id !== nextLog.id)].slice(0, LOG_FETCH_LIMIT));
    };

    const unsubscribeIntegration = base44.entities.IntegrationUsageLog.subscribe((event) => {
      if (event.type === 'create' && event.data) {
        mergeLiveLog(event.data);
      }
      if (event.type === 'update' && event.data) {
        setLogs((prev) => prev.map((item) => item?.id === event.data.id ? event.data : item));
      }
    });

    const unsubscribeApi = base44.entities.GoogleAPILog.subscribe((event) => {
      if (event.type === 'create' && event.data) {
        mergeLiveLog(normalizeApiLogToIntegrationLog(event.data));
      }
      if (event.type === 'update' && event.data) {
        const normalized = normalizeApiLogToIntegrationLog(event.data);
        setLogs((prev) => prev.map((item) => item?.id === normalized.id ? normalized : item));
      }
    });

    return () => {
      unsubscribeIntegration();
      unsubscribeApi();
    };
  }, []);

  const filteredLogs = useMemo(() => {
    const cutoff = Date.now() - Number(timeframeMinutes) * 60 * 1000;
    return logs.filter((log) => new Date(log.timestamp || log.created_date).getTime() >= cutoff);
  }, [logs, timeframeMinutes]);

  const summary = useMemo(() => {
    const totalEstimatedCredits = filteredLogs.reduce((sum, log) => sum + Number(log.estimated_credits_used || 0), 0);
    const successfulCalls = filteredLogs.reduce((sum, log) => log.success ? sum + getLogCallWeight(log) : sum, 0);
    const failedCalls = filteredLogs.reduce((sum, log) => log.success === false ? sum + getLogCallWeight(log) : sum, 0);
    const logsWithDuration = filteredLogs.filter((log) => Number(log.duration_ms) > 0);
    const avgDuration = logsWithDuration.length ?
    Math.round(logsWithDuration.reduce((sum, log) => sum + Number(log.duration_ms || 0), 0) / logsWithDuration.length) :
    0;

    const groupedTasks = filteredLogs.reduce((acc, log) => {
      const key = log.feature || log.operation_name || 'Unknown task';
      if (!acc[key]) {
        acc[key] = { name: key, credits: 0, calls: 0, integration: `${log.integration_name}.${log.operation_name}` };
      }
      acc[key].credits += Number(log.estimated_credits_used || 0);
      acc[key].calls += getLogCallWeight(log);
      return acc;
    }, {});

    const topTasks = Object.values(groupedTasks).
    sort((a, b) => b.credits - a.credits || b.calls - a.calls).
    slice(0, 5);

    const failureHotspots = Object.values(
      filteredLogs.
      filter((log) => log.success === false).
      reduce((acc, log) => {
        const key = `${log.integration_name}.${log.operation_name}__${log.error_message || 'Unknown error'}`;
        if (!acc[key]) {
          acc[key] = {
            key,
            integration: `${log.integration_name}.${log.operation_name}`,
            error: log.error_message || 'Unknown error',
            count: 0
          };
        }
        acc[key].count += getLogCallWeight(log);
        return acc;
      }, {})
    ).
    sort((a, b) => b.count - a.count).
    slice(0, 5);

    return {
      totalEstimatedCredits,
      successfulCalls,
      failedCalls,
      avgDuration,
      topTasks,
      failureHotspots
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
      </Card>);

  }

  return (
    <div className="flex-1 min-h-0 h-full space-y-2 overflow-y-auto pr-1">
      <Alert>
        <AlertDescription>
          This now combines wrapped app integrations with Google and HERE API activity, including failures, so you can spot gaps, retry loops, and runaway usage faster.
        </AlertDescription>
      </Alert>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Integration Credits</h2>
          <p className="text-sm text-slate-500">Monitor estimated credit usage by task, user, and integration call.</p>
          <p className="text-xs text-slate-400 mt-1">Loaded {logs.length} recent logs, showing {filteredLogs.length} in the selected window.</p>
        </div>
        <div className="w-full lg:w-56">
          <Select value={timeframeMinutes} onValueChange={setTimeframeMinutes}>
            <SelectTrigger>
              <SelectValue placeholder="Select timeframe" />
            </SelectTrigger>
            <SelectContent>
              {TIMEFRAME_OPTIONS.map((option) =>
              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-2 xl:grid-cols-[0.9fr_1.1fr_0.9fr]">
        <div className="grid gap-2 sm:grid-cols-2">
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
              <p className="text-xs text-slate-500 mt-1">Out of {summary.successfulCalls + summary.failedCalls} tracked calls</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2"><Activity className="w-4 h-4" />Failed Calls</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-red-600">{summary.failedCalls}</div>
              <p className="text-xs text-slate-500 mt-1">Calls that ended in failure</p>
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

        <Card>
          <CardHeader className="pt-3 pr-6 pb-1 pl-6 flex flex-col space-y-1.5">
            <CardTitle>Usage by Task</CardTitle>
            <CardDescription>Grouped by feature/task name so you can see which workflows are using credits.</CardDescription>
          </CardHeader>
          <CardContent className="px-3 py-3">
            <div className="space-y-1.5">
              {summary.topTasks.length === 0 &&
              <div className="text-sm text-slate-500">No tracked integration usage yet.</div>
              }
              {summary.topTasks.map((task) =>
              <div key={task.name} className="px-3 py-2 rounded-lg flex items-center justify-between border">
                  <div>
                    <div className="font-medium text-slate-900">{task.name}</div>
                    <div className="text-xs text-slate-500">{task.integration}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold text-slate-900">{task.credits} credits</div>
                    <div className="text-xs text-slate-500">{task.calls} call{task.calls === 1 ? '' : 's'}</div>
                  </div>
                </div>
              )}

              <div className="pt-3 border-t">
                <div className="text-sm font-semibold text-slate-900 mb-2">Failure Hotspots</div>
                <div className="space-y-2">
                  {summary.failureHotspots.length === 0 &&
                  <div className="text-sm text-slate-500">No repeated failures in this window.</div>
                  }
                  {summary.failureHotspots.map((item) =>
                  <div key={item.key} className="px-3 py-2 rounded-lg border">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-medium text-slate-900">{item.integration}</div>
                        <Badge variant="destructive">{item.count} failures</Badge>
                      </div>
                      <div className="text-xs text-slate-500 mt-1 break-words">{item.error}</div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pt-3 pr-6 pb-1 pl-6 flex flex-col space-y-1.5">
            <CardTitle>Credit Alert Settings</CardTitle>
            <CardDescription>Send an in-app message to Robert T when usage spikes within a short window.</CardDescription>
          </CardHeader>
          <CardContent className="px-3 py-3 space-y-2">
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label className="text-sm font-medium">Enable monitoring</Label>
                <p className="text-xs text-slate-500">Runs on a schedule and checks recent estimated credit usage.</p>
              </div>
              <Switch
                checked={settings.enabled}
                onCheckedChange={(checked) => setSettings((prev) => ({ ...prev, enabled: checked }))} />
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="recipient_name">Alert recipient</Label>
                <Input
                  id="recipient_name"
                  value={settings.recipient_name}
                  onChange={(e) => setSettings((prev) => ({ ...prev, recipient_name: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="threshold_credits">Credits threshold</Label>
                <Input
                  id="threshold_credits"
                  type="number"
                  min="1"
                  value={settings.threshold_credits}
                  onChange={(e) => setSettings((prev) => ({ ...prev, threshold_credits: Number(e.target.value || 0) }))} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="window_minutes">Window minutes</Label>
                <Input
                  id="window_minutes"
                  type="number"
                  min="1"
                  value={settings.window_minutes}
                  onChange={(e) => setSettings((prev) => ({ ...prev, window_minutes: Number(e.target.value || 0) }))} />
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

      <Card className="rounded-xl border bg-card text-card-foreground shadow min-h-0 flex-1 overflow-hidden flex flex-col">
        <CardHeader className="px-6 py-3 flex flex-col space-y-1.5">
          <CardTitle>Recent Integration Usage</CardTitle>
          <CardDescription>Latest wrapped integration calls with user, task, duration, and estimated credits.</CardDescription>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 overflow-hidden">
          <div className="h-full min-h-0 overflow-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-slate-50 text-left">
                <tr>
                  <th className="p-3 font-semibold">When</th>
                  <th className="p-3 font-semibold">User</th>
                  <th className="p-3 font-semibold">Task</th>
                  <th className="p-3 font-semibold">Integration</th>
                  <th className="p-3 font-semibold">Credits</th>
                  <th className="p-3 font-semibold">Duration</th>
                  <th className="p-3 font-semibold">Status</th>
                  <th className="p-3 font-semibold">Error</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.length === 0 &&
                <tr>
                    <td colSpan={8} className="p-6 text-center text-slate-500">No integration usage has been logged yet.</td>
                  </tr>
                }
                {filteredLogs.map((log) =>
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
                    <td className="p-3 text-slate-600 max-w-[280px] truncate" title={log.error_message || ''}>
                      {log.error_message || '—'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>);

}