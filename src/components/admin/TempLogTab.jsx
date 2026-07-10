import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { offlineDB } from '@/components/utils/offlineDatabase';
import { clearAllTempLogs } from '@/functions/clearAllTempLogs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Loader2, RefreshCw, Thermometer, ChevronRight, ChevronDown, Trash2, AlertTriangle, AlertCircle, Wifi, WifiOff, Pencil, CheckSquare } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceArea, ReferenceLine, ResponsiveContainer, Legend } from 'recharts';
import { format } from 'date-fns';
import { isAppOwner } from '@/components/utils/userRoles';
import { Checkbox } from '@/components/ui/checkbox';
import { Slider } from '@/components/ui/slider';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

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

  // ── Reading selection + edit state ───────────────────────────────────────
  // selectedReadings: Map<logId, Set<readingIdx>>
  const [selectedReadings, setSelectedReadings] = useState(new Map());
  const [editDialog, setEditDialog] = useState(null); // { logId, readingIdx, currentTemp }
  const [editTempValue, setEditTempValue] = useState('');
  const [adjustDialog, setAdjustDialog] = useState(null); // { logId, indices }
  const [adjustDelta, setAdjustDelta] = useState(0);
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  const totalSelectedReadings = useMemo(() => {
    let count = 0;
    selectedReadings.forEach((set) => { count += set.size; });
    return count;
  }, [selectedReadings]);

  const toggleReadingSelection = (logId, idx) => {
    setSelectedReadings((prev) => {
      const next = new Map(prev);
      const set = new Set(next.get(logId) || []);
      set.has(idx) ? set.delete(idx) : set.add(idx);
      if (set.size === 0) next.delete(logId); else next.set(logId, set);
      return next;
    });
  };

  const clearAllSelections = () => setSelectedReadings(new Map());

  const handleOpenEditDialog = (logId, idx, temp) => {
    setEditDialog({ logId, readingIdx: idx, currentTemp: temp });
    setEditTempValue(temp?.toFixed(1) ?? '');
  };

  const handleSaveEdit = async () => {
    if (!editDialog) return;
    const newTemp = parseFloat(editTempValue);
    if (Number.isNaN(newTemp)) return;
    setIsSavingEdit(true);
    const { logId, readingIdx } = editDialog;
    const log = logs.find((l) => l.id === logId);
    if (log) {
      const newReadings = (log.temperature_readings || []).map((r, i) =>
        i === readingIdx ? { ...r, temperature_celsius: newTemp } : r
      );
      const updatedLatest = newReadings.length ? newReadings[newReadings.length - 1] : null;
      const updated = { ...log, temperature_readings: newReadings, latest_reading: updatedLatest };
      try {
        await base44.entities.RxTempLogs.update(logId, { temperature_readings: newReadings, latest_reading: updatedLatest });
      } catch (_) {}
      try { await offlineDB.save(offlineDB.STORES.RX_TEMP_LOGS, updated); } catch (_) {}
      setLogs((prev) => prev.map((l) => l.id === logId ? updated : l));
    }
    setIsSavingEdit(false);
    setEditDialog(null);
  };

  const handleOpenAdjustDialog = (logId) => {
    const set = selectedReadings.get(logId);
    if (!set || set.size === 0) return;
    setAdjustDelta(0);
    setAdjustDialog({ logId, indices: Array.from(set) });
  };

  const handleSaveAdjust = async () => {
    if (!adjustDialog) return;
    setIsSavingEdit(true);
    const { logId, indices } = adjustDialog;
    const idxSet = new Set(indices);
    const log = logs.find((l) => l.id === logId);
    if (log) {
      const newReadings = (log.temperature_readings || []).map((r, i) =>
        idxSet.has(i) ? { ...r, temperature_celsius: parseFloat((r.temperature_celsius + adjustDelta).toFixed(1)) } : r
      );
      const updatedLatest = newReadings.length ? newReadings[newReadings.length - 1] : null;
      const updated = { ...log, temperature_readings: newReadings, latest_reading: updatedLatest };
      try {
        await base44.entities.RxTempLogs.update(logId, { temperature_readings: newReadings, latest_reading: updatedLatest });
      } catch (_) {}
      try { await offlineDB.save(offlineDB.STORES.RX_TEMP_LOGS, updated); } catch (_) {}
      setLogs((prev) => prev.map((l) => l.id === logId ? updated : l));
    }
    setIsSavingEdit(false);
    setAdjustDialog(null);
    // Clear selections for this log
    setSelectedReadings((prev) => { const next = new Map(prev); next.delete(logId); return next; });
  };

  // Dates that actually have temp log records
  const [datesWithLogs, setDatesWithLogs] = useState(new Set([format(new Date(), 'yyyy-MM-dd')]));

  useEffect(() => {
    const loadDates = async () => {
      try {
        // Always check offline DB first (fast)
        const cached = await offlineDB.getAll(offlineDB.STORES.RX_TEMP_LOGS);
        const offlineDates = new Set((cached || []).map((r) => r?.delivery_date).filter(Boolean));

        if (dataSource === 'online') {
          // Fetch distinct dates from online DB — list all records but only grab delivery_date
          try {
            const online = await base44.entities.RxTempLogs.list('-delivery_date', 500);
            (online || []).forEach((r) => { if (r?.delivery_date) offlineDates.add(r.delivery_date); });
          } catch (_) {}
        }

        // Always include today so the picker isn't empty on first load
        offlineDates.add(format(new Date(), 'yyyy-MM-dd'));
        setDatesWithLogs(offlineDates);
      } catch (_) {
        setDatesWithLogs(new Set([format(new Date(), 'yyyy-MM-dd')]));
      }
    };
    loadDates();
  }, [dataSource]);

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

  // ── Chart dot drag-to-adjust state (declared early — used by chartData useMemo below) ──
  const [dragState, setDragState] = useState(null);
  const [dragPreviewLogs, setDragPreviewLogs] = useState(null);
  const chartContainerRef = useRef(null);

  // Effective logs to render (use drag preview when dragging)
  const displayLogs = dragPreviewLogs || logs;

  // Build chart data — one series per driver, X-axis = time
  const { chartData, series } = React.useMemo(() => {
    if (!displayLogs.length) return { chartData: [], series: [] };

    const driverIds = [...new Set(displayLogs.map((l) => l.driver_id))];

    // Collect all timestamps across drivers
    const allPoints = new Map(); // timestamp string → { time, ...driverTemps }

    displayLogs.forEach((log) => {
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

  // Available dates — only dates that have temp log records, sorted newest first
  const availableDates = React.useMemo(() => {
    return [...datesWithLogs].sort((a, b) => b.localeCompare(a));
  }, [datesWithLogs]);

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

  // Delete readings outside the route boundaries for a log
  const deleteReadingsOutsideRoute = useCallback(async (logId) => {
    const key = `outsideRoute-${logId}`;
    setDeleting(key);
    const log = logs.find((l) => l.id === logId);
    if (!log) { setDeleting(null); setConfirmDelete(null); return; }
    const bounds = routeBoundaries[log.driver_id];
    if (!bounds) { setDeleting(null); setConfirmDelete(null); return; }
    const newReadings = (log.temperature_readings || []).filter((r) => {
      if (!r.timestamp) return false;
      const hhmm = String(r.timestamp).replace('Z', '').slice(11, 16);
      return hhmm >= bounds.first && hhmm <= bounds.last;
    });
    const updatedLatest = newReadings.length ? newReadings[newReadings.length - 1] : null;
    const updated = { ...log, temperature_readings: newReadings, latest_reading: updatedLatest };
    try { await base44.entities.RxTempLogs.update(logId, { temperature_readings: newReadings, latest_reading: updatedLatest }); } catch (_) {}
    try { await offlineDB.save(offlineDB.STORES.RX_TEMP_LOGS, updated); } catch (_) {}
    setLogs((prev) => prev.map((l) => l.id === logId ? updated : l));
    setDeleting(null);
    setConfirmDelete(null);
  }, [logs, routeBoundaries]);

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

  // ── Time range slider state (per-log, shown above chart when a row is expanded) ──
  // timeRange: [minIdx, maxIdx] indices into the sorted unique timestamps array for selectedLogId
  const [timeRange, setTimeRange] = useState(null); // null = not initialized

  // All sorted unique HH:MM timestamps for the currently-expanded log
  const expandedLogTimestamps = useMemo(() => {
    if (!selectedLogId) return [];
    const log = displayLogs.find((l) => l.id === selectedLogId);
    if (!log) return [];
    const readings = (log.temperature_readings || []).filter((r) => r.timestamp && r.temperature_celsius != null);
    const times = [...new Set(readings.map((r) => r.timestamp.slice(0, 16)))].sort();
    return times;
  }, [selectedLogId, logs]);

  // When a row is expanded (selectedLogId changes), auto-initialize the time range
  // to the first and last reading. routeBoundaries drive the default selection.
  useEffect(() => {
    if (!selectedLogId || expandedLogTimestamps.length === 0) {
      setTimeRange(null);
      return;
    }
    const log = logs.find((l) => l.id === selectedLogId);
    if (!log) { setTimeRange(null); return; }

    const bounds = routeBoundaries[log.driver_id];
    if (bounds) {
      // Find nearest index to route start/end
      const toMin = (hhmm) => {
        const [h, m] = hhmm.split(':').map(Number);
        return h * 60 + m;
      };
      const startMin = toMin(bounds.first);
      const endMin = toMin(bounds.last);
      let minIdx = 0, maxIdx = expandedLogTimestamps.length - 1;
      expandedLogTimestamps.forEach((ts, i) => {
        const hhmm = ts.slice(11, 16);
        const m = toMin(hhmm);
        if (m <= startMin) minIdx = i;
        if (m <= endMin) maxIdx = i;
      });
      setTimeRange([minIdx, maxIdx]);
    } else {
      setTimeRange([0, expandedLogTimestamps.length - 1]);
    }
  }, [selectedLogId, expandedLogTimestamps]); // eslint-disable-line react-hooks/exhaustive-deps

  // When slider range changes while a log is expanded, auto-select all readings in range
  useEffect(() => {
    if (!selectedLogId || !timeRange || expandedLogTimestamps.length === 0) return;
    const minLabel = expandedLogTimestamps[timeRange[0]]?.slice(11, 16) ?? '00:00';
    const maxLabel = expandedLogTimestamps[timeRange[1]]?.slice(11, 16) ?? '23:59';
    const log = logs.find((l) => l.id === selectedLogId);
    if (!log) return;
    const allReadings = (log.temperature_readings || []).filter((r) => r.temperature_celsius != null);
    const inRange = new Set(
      allReadings.reduce((acc, r, i) => {
        const hhmm = r.timestamp?.slice(11, 16) ?? '';
        if (hhmm >= minLabel && hhmm <= maxLabel) acc.push(i);
        return acc;
      }, [])
    );
    setSelectedReadings((prev) => {
      const next = new Map(prev);
      next.set(selectedLogId, inRange);
      return next;
    });
  }, [timeRange]); // eslint-disable-line react-hooks/exhaustive-deps

  // Filtered chart data based on the time range slider (only when a row is expanded)
  const filteredChartData = useMemo(() => {
    if (!selectedLogId || !timeRange || expandedLogTimestamps.length === 0) return chartData;
    const [minIdx, maxIdx] = timeRange;
    const minTs = expandedLogTimestamps[minIdx]?.slice(11, 16) ?? '00:00';
    const maxTs = expandedLogTimestamps[maxIdx]?.slice(11, 16) ?? '23:59';
    return chartData.filter((p) => p.label >= minTs && p.label <= maxTs);
  }, [chartData, selectedLogId, timeRange, expandedLogTimestamps]);

  // When a dot drag ends, persist the preview temps to real logs state + DB
  const commitDrag = useCallback(async (finalLogs) => {
    if (!finalLogs || !dragState) return;
    const { logId } = dragState;
    const updatedLog = finalLogs.find((l) => l.id === logId);
    if (!updatedLog) return;
    const newReadings = updatedLog.temperature_readings;
    const updatedLatest = newReadings.length ? newReadings[newReadings.length - 1] : null;
    const payload = { temperature_readings: newReadings, latest_reading: updatedLatest };
    try { await base44.entities.RxTempLogs.update(logId, payload); } catch (_) {}
    try { await offlineDB.save(offlineDB.STORES.RX_TEMP_LOGS, updatedLog); } catch (_) {}
    setLogs(finalLogs);
    setDragPreviewLogs(null);
    setDragState(null);
  }, [dragState]);

  // Build the sinusoidal ripple: given sorted readings array, a centre index, and a delta,
  // return new readings with adjusted temperatures.
  // Influence radius grows proportionally to |delta| (max 1/3 of total range width).
  // Points outside the slider range (when active) are NOT touched.
  const applySineRipple = useCallback((readings, centreIdx, delta, sliderMinLabel, sliderMaxLabel) => {
    const n = readings.length;
    if (n === 0) return readings;
    // Radius: 1 point per 0.5°C of delta, capped at n/3
    const radius = Math.min(Math.ceil(Math.abs(delta) * 2), Math.floor(n / 3), 20);
    return readings.map((r, i) => {
      // Skip points outside slider range if slider is active
      if (sliderMinLabel && sliderMaxLabel && r.timestamp) {
        const hhmm = r.timestamp.slice(11, 16);
        if (hhmm < sliderMinLabel || hhmm > sliderMaxLabel) return r;
      }
      const dist = Math.abs(i - centreIdx);
      if (dist > radius) return r;
      // Sine envelope: 1 at centre, 0 at radius edge
      const envelope = Math.cos((dist / (radius + 1)) * (Math.PI / 2));
      const adjustment = parseFloat((delta * envelope).toFixed(1));
      return { ...r, temperature_celsius: parseFloat((r.temperature_celsius + adjustment).toFixed(1)) };
    });
  }, []);

  const handleDotMouseDown = useCallback((driverId, pointLabel, e) => {
    e?.stopPropagation?.();
    e?.preventDefault?.();
    if (!selectedLogId) return;
    const log = logs.find((l) => l.id === selectedLogId && l.driver_id === driverId);
    if (!log) return;

    // Determine the slider range labels (if active)
    let sliderMinLabel = null, sliderMaxLabel = null;
    if (timeRange && expandedLogTimestamps.length > 1) {
      sliderMinLabel = expandedLogTimestamps[timeRange[0]]?.slice(11, 16) ?? null;
      sliderMaxLabel = expandedLogTimestamps[timeRange[1]]?.slice(11, 16) ?? null;
    }

    // Find all readings that match this time label
    const readings = log.temperature_readings || [];
    const readingIndices = readings.reduce((acc, r, i) => {
      if (r.timestamp?.slice(11, 16) === pointLabel) acc.push(i);
      return acc;
    }, []);
    if (readingIndices.length === 0) return;

    const origTemps = readings.map((r) => r.temperature_celsius);

    // Capture Y-axis scale from the chart container so we can map clientY → °C
    // Chart height=300, margin top=8, bottom=8 → plot area height = 284px
    const CHART_HEIGHT = 300;
    const MARGIN_TOP = 8;
    const MARGIN_BOTTOM = 8;
    const plotHeight = CHART_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;

    // Compute Y-axis domain (same logic as the YAxis domain prop)
    const vals = series.flatMap((id) => (filteredChartData || chartData).map((p) => p[id]).filter((v) => v != null));
    const dataMax = vals.length ? Math.max(...vals) : 10;
    const yMax = dataMax <= 10 ? 10 : Math.ceil(dataMax / 5) * 5;
    const yMin = -5;

    // Chart container rect — used to compute relative Y
    const containerRect = chartContainerRef.current?.getBoundingClientRect() ?? null;

    setDragState({ logId: log.id, driverId, pointLabel, readingIndices, origTemps, sliderMinLabel, sliderMaxLabel, containerRect, plotHeight, yMin, yMax, MARGIN_TOP });
  }, [selectedLogId, logs, timeRange, expandedLogTimestamps, series, filteredChartData, chartData]);

  // Global mouse/touch move while dragging
  useEffect(() => {
    if (!dragState) return;
    const { logId, readingIndices, origTemps, sliderMinLabel, sliderMaxLabel, containerRect, plotHeight, yMin, yMax, MARGIN_TOP } = dragState;

    // Convert clientY to temperature value using the chart's Y scale
    const clientYToTemp = (clientY) => {
      if (!containerRect) return null;
      const relY = clientY - containerRect.top - MARGIN_TOP;
      const fraction = Math.max(0, Math.min(1, relY / plotHeight));
      // Y axis: top = yMax, bottom = yMin
      const temp = parseFloat((yMax - fraction * (yMax - yMin)).toFixed(1));
      return temp;
    };

    const onMove = (e) => {
      const clientY = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
      const newTemp = clientYToTemp(clientY);
      if (newTemp === null) return;
      const log = logs.find((l) => l.id === logId);
      if (!log) return;

      const centreIdx = readingIndices[0];
      const origTemp = origTemps[centreIdx] ?? 0;
      const delta = parseFloat((newTemp - origTemp).toFixed(1));

      const restored = (log.temperature_readings || []).map((r, i) => ({
        ...r,
        temperature_celsius: origTemps[i] ?? r.temperature_celsius,
      }));
      const adjusted = applySineRipple(restored, centreIdx, delta, sliderMinLabel, sliderMaxLabel);
      setDragPreviewLogs((prev) => {
        const base = prev || logs;
        return base.map((l) => l.id === logId ? { ...l, temperature_readings: adjusted } : l);
      });
    };

    const onUp = (e) => {
      const clientY = e.clientY ?? e.changedTouches?.[0]?.clientY ?? 0;
      const newTemp = clientYToTemp(clientY);
      const log = logs.find((l) => l.id === logId);
      if (!log || newTemp === null) { setDragState(null); setDragPreviewLogs(null); return; }
      const centreIdx = readingIndices[0];
      const origTemp = origTemps[centreIdx] ?? 0;
      const delta = parseFloat((newTemp - origTemp).toFixed(1));
      const restored = (log.temperature_readings || []).map((r, i) => ({
        ...r,
        temperature_celsius: origTemps[i] ?? r.temperature_celsius,
      }));
      const adjusted = applySineRipple(restored, centreIdx, delta, sliderMinLabel, sliderMaxLabel);
      const finalLogs = (dragPreviewLogs || logs).map((l) => l.id === logId ? { ...l, temperature_readings: adjusted } : l);
      commitDrag(finalLogs);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    };
  }, [dragState, logs, dragPreviewLogs, applySineRipple, commitDrag]);

  // ── Pinch-to-zoom state for the chart ───────────────────────────────────
  const [chartZoom, setChartZoom] = useState(1);
  const [chartOffset, setChartOffset] = useState(0); // horizontal pan offset as fraction 0..1
  const pinchRef = useRef({ active: false, initDist: 0, initZoom: 1 });

  const handleChartTouchStart = useCallback((e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      pinchRef.current = { active: true, initDist: Math.hypot(dx, dy), initZoom: chartZoom };
    }
  }, [chartZoom]);

  const handleChartTouchMove = useCallback((e) => {
    if (!pinchRef.current.active || e.touches.length !== 2) return;
    e.preventDefault();
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const dist = Math.hypot(dx, dy);
    const newZoom = Math.min(5, Math.max(1, pinchRef.current.initZoom * (dist / pinchRef.current.initDist)));
    setChartZoom(newZoom);
  }, []);

  const handleChartTouchEnd = useCallback(() => {
    pinchRef.current.active = false;
    if (chartZoom <= 1.05) { setChartZoom(1); setChartOffset(0); }
  }, [chartZoom]);

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
    <div className="flex flex-col gap-4 p-1 h-full min-h-0">
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

          {/* Time range slider — shown when a driver row is expanded */}
          {false && selectedLogId && timeRange && expandedLogTimestamps.length > 1 && (() => {
            const [minIdx, maxIdx] = timeRange;
            const minLabel = expandedLogTimestamps[minIdx]?.slice(11, 16) ?? '';
            const maxLabel = expandedLogTimestamps[maxIdx]?.slice(11, 16) ?? '';
            const driverLog = logs.find((l) => l.id === selectedLogId);
            const driverName = driverLog ? getDriverName(driverLog.driver_id) : '';
            return (
              <div className="mb-4 px-1 py-3 rounded-lg bg-slate-50 border border-slate-200">
                <div className="flex items-center justify-between mb-2 px-1">
                  <span className="text-xs font-semibold text-slate-600">Time Range — {driverName}</span>
                  <span className="text-xs font-mono text-slate-500">{minLabel} → {maxLabel}</span>
                </div>
                <div className="px-2">
                  <Slider
                    min={0}
                    max={expandedLogTimestamps.length - 1}
                    step={1}
                    value={timeRange}
                    onValueChange={(val) => setTimeRange(val)}
                    className="w-full"
                  />
                  <div className="flex justify-between text-xs text-slate-400 mt-1.5">
                    <span>{expandedLogTimestamps[0]?.slice(11, 16)}</span>
                    <span className="text-slate-400 text-center">Drag a point on the chart ↕ to adjust</span>
                    <span>{expandedLogTimestamps[expandedLogTimestamps.length - 1]?.slice(11, 16)}</span>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Pinch-to-zoom wrapper */}
          <div
            ref={chartContainerRef}
            style={{ overflow: 'hidden', touchAction: dragState ? 'none' : 'none', cursor: dragState ? 'ns-resize' : chartZoom > 1 ? 'grab' : 'default' }}
            onTouchStart={handleChartTouchStart}
            onTouchMove={handleChartTouchMove}
            onTouchEnd={handleChartTouchEnd}
          >
          <div style={{ transform: `scaleX(${chartZoom})`, transformOrigin: 'left center', width: `${100 / chartZoom}%`, transition: pinchRef.current.active ? 'none' : 'transform 0.2s ease' }}>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={filteredChartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis
              tick={{ fontSize: 11 }}
              domain={[-5, (dataMax) => dataMax <= 10 ? 10 : Math.ceil(dataMax / 5) * 5]}
              ticks={(() => {
                // Find actual data max from chart data
                const vals = series.flatMap((id) => filteredChartData.map((p) => p[id]).filter((v) => v != null));
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
              if (!bounds || !filteredChartData.length) return [];
              const labels = filteredChartData.map((p) => p.label);
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
              const isDraggableDriver = selectedLogId && displayLogs.find((l) => l.id === selectedLogId && l.driver_id === driverId);
              const renderActiveDot = (props) => {
                const { cx, cy, payload } = props;
                return (
                  <circle
                    key={`adot-${driverId}-${payload?.label}`}
                    cx={cx} cy={cy} r={7}
                    fill={color}
                    stroke="#fff"
                    strokeWidth={2}
                    style={{ cursor: isDraggableDriver ? 'ns-resize' : 'default' }}
                    onMouseDown={isDraggableDriver ? (e) => handleDotMouseDown(driverId, payload?.label, e) : undefined}
                    onTouchStart={isDraggableDriver ? (e) => handleDotMouseDown(driverId, payload?.label, e.touches[0]) : undefined}
                  />
                );
              };
              return (
                <Line
                  key={driverId}
                  type="monotone"
                  dataKey={driverId}
                  stroke={color}
                  strokeWidth={2}
                  dot={renderDot}
                  activeDot={renderActiveDot}
                  connectNulls={false} />);


            })}
            </LineChart>
          </ResponsiveContainer>
          </div>{/* end zoom scaler */}
          </div>{/* end pinch wrapper */}
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
      <div className="rounded-xl border border-slate-200 bg-white flex flex-col flex-1 min-h-0 overflow-hidden">
          <div className="flex-1 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200 sticky top-0 z-10">
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
              {displayLogs.map((log) => {
              const allReadings = (log.temperature_readings || []).filter((r) => r.temperature_celsius != null);
              if (!allReadings.length) return null;

              const bounds = routeBoundaries[log.driver_id];
              const routeReadings = bounds ?
              allReadings.filter((r) => {
                if (!r.timestamp) return false;
                const hhmm = String(r.timestamp).replace('Z', '').slice(11, 16);
                return hhmm >= bounds.first && hhmm <= bounds.last;
              }) : [];

              const tempsAll = allReadings.map((r) => r.temperature_celsius);
              const tempsRoute = routeReadings.map((r) => r.temperature_celsius);
              const temps = tempsRoute.length ? tempsRoute : tempsAll;
              const min = Math.min(...temps);
              const max = Math.max(...temps);
              const avg = temps.reduce((a, b) => a + b, 0) / temps.length;
              const latest = log.latest_reading?.temperature_celsius ?? tempsAll[tempsAll.length - 1];
              const outOfRange = min < fridgeCfg.safe_min || max > fridgeCfg.safe_max;
              const isExpanded = selectedLogId === log.id;
              const logSelectedSet = selectedReadings.get(log.id) || new Set();
              const logSelectedCount = logSelectedSet.size;

              // Compute slider-filtered readings for this log when expanded + slider active
              const isThisLogExpanded = isExpanded && selectedLogId === log.id;
              const sliderActive = isThisLogExpanded && timeRange && expandedLogTimestamps.length > 1;
              const sliderMinLabel = sliderActive ? (expandedLogTimestamps[timeRange[0]]?.slice(11, 16) ?? null) : null;
              const sliderMaxLabel = sliderActive ? (expandedLogTimestamps[timeRange[1]]?.slice(11, 16) ?? null) : null;
              // Indices (into allReadings) that fall within the slider range
              const sliderFilteredIndices = sliderActive
                ? allReadings.reduce((acc, r, i) => {
                    const hhmm = r.timestamp?.slice(11, 16) ?? '';
                    if (hhmm >= sliderMinLabel && hhmm <= sliderMaxLabel) acc.push(i);
                    return acc;
                  }, [])
                : null;

              return (
                <React.Fragment key={log.id}>
                    <tr
                    onClick={() => {
                     const expanding = !isExpanded;
                     setSelectedLogId(expanding ? log.id : null);
                     if (!expanding) {
                       setSelectedReadings((prev) => { const next = new Map(prev); next.delete(log.id); return next; });
                     } else {
                       // Auto-select all readings when expanding (slider will refine if active)
                       setSelectedReadings((prev) => {
                         const next = new Map(prev);
                         next.set(log.id, new Set(allReadings.map((_, i) => i)));
                         return next;
                       });
                     }
                    }}
                    className={`border-b border-slate-100 last:border-0 cursor-pointer transition-colors ${isExpanded ? 'bg-slate-100' : 'hover:bg-slate-50'}`}>
                      <td className="px-4 py-2 font-medium text-slate-800">
                        <div className="flex items-center gap-1.5">
                          {isExpanded ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
                          {getDriverName(log.driver_id)}
                        </div>
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
                        <span className="inline-flex items-center gap-1 text-xs font-semibold text-green-700 bg-green-50 px-2 py-0.5 rounded-full">✓ OK</span>}
                      </td>
                    </tr>
                    {isExpanded &&
                  <tr className="bg-slate-50 border-b border-slate-200">
                        <td colSpan={7} className="px-4 py-3">
                          {/* Header: count + actions */}
                          <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-semibold text-slate-600">{allReadings.length} reading{allReadings.length !== 1 ? 's' : ''} — {getDriverName(log.driver_id)}</span>
                              {logSelectedCount > 0 && (
                                <span className="text-xs text-blue-600 font-medium">{logSelectedCount} selected</span>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              {logSelectedCount > 1 && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleOpenAdjustDialog(log.id); }}
                                  className="flex items-center gap-1 text-xs px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
                                >
                                  <CheckSquare className="w-3 h-3" /> Adjust {logSelectedCount}
                                </button>
                              )}
                              {logSelectedCount > 0 && (
                                <button onClick={(e) => { e.stopPropagation(); setSelectedReadings((prev) => { const next = new Map(prev); next.delete(log.id); return next; }); }} className="text-xs text-slate-400 hover:text-slate-600 transition-colors">Clear</button>
                              )}
                              {canDelete && allReadings.length > 0 && routeBoundaries[log.driver_id] && (() => {
                                const bounds = routeBoundaries[log.driver_id];
                                const outsideCount = allReadings.filter((r) => {
                                  if (!r.timestamp) return true;
                                  const hhmm = String(r.timestamp).replace('Z', '').slice(11, 16);
                                  return hhmm < bounds.first || hhmm > bounds.last;
                                }).length;
                                if (outsideCount === 0) return null;
                                return confirmDelete?.type === 'outsideRoute' && confirmDelete?.logId === log.id ? (
                                  <div className="flex items-center gap-1.5">
                                    <span className="text-xs text-orange-600 font-medium">Remove {outsideCount} readings outside route?</span>
                                    <button onClick={() => deleteReadingsOutsideRoute(log.id)} disabled={deleting === `outsideRoute-${log.id}`} className="text-xs px-2 py-0.5 bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50">
                                      {deleting === `outsideRoute-${log.id}` ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Yes'}
                                    </button>
                                    <button onClick={() => setConfirmDelete(null)} className="text-xs px-2 py-0.5 bg-slate-200 text-slate-700 rounded hover:bg-slate-300">No</button>
                                  </div>
                                ) : (
                                  <button onClick={(e) => { e.stopPropagation(); setConfirmDelete({ type: 'outsideRoute', logId: log.id }); }} className="flex items-center gap-1 text-xs text-orange-500 hover:text-orange-700 transition-colors" title={`Remove ${outsideCount} readings outside route (${bounds.first}–${bounds.last})`}>
                                    <Trash2 className="w-3 h-3" /> Outside route ({outsideCount})
                                  </button>
                                );
                              })()}
                              {canDelete && allReadings.length > 0 && (
                                confirmDelete?.type === 'allReadings' && confirmDelete?.logId === log.id ?
                                <div className="flex items-center gap-1.5">
                                  <span className="text-xs text-red-600 font-medium">Delete all?</span>
                                  <button onClick={() => deleteAllReadingsForLog(log.id)} disabled={deleting === `allReadings-${log.id}`} className="text-xs px-2 py-0.5 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50">
                                    {deleting === `allReadings-${log.id}` ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Yes'}
                                  </button>
                                  <button onClick={() => setConfirmDelete(null)} className="text-xs px-2 py-0.5 bg-slate-200 text-slate-700 rounded hover:bg-slate-300">No</button>
                                </div> :
                                <button onClick={(e) => { e.stopPropagation(); setConfirmDelete({ type: 'allReadings', logId: log.id }); }} className="flex items-center gap-1 text-xs text-slate-400 hover:text-red-500 transition-colors">
                                  <Trash2 className="w-3 h-3" /> Delete all
                                </button>
                              )}
                            </div>
                          </div>
                          {/* Readings list */}
                          {allReadings.length === 0 ?
                          <div className="text-xs text-slate-400">No readings recorded.</div> :
                          <div className="space-y-0.5 max-h-64 overflow-y-auto">
                            {allReadings.map((r, idx) => {
                              const time = r.timestamp ? String(r.timestamp).replace('Z', '').slice(11, 16) : '??:??';
                              const temp = r.temperature_celsius;
                              const isOut = temp < fridgeCfg.safe_min || temp > fridgeCfg.safe_max;
                              const rKey = `reading-${log.id}-${idx}`;
                              const isChecked = logSelectedSet.has(idx);
                              // Dim readings outside the slider range
                              const outsideSlider = sliderFilteredIndices && !sliderFilteredIndices.includes(idx);
                              return (
                                <div key={idx} className={`flex items-center gap-2 py-1 px-1 rounded group cursor-pointer transition-colors ${isChecked ? 'bg-blue-50' : 'hover:bg-white'} ${outsideSlider ? 'opacity-30 pointer-events-none' : ''}`}
                                  onClick={(e) => { e.stopPropagation(); if (!outsideSlider) toggleReadingSelection(log.id, idx); }}
                                >
                                  <Checkbox
                                    checked={isChecked}
                                    onCheckedChange={() => toggleReadingSelection(log.id, idx)}
                                    onClick={(e) => e.stopPropagation()}
                                    className="flex-shrink-0"
                                  />
                                  <span className="text-xs font-mono text-slate-500 w-12">{time}</span>
                                  <span className={`text-xs font-mono font-semibold w-16 ${isOut ? 'text-red-600' : 'text-emerald-700'}`}>
                                    {temp != null ? `${temp.toFixed(1)}°C` : '—'}
                                  </span>
                                  {r.humidity_percent != null &&
                                    <span className="text-xs text-slate-400 w-16">{r.humidity_percent.toFixed(0)}% RH</span>
                                  }
                                  {isOut && <AlertTriangle className="w-3 h-3 text-red-500" />}
                                  <div className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
                                    <button
                                      title="Edit this reading"
                                      onClick={(e) => { e.stopPropagation(); handleOpenEditDialog(log.id, idx, temp); }}
                                      className="p-1 rounded hover:bg-blue-100 text-blue-500 transition-colors"
                                    >
                                      <Pencil className="w-3 h-3" />
                                    </button>
                                    {canDelete && (
                                      confirmDelete?.type === 'reading' && confirmDelete?.logId === log.id && confirmDelete?.readingIdx === idx ?
                                      <div className="flex items-center gap-1">
                                        <span className="text-xs text-red-600">Delete?</span>
                                        <button onClick={(e) => { e.stopPropagation(); deleteReading(log.id, idx); }} disabled={deleting === rKey} className="text-xs px-1.5 py-0.5 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50">
                                          {deleting === rKey ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Yes'}
                                        </button>
                                        <button onClick={(e) => { e.stopPropagation(); setConfirmDelete(null); }} className="text-xs px-1.5 py-0.5 bg-slate-200 text-slate-700 rounded hover:bg-slate-300">No</button>
                                      </div> :
                                      <button onClick={(e) => { e.stopPropagation(); setConfirmDelete({ type: 'reading', logId: log.id, readingIdx: idx }); }} className="p-1 rounded hover:bg-red-100 text-slate-300 hover:text-red-500 transition-all">
                                        <Trash2 className="w-3 h-3" />
                                      </button>
                                    )}
                                  </div>
                                </div>
                              );
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
        </div>
      }

      {/* Single reading edit dialog */}
      <Dialog open={!!editDialog} onOpenChange={(open) => { if (!open) setEditDialog(null); }}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>Edit Temperature Reading</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-3">
            <div className="text-xs text-slate-500">
              Current value: <span className="font-mono font-semibold text-slate-700">{editDialog?.currentTemp?.toFixed(1)}°C</span>
            </div>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                step="0.1"
                value={editTempValue}
                onChange={(e) => setEditTempValue(e.target.value)}
                className="font-mono text-center"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') handleSaveEdit(); }}
              />
              <span className="text-sm text-slate-500 flex-shrink-0">°C</span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEditDialog(null)}>Cancel</Button>
            <Button size="sm" onClick={handleSaveEdit} disabled={isSavingEdit}>
              {isSavingEdit ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Multi-reading range adjust dialog */}
      <Dialog open={!!adjustDialog} onOpenChange={(open) => { if (!open) { setAdjustDialog(null); setAdjustDelta(0); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Adjust {adjustDialog?.indices?.length} Readings</DialogTitle>
          </DialogHeader>
          <div className="py-4 space-y-5">
            <div className="text-xs text-slate-500 text-center">
              Slide to adjust all selected readings up or down
            </div>
            <div className="text-center text-2xl font-mono font-bold text-slate-800">
              {adjustDelta > 0 ? '+' : ''}{adjustDelta.toFixed(1)}°C
            </div>
            <div className="px-2">
              <Slider
                min={-50}
                max={50}
                step={1}
                value={[Math.round(adjustDelta * 10)]}
                onValueChange={([v]) => setAdjustDelta(parseFloat((v / 10).toFixed(1)))}
                className="w-full"
              />
              <div className="flex justify-between text-xs text-slate-400 mt-1">
                <span>-5°C</span>
                <span>0</span>
                <span>+5°C</span>
              </div>
            </div>
            <div className="text-xs text-slate-500 text-center">
              All {adjustDialog?.indices?.length} selected values will be shifted by {adjustDelta > 0 ? '+' : ''}{adjustDelta.toFixed(1)}°C
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => { setAdjustDialog(null); setAdjustDelta(0); }}>Cancel</Button>
            <Button size="sm" onClick={handleSaveAdjust} disabled={isSavingEdit || adjustDelta === 0}>
              {isSavingEdit ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Apply'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>);

}