import { useCallback, useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RefreshCw, Loader2, Download } from 'lucide-react';
import { formatCoords, buildMapUrl } from '@/components/utils/reverseGeocode';

// ─────────────────────────────────────────────────────────────────────────────
// ALERTS HISTORY (owner request Nov 14 2026)
// "I'll need a new section in admin utilities - Data named Alerts to view the
// alerts history." Reads the EmergencyAlertLog entity: every manual (5s map
// hold) and impact-detected activation, every cancelled confirmation screen,
// and every stand-down of a live alert — with the time, the GPS coords, the
// nearest address and who was notified.
// Retention is forever (owner decision Nov 14 2026), so this only pages back.
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 100;

const STATUS_STYLES = {
  sent: 'bg-red-600/15 text-red-700 dark:text-red-400 border-red-500/40',
  pending_confirmation: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/40',
  cancelled: 'bg-emerald-600/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/40',
  resolved: 'bg-slate-500/15 text-slate-700 dark:text-slate-300 border-slate-500/40'
};

const STATUS_LABELS = {
  sent: 'Sent',
  pending_confirmation: 'Pending',
  cancelled: 'Cancelled',
  resolved: 'Resolved'
};

const formatLocal = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const datePart = d.toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' });
  const timePart = d.toLocaleTimeString('en-US', {
    timeZone: 'America/Edmonton',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });
  return `${datePart} ${timePart}`;
};

