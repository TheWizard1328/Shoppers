import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { offlineDB } from '@/components/utils/offlineDatabase';
import { clearAllTempLogs } from '@/functions/clearAllTempLogs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Loader2, RefreshCw, Thermometer, ChevronRight, ChevronDown, Trash2, AlertTriangle, AlertCircle, Wifi, WifiOff } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceArea, ReferenceLine, ResponsiveContainer, Legend } from 'recharts';
import { format } from 'date-fns';
import { isAppOwner } from '@/components/utils/userRoles';

const DEFAULT_FRIDGE_TEMP = { safe_min: 2, safe_max: 8, danger_buffer: 2 };

const DRIVER_COLORS = [
'#2563eb', '#16a34a', '#dc2626', '#d97706', '#7c3aed',
'#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5'];


export default function TempLogTab({ drivers = [], currentUser }) {
  const [fridgeCfg, setFridgeCfg] = useState(DEFAULT_FRIDGE_TEMP);

  useEffect(() => {
    base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' }).
    then((s) => {const ft = s?.[0]?.setting_value?.fridge_temp_settings;if (ft) setFridgeCfg({ ...DEFAULT_FRIDGE_TEMP, ...ft });}).
    catch(() => {});
    const onUpdate = (e) => {const ft = e.detail?.data?.setting_value?.fridge_temp_settings;if (ft) setFridgeCfg({ ...DEFAULT_FRIDGE_TEMP, ...ft });};
    window.addEventListener('appSettingsUpdated', onUpdate);
    return () => window.removeEventListener('appSettingsUpdated', onUpdate);
  }, []);

  const [selectedDate, setSelectedDate] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  const [selectedDriverId, setSelectedDriverId] = useState('all');
  const [dataSource, setDataSource] = useState('online'); // 'online' | 'offline'
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [deliveries, setDeliveries] = useState([]);

  // File-tree state
  const [treeDriverId, setTreeDriverId] = useState(null); // which driver is open in the tree
  const [expandedLogIds, setExpandedLogIds] = useState(new Set());
  const [deleting, setDeleting] = useState(null); // logId being deleted, or 'all-{driverId}'
  const [confirmDelete, setConfirmDelete] = useState(null); // { type: 'log'|'all'|'reading'|'clearAll', logId?, driverId?, readingIdx? }
  const [clearingAll, setClearingAll] = useState(false);
  const [selectedLogId, setSelectedLogId] = useState(null); // log expanded inline in summary table

  const canDelete = isAppOwner(currentUser);

  const applyFilter = useCallback((records, date, driverId) => {
    if (!records) return [];
    return records.filter((r) =>
    r?.delivery_date === date && (
    driverId === 'all' || r?.driver_id === driverId)
    );
  }, []);

  const load = useCallback(async (date, driverId, source) => {
    const src = source || dataSource;

    if (src === 'offline') {
      // Offline-only: read from IndexedDB, no API call
      setLoading(true);
      try {
        const cached = await offlineDB.getAll(offlineDB.STORES.RX_TEMP_LOGS);
        setLogs(applyFilter(cached, date, driverId));
      } catch (_) {
        setLogs([]);
      } finally {
        setLoading(false);
      }
      return;
    }

    // Online mode: read offline DB instantly, then background API fetch
    const cached = await offlineDB.getAll(offlineDB.STORES.RX_TEMP_LOGS);
    const filteredCached = applyFilter(cached, date, driverId);
    if (filteredCached.length > 0) {
      setLogs(filteredCached);
    } else {
      setLoading(true);
    }

    try {
      const filter = { delivery_date: date };
      if (driverId !== 'all') filter.driver_id = driverId;
      const data = await base44.entities.RxTempLogs.filter(filter);
      if (data?.length) {
        await offlineDB.bulkSave(offlineDB.STORES.RX_TEMP_LOGS, data);
        setLogs(data);
      } else if (!filteredCached.length) {
        setLogs([]);
      }
    } catch (_) {
      // keep whatever cached data was shown
    } finally {
      setLoading(false);
    }
  }, [applyFilter, dataSource]);

  useEffect(() => {load(selectedDate, selectedDriverId, dataSource);}, [selectedDate, selectedDriverId, dataSource, load]);

  // Load deliveries for the selected date to determine route start/end times
  useEffect(() => {
    let cancelled = false;
    const loadDeliveries = async () => {
      try {
        // Try offline DB first
        const cached = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
        const filtered = (cached || []).filter((d) => d?.delivery_date === selectedDate);
        if (!cancelled) setDeliveries(filtered);
        // Background fetch
        const fresh = await base44.entities.Delivery.filter({ delivery_date: selectedDate });
        if (!cancelled && fresh?.length) setDeliveries(fresh);
      } catch (_) {}
    };
    loadDeliveries();
    return () => {cancelled = true;};
  }, [selectedDate]);

  // Live WebSocket subscription — updates chart in real-time and handles cross-device deletes
  useEffect(() => {
    const handleWsUpdate = async (e) => {
      const { type, id, data: updated } = e.detail || {};

      // Handle delete events (from remote Clear All or individual delete)
      if (type === 'delete') {
        // Remove from offline DB
        await offlineDB.deleteRecord(offlineDB.STORES.RX_TEMP_LOGS, id).catch(() => {});
        // Remove from UI state
        setLogs((prev) => prev.filter((l) => l.id !== id));
        return;
      }

      if (!updated?.driver_id || !updated?.delivery_date) return;
      if (updated.delivery_date !== selectedDate) return;
      if (selectedDriverId !== 'all' && updated.driver_id !== selectedDriverId) return;

      // Save to offline DB
      await offlineDB.save(offlineDB.STORES.RX_TEMP_LOGS, updated).catch(() => {});

      // Merge into current logs state
      setLogs((prev) => {
        const idx = prev.findIndex((l) => l.id === updated.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = updated;
          return next;
        }
        return [...prev, updated];
      });
    };

    window.addEventListener('rxTempLogsUpdated', handleWsUpdate);
    return () => window.removeEventListener('rxTempLogsUpdated', handleWsUpdate);
  }, [selectedDate, selectedDriverId]);

  // Listen for the bulk-clear broadcast signal (set by the Clear All button after the backend call)
  useEffect(() => {
    const handleClearSignal = (e) => {
      // Clear local state immediately — the realtime WS events will clean up offline DB on all devices
      setLogs([]);
      setClearingAll(false);
      setConfirmDelete(null);
    };
    window.addEventListener('forceClearTempLogs', handleClearSignal);
    return () => window.removeEventListener('forceClearTempLogs', handleClearSignal);
  }, []);

  // Per-driver route boundaries: first and last completed/failed stop times
  const routeBoundaries = useMemo(() => {
    // Completed statuses that indicate the driver was actively delivering
    const DONE_STATUSES = new Set(['completed', 'failed']);
    const bounds = {}; // driverId → { first: 'HH:MM', last: 'HH:MM' }

    const driverIds = selectedDriverId === 'all' ?
    [...new Set(logs.map((l) => l.driver_id))] :
    [selectedDriverId];

    driverIds.forEach((driverId) => {
      const driverDeliveries = deliveries.filter((d) =>
      d?.driver_id === driverId && DONE_STATUSES.has(d.status) && d.actual_delivery_time
      );
      if (!driverDeliveries.length) return;

      // Extract HH:MM from actual_delivery_time (local ISO string)
      const times = driverDeliveries.
      map((d) => {
        const ts = String(d.actual_delivery_time).replace('Z', '').replace(/\+.*$/, '');
        return ts.slice(11, 16); // HH:MM
      }).
      filter((t) => /^\d{2}:\d{2}$/.test(t)).
      sort();

      if (times.length) {
        bounds[driverId] = { first: times[0], last: times[times.length - 1] };
      }
    });

    return bounds;
  }, [deliveries, logs, selectedDriverId]);

  // Per-driver list of fridge-carry ranges: {start, end} HH:MM
  // A range = pickup arrival_time → delivery actual_delivery_time for deliveries with fridge_item=true
  // Grouped by puid: the pickup stop (status completed, stop_order earliest) gives the start,
  // the fridge delivery stop (status completed/failed) gives the end.
  // Fallback: if no pickup found for a fridge delivery, use arrival_time → actual_delivery_time of that stop.
  const fridgeCarryRanges = useMemo(() => {
    const toHHMM = (ts) => {
      if (!ts) return null;
      const s = String(ts).replace('Z', '').replace(/\+.*$/, '').slice(11, 16);
      return /^\d{2}:\d{2}$/.test(s) ? s : null;
    };

    const map = {}; // driverId → Array<{start, end}>

    // Group fridge deliveries by driver
    const fridgeDelivs = deliveries.filter((d) => d?.fridge_item && d?.driver_id);

    // Index all pickups (is_cycling_marker = false, status completed, has arrival_time or actual_delivery_time)
    // We identify pickups by: same driver, same puid, stop with no patient_id or store-type stop
    // The simplest pairing: for each fridge delivery, find the same-puid stop with the earliest stop_order
    // that has an arrival_time (that's when the driver picked it up from the store).
    const byPuid = {}; // puid → [delivery, ...]
    deliveries.forEach((d) => {
      if (!d?.puid) return;
      if (!byPuid[d.puid]) byPuid[d.puid] = [];
      byPuid[d.puid].push(d);
    });

    fridgeDelivs.forEach((d) => {
      if (!['completed', 'failed'].includes(d.status)) return;
      const endTime = toHHMM(d.actual_delivery_time);
      if (!endTime) return;

      let startTime = null;

      // Try to find the pickup stop: same puid, earliest stop_order, has arrival_time
      if (d.puid && byPuid[d.puid]) {
        const siblings = byPuid[d.puid].
        filter((s) => s.id !== d.id && s.driver_id === d.driver_id && s.arrival_time).
        sort((a, b) => (a.stop_order ?? 999) - (b.stop_order ?? 999));
        if (siblings.length) startTime = toHHMM(siblings[0].arrival_time);
      }

      // Fallback: use this stop's own arrival_time as the start
      if (!startTime) startTime = toHHMM(d.arrival_time);
      // Last fallback: same as end (single-point)
      if (!startTime) startTime = endTime;

      if (!map[d.driver_id]) map[d.driver_id] = [];
      map[d.driver_id].push({ start: startTime, end: endTime });
    });

    return map;
  }, [deliveries]);

  // Helper: check if a HH:MM label falls within any fridge carry range for a driver
  const isInFridgeRange = useCallback((driverId, label) => {
    const ranges = fridgeCarryRanges[driverId];
    if (!ranges?.length) return false;
    return ranges.some((r) => label >= r.start && label <= r.end);
  }, [fridgeCarryRanges]);

  // Build chart data — one series per driver, X-axis = time
  const { chartData, series } = React.useMemo(() => {
    if (!logs.length) return { chartData: [], series: [] };

    const driverIds = [...new Set(logs.map((l) => l.driver_id))];

    // Collect all timestamps across drivers
    const allPoints = new Map(); // timestamp string → { time, ...driverTemps }

    logs.forEach((log) => {
      const readings = log.temperature_readings || [];
      readings.forEach((r) => {
        if (!r.timestamp || r.temperature_celsius == null) return;
        const ts = r.timestamp.slice(0, 16); // YYYY-MM-DDTHH:MM
        if (!allPoints.has(ts)) allPoints.set(ts, { time: ts });
        allPoints.get(ts)[log.driver_id] = r.temperature_celsius;
      });
    });

    const sorted = [...allPoints.values()].sort((a, b) => a.time.localeCompare(b.time));

    // Format time labels as HH:MM
    const chartData = sorted.map((p) => ({
      ...p,
      label: p.time.slice(11, 16)
    }));

    return { chartData, series: driverIds };
  }, [logs]);

  const getDriverName = (driverId) => {
    const d = drivers.find((u) => u.id === driverId || u.user_id === driverId);
    return d?.user_name || d?.full_name || driverId;
  };

  // Available dates — last 14 days
  const availableDates = React.useMemo(() => {
    const dates = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(format(d, 'yyyy-MM-dd'));
    }
    return dates;
  }, []);

  const totalReadings = logs.reduce((sum, l) => sum + (l.temperature_readings?.length || 0), 0);

  // Delete a single log record from both DBs
  const deleteLog = useCallback(async (logId) => {
    setDeleting(logId);
    try {
      await base44.entities.RxTempLogs.delete(logId);
    } catch (_) {}
    try {
      await offlineDB.delete(offlineDB.STORES.RX_TEMP_LOGS, logId);
    } catch (_) {}
    setLogs((prev) => prev.filter((l) => l.id !== logId));
    setDeleting(null);
    setConfirmDelete(null);
  }, []);

  // Delete all logs for a driver in safe batches of 10
  const deleteAllForDriver = useCallback(async (driverId) => {
    const key = `all-${driverId}`;
    setDeleting(key);
    const toDelete = logs.filter((l) => l.driver_id === driverId);
    const BATCH = 10;
    for (let i = 0; i < toDelete.length; i += BATCH) {
      const batch = toDelete.slice(i, i + BATCH);
      await Promise.all(batch.map(async (l) => {
        try {await base44.entities.RxTempLogs.delete(l.id);} catch (_) {}
        try {await offlineDB.delete(offlineDB.STORES.RX_TEMP_LOGS, l.id);} catch (_) {}
      }));
    }
    setLogs((prev) => prev.filter((l) => l.driver_id !== driverId));
    setDeleting(null);
    setConfirmDelete(null);
  }, [logs]);

  // Delete a single reading (by index) from a log record
  const deleteReading = useCallback(async (logId, readingIdx) => {
    const key = `reading-${logId}-${readingIdx}`;
    setDeleting(key);
    const log = logs.find((l) => l.id === logId);
    if (!log) {setDeleting(null);setConfirmDelete(null);return;}
    const newReadings = (log.temperature_readings || []).filter((_, i) => i !== readingIdx);
    const updated = { ...log, temperature_readings: newReadings, latest_reading: newReadings.length ? newReadings[newReadings.length - 1] : null };
    try {await base44.entities.RxTempLogs.update(logId, { temperature_readings: newReadings, latest_reading: updated.latest_reading });} catch (_) {}
    try {await offlineDB.save(offlineDB.STORES.RX_TEMP_LOGS, updated);} catch (_) {}
    setLogs((prev) => prev.map((l) => l.id === logId ? updated : l));
    setDeleting(null);
    setConfirmDelete(null);
  }, [logs]);

  // Delete all readings for a log (but keep the log record)
  const deleteAllReadingsForLog = useCallback(async (logId) => {
    const key = `allReadings-${logId}`;
    setDeleting(key);
    const updated = { temperature_readings: [], latest_reading: null };
    try {await base44.entities.RxTempLogs.update(logId, updated);} catch (_) {}
    try {const log = logs.find((l) => l.id === logId);if (log) await offlineDB.save(offlineDB.STORES.RX_TEMP_LOGS, { ...log, ...updated });} catch (_) {}
    setLogs((prev) => prev.map((l) => l.id === logId ? { ...l, ...updated } : l));
    setDeleting(null);
    setConfirmDelete(null);
  }, [logs]);

  // Clear ALL temperature logs from online DB + all connected devices
  const handleClearAll = useCallback(async () => {
    setClearingAll(true);
    try {
      // 1. Delete all from online DB via backend function (service role)
      const resp = await clearAllTempLogs();
      if (resp?.data?.error) throw new Error(resp.data.error);

      // 2. Clear local offline DB store
      await offlineDB.clearStore(offlineDB.STORES.RX_TEMP_LOGS).catch(() => {});

      // 3. Broadcast to all tabs on THIS device
      window.dispatchEvent(new CustomEvent('forceClearTempLogs'));

      // 4. The WebSocket subscription handles clearing other connected devices' offline DBs
      // When deleteMany fires, each deleted record triggers a WS 'delete' event.
      // The rxTempLogsUpdated handler above catches those and removes from state + offline DB.
    } catch (err) {
      console.error('❌ [TempLogTab] Clear all failed:', err);
    } finally {
      setClearingAll(false);
      setConfirmDelete(null);
    }
  }, []);

  // Drivers that have logs for the current date/filter
  const driversWithLogs = useMemo(() => {
    const driverIds = [...new Set(logs.map((l) => l.driver_id))];
    return driverIds.map((id) => ({ id, name: getDriverName(id) }));
  }, [logs]); // eslint-disable-line react-hooks/exhaustive-deps

  const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    return (
      <div className="bg-white border border-slate-200 rounded-lg p-2 shadow text-xs space-y-1">
        <div className="font-semibold text-slate-700">{label}</div>
        {payload.map((p, i) =>
        <div key={i} style={{ color: p.color }}>
            {getDriverName(p.dataKey)}: <span className="font-bold">{p.value?.toFixed(1)}°C</span>
          </div>
        )}
      </div>);

  };

  return (
    <div className="space-y-4 p-1">
      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <Select value={selectedDate} onValueChange={setSelectedDate}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Date" />
          </SelectTrigger>
          <SelectContent>
            {availableDates.map((d) =>
            <SelectItem key={d} value={d}>{d}</SelectItem>
            )}
          </SelectContent>
        </Select>

        <Select value={selectedDriverId} onValueChange={setSelectedDriverId}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="Driver" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Drivers</SelectItem>
            {drivers.map((d) =>
            <SelectItem key={d.id} value={d.id}>{d.user_name || d.full_name}</SelectItem>
            )}
          </SelectContent>
        </Select>

        {/* Online / Offline toggle */}
        <div className="flex items-center rounded-lg border border-slate-200 overflow-hidden text-xs font-medium">
          <button
            onClick={() => setDataSource('online')}
            className={`flex items-center gap-1.5 px-3 py-2 transition-colors ${dataSource === 'online' ? 'bg-blue-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
          >
            <Wifi className="w-3.5 h-3.5" /> Online
          </button>
          <button
            onClick={() => setDataSource('offline')}
            className={`flex items-center gap-1.5 px-3 py-2 transition-colors ${dataSource === 'offline' ? 'bg-slate-700 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
          >
            <WifiOff className="w-3.5 h-3.5" /> Offline
          </button>
        </div>

        <Button variant="outline" size="sm" onClick={() => load(selectedDate, selectedDriverId, dataSource)} disabled={loading}>
          <RefreshCw className={`w-4 h-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>

        {!loading &&
        <span className="text-xs text-slate-500 ml-1">
            {logs.length} log{logs.length !== 1 ? 's' : ''} • {totalReadings} reading{totalReadings !== 1 ? 's' : ''}
          </span>
        }

        {canDelete && logs.length > 0 && (
          confirmDelete?.type === 'clearAll' ?
          <div className="flex items-center gap-1.5 ml-auto">
            <span className="text-xs text-red-600 font-medium">Clear ALL temp logs (online + all devices)?</span>
            <button
              onClick={handleClearAll}
              disabled={clearingAll}
              className="text-xs px-2 py-0.5 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
            >
              {clearingAll ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Yes'}
            </button>
            <button
              onClick={() => setConfirmDelete(null)}
              className="text-xs px-2 py-0.5 bg-slate-200 text-slate-700 rounded hover:bg-slate-300"
            >
              No
            </button>
          </div> :
          <button
            onClick={() => setConfirmDelete({ type: 'clearAll' })}
            title="Clear all temperature logs from online DB and all devices"
            className="ml-auto flex items-center gap-1 text-xs text-red-500 hover:text-red-700 bg-red-50 hover:bg-red-100 px-2.5 py-1.5 rounded-lg transition-colors font-medium"
          >
            <AlertCircle className="w-3.5 h-3.5" />
            Clear All Logs
          </button>
        )}
      </div>

      {/* Chart */}
      {loading ?
      <div className="flex items-center justify-center h-48">
          <Loader2 className="w-6 h-6 animate-spin text-emerald-500" />
          <span className="ml-2 text-sm text-slate-500">Loading temp logs…</span>
        </div> :
      chartData.length === 0 ?
      <div className="flex flex-col items-center justify-center h-48 text-slate-400 gap-2">
          <Thermometer className="w-8 h-8 opacity-40" />
          <span className="text-sm">No temperature readings for this date / driver.</span>
        </div> :

      <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-semibold text-slate-700">Cooler Temperature — {selectedDate}</div>
            <div className="flex items-center gap-1.5 text-xs text-slate-500">
              <svg width="10" height="10"><circle cx="5" cy="5" r="5" fill="#2563eb" /></svg>
              Fridge item on board
            </div>
          </div>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis
              tick={{ fontSize: 11 }}
              domain={[-5, (dataMax) => dataMax <= 10 ? 10 : Math.ceil(dataMax / 5) * 5]}
              ticks={(() => {
                // Find actual data max from chart data
                const vals = series.flatMap((id) => chartData.map((p) => p[id]).filter((v) => v != null));
                const dataMax = vals.length ? Math.max(...vals) : 10;
                const axisMax = dataMax <= 10 ? 10 : Math.ceil(dataMax / 5) * 5;
                // Fixed ticks: -5, 0, 4, 8, then every 5 from 10 up to axisMax
                const fixed = [-5, 0, 4, 8];
                for (let t = 10; t <= axisMax; t += 5) fixed.push(t);
                return fixed;
              })()}
              tickFormatter={(v) => `${v}°C`} />
            
              <Tooltip content={<CustomTooltip />} />
              <Legend formatter={(value) => getDriverName(value)} wrapperStyle={{ fontSize: 12 }} />
              {/* Safe zone — green band */}
              <ReferenceArea y1={fridgeCfg.safe_min} y2={fridgeCfg.safe_max} fill="#16a34a" fillOpacity={0.08} />
              {/* Low danger zone — yellow band */}
              <ReferenceArea y1={fridgeCfg.safe_min - fridgeCfg.danger_buffer} y2={fridgeCfg.safe_min} fill="#eab308" fillOpacity={0.15} />
              {/* High danger zone — yellow band */}
              <ReferenceArea y1={fridgeCfg.safe_max} y2={fridgeCfg.safe_max + fridgeCfg.danger_buffer} fill="#eab308" fillOpacity={0.15} />
              {/* Route start/end vertical lines per driver */}
              {series.flatMap((driverId, i) => {
              const color = DRIVER_COLORS[i % DRIVER_COLORS.length];
              const bounds = routeBoundaries[driverId];
              if (!bounds || !chartData.length) return [];
              const labels = chartData.map((p) => p.label);
              // Find closest label index for a given HH:MM time
              const closestLabel = (target) => {
                if (!target) return null;
                let best = null,bestDiff = Infinity;
                labels.forEach((l) => {
                  const diff = Math.abs(
                    parseInt(l.split(':')[0]) * 60 + parseInt(l.split(':')[1]) - (
                    parseInt(target.split(':')[0]) * 60 + parseInt(target.split(':')[1]))
                  );
                  if (diff < bestDiff) {bestDiff = diff;best = l;}
                });
                return best;
              };
              const firstLabel = closestLabel(bounds.first);
              const lastLabel = closestLabel(bounds.last);
              const lines = [];
              if (firstLabel) lines.push(
                <ReferenceLine
                  key={`${driverId}-start`}
                  x={firstLabel}
                  stroke={color}
                  strokeDasharray="4 3"
                  strokeWidth={1.5}
                  label={{ value: `${getDriverName(driverId).split(' ')[0]} start`, position: 'insideTopRight', fontSize: 10, fill: color, dy: i * 12 }} />

              );
              if (lastLabel && lastLabel !== firstLabel) lines.push(
                <ReferenceLine
                  key={`${driverId}-end`}
                  x={lastLabel}
                  stroke={color}
                  strokeDasharray="2 4"
                  strokeWidth={1.5}
                  label={{ value: `${getDriverName(driverId).split(' ')[0]} end`, position: 'insideTopLeft', fontSize: 10, fill: color, dy: i * 12 }} />

              );
              return lines;
            })}
              {series.map((driverId, i) => {
              const color = DRIVER_COLORS[i % DRIVER_COLORS.length];
              const renderDot = (props) => {
                const { cx, cy, payload } = props;
                const hasFridge = isInFridgeRange(driverId, payload?.label);
                if (!hasFridge) return null;
                return (
                  <circle
                    key={`dot-${driverId}-${payload?.label}`}
                    cx={cx} cy={cy} r={5}
                    fill={color}
                    stroke={color}
                    strokeWidth={2} />);
              };
              return (
                <Line
                  key={driverId}
                  type="monotone"
                  dataKey={driverId}
                  stroke={color}
                  strokeWidth={2}
                  dot={renderDot}
                  activeDot={{ r: 5 }}
                  connectNulls={false} />);


            })}
            </LineChart>
          </ResponsiveContainer>
        </div>
      }

      {/* ── File-tree: Driver → date logs → individual readings ── */}
      {logs.length > 0 &&
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden hidden">
          <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-700">Temp Log Records</span>
            <Select value={treeDriverId || 'all'} onValueChange={(v) => setTreeDriverId(v === 'all' ? null : v)}>
              <SelectTrigger className="w-44 h-8 text-xs">
                <SelectValue placeholder="Filter driver" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Drivers</SelectItem>
                {driversWithLogs.map((d) =>
              <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
              )}
              </SelectContent>
            </Select>
          </div>
          <div className="divide-y divide-slate-100">
            {driversWithLogs.
          filter((d) => !treeDriverId || d.id === treeDriverId).
          map((driver) => {
            const driverLogs = logs.filter((l) => l.driver_id === driver.id);
            const isDeletingAll = deleting === `all-${driver.id}`;
            return (
              <div key={driver.id}>
                    {/* Driver row */}
                    <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50 hover:bg-slate-100 transition-colors">
                      <span className="text-sm font-semibold text-slate-800">{driver.name}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-400">{driverLogs.length} log{driverLogs.length !== 1 ? 's' : ''}</span>
                        {canDelete && (
                    confirmDelete?.type === 'all' && confirmDelete?.driverId === driver.id ?
                    <div className="flex items-center gap-1.5">
                              <span className="text-xs text-red-600 font-medium">Delete all?</span>
                              <button onClick={() => deleteAllForDriver(driver.id)} disabled={isDeletingAll} className="text-xs px-2 py-0.5 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50">
                                {isDeletingAll ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Yes'}
                              </button>
                              <button onClick={() => setConfirmDelete(null)} className="text-xs px-2 py-0.5 bg-slate-200 text-slate-700 rounded hover:bg-slate-300">No</button>
                            </div> :

                    <button onClick={() => setConfirmDelete({ type: 'all', driverId: driver.id })} title="Delete all logs for this driver" className="text-slate-400 hover:text-red-500 transition-colors">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>)

                    }
                      </div>
                    </div>
                    {/* Log rows */}
                    {driverLogs.map((log) => {
                  const readings = log.temperature_readings || [];
                  const isExpanded = expandedLogIds.has(log.id);
                  const isDeletingThis = deleting === log.id;
                  const logDate = log.delivery_date || selectedDate;
                  const readingCount = readings.length;
                  return (
                    <div key={log.id} className="border-t border-slate-100 first:border-0">
                          {/* Log header row */}
                          <div className="flex items-center gap-2 px-6 py-2 hover:bg-slate-50 transition-colors">
                            <button
                          onClick={() => setExpandedLogIds((prev) => {
                            const next = new Set(prev);
                            isExpanded ? next.delete(log.id) : next.add(log.id);
                            return next;
                          })}
                          className="flex items-center gap-1.5 flex-1 min-w-0 text-left">
                          
                              {isExpanded ? <ChevronDown className="w-4 h-4 text-slate-400 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-400 flex-shrink-0" />}
                              <Thermometer className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
                              <span className="text-xs font-medium text-slate-700">{logDate}</span>
                              <span className="text-xs text-slate-400 ml-1">• {readingCount} reading{readingCount !== 1 ? 's' : ''}</span>
                              {log.latest_reading?.temperature_celsius != null &&
                          <span className="text-xs font-mono text-slate-500 ml-1">latest: {log.latest_reading.temperature_celsius.toFixed(1)}°C</span>
                          }
                            </button>
                            {canDelete && (
                        confirmDelete?.type === 'log' && confirmDelete?.logId === log.id ?
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                                  <span className="text-xs text-red-600 font-medium">Delete?</span>
                                  <button onClick={() => deleteLog(log.id)} disabled={isDeletingThis} className="text-xs px-2 py-0.5 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50">
                                    {isDeletingThis ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Yes'}
                                  </button>
                                  <button onClick={() => setConfirmDelete(null)} className="text-xs px-2 py-0.5 bg-slate-200 text-slate-700 rounded hover:bg-slate-300">No</button>
                                </div> :

                        <button onClick={(e) => {e.stopPropagation();setConfirmDelete({ type: 'log', logId: log.id });}} title="Delete this log" className="text-slate-300 hover:text-red-500 transition-colors flex-shrink-0">
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>)

                        }
                          </div>
                          {/* Expanded readings */}
                          {isExpanded &&
                      <div className="pl-12 pr-4 pb-2 space-y-0.5">
                              {readings.length === 0 ?
                        <div className="text-xs text-slate-400 py-1">No readings recorded.</div> :
                        readings.map((r, idx) => {
                          const time = r.timestamp ? String(r.timestamp).replace('Z', '').slice(11, 16) : '??:??';
                          const temp = r.temperature_celsius;
                          const isLow = temp < fridgeCfg.safe_min;
                          const isHigh = temp > fridgeCfg.safe_max;
                          const isOut = isLow || isHigh;
                          return (
                            <div key={idx} className="flex items-center gap-3 py-0.5">
                                    <span className="text-xs font-mono text-slate-500 w-12">{time}</span>
                                    <span className={`text-xs font-mono font-semibold ${isOut ? 'text-red-600' : 'text-emerald-700'}`}>
                                      {temp != null ? `${temp.toFixed(1)}°C` : '—'}
                                    </span>
                                    {r.humidity_percent != null &&
                              <span className="text-xs text-slate-400">{r.humidity_percent.toFixed(0)}% RH</span>
                              }
                                    {isOut && <AlertTriangle className="w-3 h-3 text-red-500" />}
                                  </div>);

                        })}
                            </div>
                      }
                        </div>);

                })}
                  </div>);

          })}
          </div>
        </div>
      }

      {/* Per-driver summary table */}
      {logs.length > 0 &&
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-4 py-2 text-left font-semibold text-slate-600">Driver</th>
                <th className="px-4 py-2 text-right font-semibold text-slate-600">Readings</th>
                <th className="px-4 py-2 text-right font-semibold text-slate-600">Min</th>
                <th className="px-4 py-2 text-right font-semibold text-slate-600">Max</th>
                <th className="px-4 py-2 text-right font-semibold text-slate-600">Avg</th>
                <th className="px-4 py-2 text-right font-semibold text-slate-600">Latest</th>
                <th className="px-4 py-2 text-center font-semibold text-slate-600">Status</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => {
              const allReadings = (log.temperature_readings || []).filter((r) => r.temperature_celsius != null);
              if (!allReadings.length) return null;

              // Filter to readings within route window (first → last finished stop)
              const bounds = routeBoundaries[log.driver_id];
              const routeReadings = bounds ?
              allReadings.filter((r) => {
                if (!r.timestamp) return false;
                const hhmm = String(r.timestamp).replace('Z', '').slice(11, 16);
                return hhmm >= bounds.first && hhmm <= bounds.last;
              }) :
              [];

              const tempsAll = allReadings.map((r) => r.temperature_celsius);
              const tempsRoute = routeReadings.map((r) => r.temperature_celsius);

              // Use route temps for all stats if available, fall back to all
              const temps = tempsRoute.length ? tempsRoute : tempsAll;

              const min = Math.min(...temps);
              const max = Math.max(...temps);
              const avg = temps.reduce((a, b) => a + b, 0) / temps.length;

              const latest = log.latest_reading?.temperature_celsius ?? tempsAll[tempsAll.length - 1];
              const outOfRange = min < fridgeCfg.safe_min || max > fridgeCfg.safe_max;

              const isSelected = selectedLogId === log.id;
              return (
                <React.Fragment key={log.id}>
                    <tr
                    onClick={() => setSelectedLogId(isSelected ? null : log.id)}
                    className={`border-b border-slate-100 last:border-0 cursor-pointer transition-colors ${isSelected ? 'bg-slate-100' : 'hover:bg-slate-50'}`}>
                    
                      <td className="px-4 py-2 font-medium text-slate-800 flex items-center gap-1.5">
                        {isSelected ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
                        {getDriverName(log.driver_id)}
                      </td>
                      <td className="px-4 py-2 text-right text-slate-600">
                        {bounds ? <span title="route readings / total readings">{tempsRoute.length}/{allReadings.length}</span> : allReadings.length}
                      </td>
                      <td className={`px-4 py-2 text-right font-mono ${min < fridgeCfg.safe_min ? 'text-red-600 font-bold' : 'text-slate-600'}`}>{min.toFixed(1)}°C</td>
                      <td className={`px-4 py-2 text-right font-mono ${max > fridgeCfg.safe_max ? 'text-red-600 font-bold' : 'text-slate-600'}`}>{max.toFixed(1)}°C</td>
                      <td className={`px-4 py-2 text-right font-mono font-semibold ${outOfRange ? 'text-red-600' : 'text-emerald-700'}`}>{avg.toFixed(1)}°C</td>
                      <td className="px-4 py-2 text-right font-mono text-slate-600">{latest?.toFixed(1)}°C</td>
                      <td className="px-4 py-2 text-center">
                        {outOfRange ?
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-600 bg-red-50 px-2 py-0.5 rounded-full">⚠ Out of Range</span> :
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-green-700 bg-green-50 px-2 py-0.5 rounded-full">✓ OK</span>
                      }
                      </td>
                    </tr>
                    {isSelected &&
                  <tr className="bg-slate-50 border-b border-slate-200">
                        <td colSpan={7} className="px-4 py-3">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-semibold text-slate-600">{allReadings.length} reading{allReadings.length !== 1 ? 's' : ''} — {getDriverName(log.driver_id)}</span>
                            {canDelete && allReadings.length > 0 && (
                        confirmDelete?.type === 'allReadings' && confirmDelete?.logId === log.id ?
                        <div className="flex items-center gap-1.5">
                                  <span className="text-xs text-red-600 font-medium">Delete all readings?</span>
                                  <button onClick={() => deleteAllReadingsForLog(log.id)} disabled={deleting === `allReadings-${log.id}`} className="text-xs px-2 py-0.5 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50">
                                    {deleting === `allReadings-${log.id}` ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Yes'}
                                  </button>
                                  <button onClick={() => setConfirmDelete(null)} className="text-xs px-2 py-0.5 bg-slate-200 text-slate-700 rounded hover:bg-slate-300">No</button>
                                </div> :

                        <button onClick={(e) => {e.stopPropagation();setConfirmDelete({ type: 'allReadings', logId: log.id });}} className="flex items-center gap-1 text-xs text-slate-400 hover:text-red-500 transition-colors">
                                  <Trash2 className="w-3 h-3" /> Delete all readings
                                </button>)

                        }
                          </div>
                          {allReadings.length === 0 ?
                      <div className="text-xs text-slate-400">No readings recorded.</div> :

                      <div className="space-y-0.5 max-h-60 overflow-y-auto">
                              {allReadings.map((r, idx) => {
                          const time = r.timestamp ? String(r.timestamp).replace('Z', '').slice(11, 16) : '??:??';
                          const temp = r.temperature_celsius;
                          const isOut = temp < fridgeCfg.safe_min || temp > fridgeCfg.safe_max;
                          const rKey = `reading-${log.id}-${idx}`;
                          return (
                            <div key={idx} className="flex items-center gap-3 py-0.5 group">
                                    <span className="text-xs font-mono text-slate-500 w-12">{time}</span>
                                    <span className={`text-xs font-mono font-semibold w-16 ${isOut ? 'text-red-600' : 'text-emerald-700'}`}>
                                      {temp != null ? `${temp.toFixed(1)}°C` : '—'}
                                    </span>
                                    {r.humidity_percent != null &&
                              <span className="text-xs text-slate-400 w-16">{r.humidity_percent.toFixed(0)}% RH</span>
                              }
                                    {isOut && <AlertTriangle className="w-3 h-3 text-red-500" />}
                                    {canDelete && (
                              confirmDelete?.type === 'reading' && confirmDelete?.logId === log.id && confirmDelete?.readingIdx === idx ?
                              <div className="flex items-center gap-1 ml-auto">
                                          <span className="text-xs text-red-600">Delete?</span>
                                          <button onClick={(e) => {e.stopPropagation();deleteReading(log.id, idx);}} disabled={deleting === rKey} className="text-xs px-1.5 py-0.5 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50">
                                            {deleting === rKey ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Yes'}
                                          </button>
                                          <button onClick={(e) => {e.stopPropagation();setConfirmDelete(null);}} className="text-xs px-1.5 py-0.5 bg-slate-200 text-slate-700 rounded hover:bg-slate-300">No</button>
                                        </div> :

                              <button onClick={(e) => {e.stopPropagation();setConfirmDelete({ type: 'reading', logId: log.id, readingIdx: idx });}} className="ml-auto opacity-0 group-hover:opacity-100 text-slate-300 hover:text-red-500 transition-all">
                                          <Trash2 className="w-3 h-3" />
                                        </button>)

                              }
                                  </div>);

                        })}
                            </div>
                      }
                        </td>
                      </tr>
                  }
                  </React.Fragment>);

            })}
            </tbody>
          </table>
        </div>
      }
    </div>);

}