export default function EmergencyAlertsTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState('all');
  const [source, setSource] = useState('all');
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async ({ skip = 0, replace = true } = {}) => {
    if (replace) setLoading(true); else setLoadingMore(true);
    setError('');
    try {
      // Sort by the PLATFORM index (created_date) — sorting on a custom field
      // does an unindexed scan and times out on large collections.
      const query = {};
      if (status !== 'all') query.status = status;
      if (source !== 'all') query.source = source;
      const page = await base44.entities.EmergencyAlertLog.filter(query, '-created_date', PAGE_SIZE, skip);
      const list = Array.isArray(page) ? page : (page?.items || []);
      setRows((prev) => (replace ? list : [...prev, ...list]));
      setHasMore(list.length === PAGE_SIZE);
    } catch (err) {
      setError(err?.message || 'Could not load the alert history.');
      if (replace) setRows([]);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [status, source]);

  useEffect(() => { load({ skip: 0, replace: true }); }, [load]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((row) => [
      row.driver_name,
      row.nearest_address,
      row.notes,
      row.cancellation_reason,
      row.device_name,
      row.cancellation_stage,
      String(row.latitude),
      String(row.longitude)
    ].some((value) => String(value || '').toLowerCase().includes(term)));
  }, [rows, search]);

  const stats = useMemo(() => {
    const counts = { total: 0, sent: 0, cancelled: 0, pending: 0, resolved: 0 };
    rows.forEach((row) => {
      counts.total += 1;
      if (row.status === 'sent') counts.sent += 1;
      else if (row.status === 'cancelled') counts.cancelled += 1;
      else if (row.status === 'resolved') counts.resolved += 1;
      else counts.pending += 1;
    });
    return counts;
  }, [rows]);

  const exportCsv = () => {
    const header = ['triggered_at', 'driver', 'source', 'status', 'stage', 'seconds_to_decision', 'nearest_address', 'latitude', 'longitude', 'recipients', 'notes', 'reason'];
    const lines = [header.join(',')];
    filtered.forEach((row) => {
      const cells = [
        row.triggered_at || '',
        row.driver_name || '',
        row.source || '',
        row.status || '',
        row.cancellation_stage || '',
        row.seconds_to_decision ?? '',
        row.nearest_address || '',
        row.latitude ?? '',
        row.longitude ?? '',
        row.recipient_count ?? '',
        (row.notes || '').replace(/\s+/g, ' '),
        (row.cancellation_reason || '').replace(/\s+/g, ' ')
      ].map((value) => `"${String(value).replace(/"/g, '""')}"`);
      lines.push(cells.join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `rxdeliver-alerts-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Emergency alert history</CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                Every manual and impact activation, each cancelled confirmation, and every stand-down. Retention: forever.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => load({ skip: 0, replace: true })} disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                <span className="ml-1.5">Refresh</span>
              </Button>
              <Button size="sm" variant="outline" onClick={exportCsv} disabled={!filtered.length}>
                <Download className="h-4 w-4" />
                <span className="ml-1.5">CSV</span>
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">Total {stats.total}</Badge>
            <Badge variant="outline" className={STATUS_STYLES.sent}>Sent {stats.sent}</Badge>
            <Badge variant="outline" className={STATUS_STYLES.cancelled}>Cancelled {stats.cancelled}</Badge>
            <Badge variant="outline" className={STATUS_STYLES.pending_confirmation}>Pending {stats.pending}</Badge>
            <Badge variant="outline" className={STATUS_STYLES.resolved}>Resolved {stats.resolved}</Badge>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search driver, address, notes, coords…"
              className="h-9 w-full sm:w-64"
            />
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="h-9 w-full sm:w-40"><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
                <SelectItem value="pending_confirmation">Pending confirmation</SelectItem>
                <SelectItem value="resolved">Resolved</SelectItem>
              </SelectContent>
            </Select>
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger className="h-9 w-full sm:w-40"><SelectValue placeholder="Source" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sources</SelectItem>
                <SelectItem value="manual">Manual (hold)</SelectItem>
                <SelectItem value="crash">Impact detected</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {error && <p className="text-xs text-red-600">{error}</p>}
        </CardContent>
      </Card>

      {loading ? (
        <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading alert history…
        </div>
      ) : filtered.length === 0 ? (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">No alerts recorded yet.</CardContent></Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((row) => {
            const coords = formatCoords(row.latitude, row.longitude, row.gps_accuracy);
            const mapUrl = row.map_url || buildMapUrl(row.latitude, row.longitude);
            return (
              <Card key={row.id || row.client_session_id}>
                <CardContent className="py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold">{row.driver_name || 'Driver'}</span>
                        <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                          {row.source === 'crash' ? 'Impact' : 'Manual'}
                        </Badge>
                        <Badge variant="outline" className={`text-[10px] ${STATUS_STYLES[row.status] || ''}`}>
                          {STATUS_LABELS[row.status] || row.status || '—'}
                        </Badge>
                        {row.cancellation_stage === 'active_alert' && (
                          <Badge variant="outline" className="text-[10px]">stood down after sending</Badge>
                        )}
                        {row.auto_send_paused && (
                          <Badge variant="outline" className="text-[10px]">auto-send paused</Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">{formatLocal(row.triggered_at)}</div>
                      <div className="text-xs mt-1">
                        {row.nearest_address ? <span className="font-medium">{row.nearest_address}</span> : <span className="text-muted-foreground">No address</span>}
                        {coords ? <span className="text-muted-foreground"> · {coords}</span> : null}
                        {mapUrl ? (
                          <a href={mapUrl} target="_blank" rel="noreferrer" className="ml-2 text-primary underline">map</a>
                        ) : null}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {row.status === 'sent' && (
                          <>
                            Sent {row.seconds_to_decision != null ? `${row.seconds_to_decision}s after trigger` : ''}
                            {row.recipient_count != null ? ` · ${row.recipient_count} device(s) notified` : ''}
                          </>
                        )}
                        {row.status === 'cancelled' && (
                          <>
                            Cancelled {row.seconds_to_decision != null ? `${row.seconds_to_decision}s after trigger` : ''}
                            {row.cancellation_reason ? ` · ${row.cancellation_reason}` : ''}
                            {row.cancellation_notified ? ' · stand-down push sent' : ''}
                          </>
                        )}
                        {row.status === 'pending_confirmation' && 'Confirmation screen open, no decision recorded'}
                        {row.status === 'resolved' && `Resolved ${formatLocal(row.resolved_at)}`}
                      </div>
                      {row.notes ? <div className="text-xs mt-1">{row.notes}</div> : null}
                      {row.peak_force != null ? (
                        <div className="text-[11px] text-muted-foreground mt-1">
                          Peak {Math.round(row.peak_force)} m/s²{row.sensitivity != null ? ` · threshold ${Math.round(row.sensitivity)}` : ''}
                          {row.device_name ? ` · ${row.device_name}` : ''}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}

          {hasMore && (
            <div className="flex justify-center pt-2">
              <Button size="sm" variant="outline" onClick={() => load({ skip: rows.length, replace: false })} disabled={loadingMore}>
                {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                <span className={loadingMore ? 'ml-1.5' : ''}>Load older</span>
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
