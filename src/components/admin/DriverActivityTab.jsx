import React, { useState, useEffect, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RefreshCw, Plus, Edit, Trash2, Loader2, Clock, User, LayoutGrid, List, BarChart2, AlertCircle } from 'lucide-react';
import { format, parseISO, differenceInMinutes } from 'date-fns';

const STATUS_COLORS = {
  on_duty: { bg: 'bg-emerald-500', light: 'bg-emerald-100', text: 'text-emerald-700', border: 'border-emerald-300', label: 'On Duty' },
  on_break: { bg: 'bg-amber-400', light: 'bg-amber-100', text: 'text-amber-700', border: 'border-amber-300', label: 'Break' },
  off_duty: { bg: 'bg-slate-400', light: 'bg-slate-100', text: 'text-slate-600', border: 'border-slate-300', label: 'Off Duty' },
};

const formatDuration = (minutes) => {
  if (!minutes || minutes <= 0) return '0m';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

const formatTime = (isoStr) => {
  if (!isoStr) return '—';
  try { return format(parseISO(isoStr), 'h:mm a'); } catch { return isoStr; }
};

const calcSegmentMinutes = (seg) => {
  if (!seg.start_time) return null;
  const start = new Date(seg.start_time);
  const end = seg.end_time ? new Date(seg.end_time) : new Date();
  return Math.max(0, differenceInMinutes(end, start));
};

const totalOnDutyMinutes = (record) => {
  if (!record?.activity_segments?.length) return 0;
  return record.activity_segments.reduce((sum, seg) => sum + (calcSegmentMinutes(seg) || 0), 0);
};

// ─── Timeline Bar View ────────────────────────────────────────────────────────
const DAY_START_HOUR = 6;
const DAY_END_HOUR = 22;
const DAY_MINUTES = (DAY_END_HOUR - DAY_START_HOUR) * 60;

const timeToPercent = (isoStr) => {
  if (!isoStr) return null;
  try {
    const d = parseISO(isoStr);
    const minutesSinceDayStart = (d.getHours() - DAY_START_HOUR) * 60 + d.getMinutes();
    return Math.max(0, Math.min(100, (minutesSinceDayStart / DAY_MINUTES) * 100));
  } catch { return null; }
};

function TimelineView({ records, driverNames, onEdit, onDelete }) {
  const hourMarkers = Array.from({ length: DAY_END_HOUR - DAY_START_HOUR + 1 }, (_, i) => DAY_START_HOUR + i);

  return (
    <div className="space-y-3">
      {/* Hour ruler */}
      <div className="relative ml-28 h-5 border-b border-slate-200">
        {hourMarkers.map((h) => (
          <span
            key={h}
            className="absolute top-0 text-[10px] text-slate-400 -translate-x-1/2"
            style={{ left: `${((h - DAY_START_HOUR) / (DAY_END_HOUR - DAY_START_HOUR)) * 100}%` }}>
            {h === 12 ? '12p' : h < 12 ? `${h}a` : `${h - 12}p`}
          </span>
        ))}
      </div>

      {records.map((record) => {
        const name = driverNames[record.driver_id] || record.driver_name || record.driver_id?.slice(-6) || '?';
        const totalMin = totalOnDutyMinutes(record);
        return (
          <div key={record.id} className="flex items-center gap-2 group">
            <div className="w-28 flex-shrink-0 text-right pr-2">
              <span className="text-xs font-medium text-slate-700 truncate block">{name}</span>
              <span className="text-[10px] text-slate-400">{formatDuration(totalMin)}</span>
            </div>
            <div className="flex-1 relative h-8 bg-slate-100 rounded overflow-hidden">
              {(record.activity_segments || []).map((seg, i) => {
                const left = timeToPercent(seg.start_time);
                const right = timeToPercent(seg.end_time || new Date().toISOString());
                if (left === null) return null;
                const width = Math.max(0.5, (right ?? 100) - left);
                return (
                  <div
                    key={i}
                    className="absolute top-1 bottom-1 bg-emerald-500 rounded-sm opacity-90"
                    style={{ left: `${left}%`, width: `${width}%` }}
                    title={`${formatTime(seg.start_time)} → ${seg.end_time ? formatTime(seg.end_time) : 'now'} (${formatDuration(calcSegmentMinutes(seg))})`}
                  />
                );
              })}
            </div>
            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => onEdit(record)}><Edit className="w-3 h-3" /></Button>
              <Button variant="ghost" size="icon" className="h-6 w-6 text-red-500 hover:text-red-700" onClick={() => onDelete(record)}><Trash2 className="w-3 h-3" /></Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Card Grid View ───────────────────────────────────────────────────────────
function CardGridView({ records, driverNames, onEdit, onDelete }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
      {records.map((record) => {
        const name = driverNames[record.driver_id] || record.driver_name || record.driver_id?.slice(-6) || '?';
        const totalMin = totalOnDutyMinutes(record);
        const segments = record.activity_segments || [];
        return (
          <Card key={record.id} className="border border-slate-200">
            <CardHeader className="pb-2 pt-3 px-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-semibold text-sm text-slate-900">{name}</p>
                  <p className="text-xs text-slate-500">{totalMin > 0 ? `Total: ${formatDuration(totalMin)}` : 'No segments'}</p>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => onEdit(record)}><Edit className="w-3 h-3" /></Button>
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-red-500" onClick={() => onDelete(record)}><Trash2 className="w-3 h-3" /></Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="px-4 pb-3 space-y-1">
              {segments.length === 0 && <p className="text-xs text-slate-400 italic">No activity recorded</p>}
              {segments.map((seg, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <div className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />
                  <span className="text-slate-600">{formatTime(seg.start_time)}</span>
                  <span className="text-slate-400">→</span>
                  <span className="text-slate-600">{seg.end_time ? formatTime(seg.end_time) : <span className="text-emerald-600 font-medium">Active</span>}</span>
                  {seg.tot != null && <span className="ml-auto text-slate-400">{formatDuration(seg.tot)}</span>}
                </div>
              ))}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// ─── Summary Table View ───────────────────────────────────────────────────────
function TableView({ records, driverNames, onEdit, onDelete }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-50 border-b border-slate-200">
            <th className="text-left px-3 py-2 font-medium text-slate-600 text-xs">Driver</th>
            <th className="text-left px-3 py-2 font-medium text-slate-600 text-xs">Segments</th>
            <th className="text-left px-3 py-2 font-medium text-slate-600 text-xs">First On</th>
            <th className="text-left px-3 py-2 font-medium text-slate-600 text-xs">Last Off</th>
            <th className="text-right px-3 py-2 font-medium text-slate-600 text-xs">Total On-Duty</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {records.map((record) => {
            const name = driverNames[record.driver_id] || record.driver_name || record.driver_id?.slice(-6) || '?';
            const segs = record.activity_segments || [];
            const totalMin = totalOnDutyMinutes(record);
            const firstSeg = segs[0];
            const lastSeg = segs[segs.length - 1];
            return (
              <tr key={record.id} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${segs.length > 0 && !lastSeg?.end_time ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                    <span className="font-medium text-slate-800">{name}</span>
                  </div>
                </td>
                <td className="px-3 py-2">
                  <Badge variant="secondary" className="text-xs">{segs.length}</Badge>
                </td>
                <td className="px-3 py-2 text-slate-600 text-xs">{formatTime(firstSeg?.start_time)}</td>
                <td className="px-3 py-2 text-slate-600 text-xs">
                  {lastSeg?.end_time ? formatTime(lastSeg.end_time) : <span className="text-emerald-600 font-medium text-xs">Still active</span>}
                </td>
                <td className="px-3 py-2 text-right font-medium text-slate-800">{formatDuration(totalMin)}</td>
                <td className="px-3 py-2">
                  <div className="flex gap-1 justify-end">
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onEdit(record)}><Edit className="w-3 h-3" /></Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500" onClick={() => onDelete(record)}><Trash2 className="w-3 h-3" /></Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Edit / Add Dialog ────────────────────────────────────────────────────────
function SegmentDialog({ record, onSave, onClose }) {
  const [segments, setSegments] = useState(
    (record?.activity_segments || []).map((s) => ({
      start_time: s.start_time ? format(parseISO(s.start_time), "yyyy-MM-dd'T'HH:mm") : '',
      end_time: s.end_time ? format(parseISO(s.end_time), "yyyy-MM-dd'T'HH:mm") : '',
      tot: s.tot ?? '',
    }))
  );
  const [saving, setSaving] = useState(false);

  const addSegment = () => setSegments((prev) => [...prev, { start_time: '', end_time: '', tot: '' }]);
  const removeSegment = (i) => setSegments((prev) => prev.filter((_, idx) => idx !== i));
  const updateSegment = (i, field, val) => setSegments((prev) => prev.map((s, idx) => idx === i ? { ...s, [field]: val } : s));

  const handleSave = async () => {
    setSaving(true);
    try {
      const built = segments
        .filter((s) => s.start_time)
        .map((s) => {
          const start = new Date(s.start_time).toISOString();
          const end = s.end_time ? new Date(s.end_time).toISOString() : null;
          const tot = start && end ? differenceInMinutes(new Date(end), new Date(start)) : null;
          return { start_time: start, end_time: end, tot };
        });
      await onSave({ activity_segments: built });
      onClose();
    } catch (e) {
      alert('Save failed: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{record?.id ? 'Edit Activity Segments' : 'Add Activity Record'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {segments.map((seg, i) => (
            <div key={i} className="border border-slate-200 rounded-lg p-3 space-y-2 bg-slate-50">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-600">Segment {i + 1}</span>
                <Button variant="ghost" size="icon" className="h-6 w-6 text-red-500" onClick={() => removeSegment(i)}><Trash2 className="w-3 h-3" /></Button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">Start Time</Label>
                  <Input type="datetime-local" value={seg.start_time} onChange={(e) => updateSegment(i, 'start_time', e.target.value)} className="text-xs h-8" />
                </div>
                <div>
                  <Label className="text-xs">End Time (blank = still active)</Label>
                  <Input type="datetime-local" value={seg.end_time} onChange={(e) => updateSegment(i, 'end_time', e.target.value)} className="text-xs h-8" />
                </div>
              </div>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={addSegment} className="w-full">
            <Plus className="w-3 h-3 mr-1" /> Add Segment
          </Button>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function DriverActivityTab({ appUsers = [], cities = [], stores = [] }) {
  const today = format(new Date(), 'yyyy-MM-dd');

  const [selectedDate, setSelectedDate] = useState(today);
  const [selectedCityId, setSelectedCityId] = useState('all');
  const [viewMode, setViewMode] = useState('timeline'); // 'timeline' | 'cards' | 'table'
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editingRecord, setEditingRecord] = useState(null); // null | record | 'new'
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  // Build driver name lookup from appUsers
  const driverNames = useMemo(() => {
    const map = {};
    appUsers.forEach((u) => { if (u?.user_id) map[u.user_id] = u.user_name || u.user_id; });
    return map;
  }, [appUsers]);

  // Drivers for "Add" dropdown
  const drivers = useMemo(() => appUsers.filter((u) => (u.app_roles || []).includes('driver') && u.status !== 'inactive'), [appUsers]);

  const loadRecords = async () => {
    setLoading(true);
    try {
      const filter = { activity_date: selectedDate };
      const data = await base44.entities.DriverDailyActivity.filter(filter);

      // Filter by city if selected — driver's city_ids in appUsers
      let filtered = data || [];
      if (selectedCityId && selectedCityId !== 'all') {
        const driverIdsInCity = new Set(
          appUsers
            .filter((u) => (u.city_ids || [u.city_id]).filter(Boolean).includes(selectedCityId))
            .map((u) => u.user_id)
        );
        filtered = filtered.filter((r) => driverIdsInCity.has(r.driver_id));
      }

      // Sort by driver name
      filtered.sort((a, b) => {
        const na = driverNames[a.driver_id] || '';
        const nb = driverNames[b.driver_id] || '';
        return na.localeCompare(nb);
      });

      setRecords(filtered);
    } catch (e) {
      console.error('[DriverActivityTab] load failed:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadRecords(); }, [selectedDate, selectedCityId]);

  // Live WebSocket subscription — reload when any DriverDailyActivity record changes
  useEffect(() => {
    const unsubscribe = base44.entities.DriverDailyActivity.subscribe((event) => {
      // Only reload if the changed record matches the currently viewed date
      const changedDate = event?.data?.activity_date;
      if (!changedDate || changedDate === selectedDate) {
        loadRecords();
      }
    });
    return unsubscribe;
  }, [selectedDate, selectedCityId]);

  const handleSave = async (updates) => {
    if (editingRecord?.id) {
      await base44.entities.DriverDailyActivity.update(editingRecord.id, updates);
    } else if (editingRecord === 'new') {
      // no-op: new record dialog handles driver selection separately — see below
    }
    await loadRecords();
  };

  const handleDelete = async () => {
    if (!deleteTarget?.id) return;
    setDeleting(true);
    try {
      await base44.entities.DriverDailyActivity.delete(deleteTarget.id);
      setDeleteTarget(null);
      await loadRecords();
    } catch (e) {
      alert('Delete failed: ' + e.message);
    } finally {
      setDeleting(false);
    }
  };

  // For "new" record creation
  const [newDriverId, setNewDriverId] = useState('');
  const [showNewForm, setShowNewForm] = useState(false);
  const [newSegments, setNewSegments] = useState([{ start_time: '', end_time: '', tot: '' }]);
  const [savingNew, setSavingNew] = useState(false);

  const handleCreateNew = async () => {
    if (!newDriverId) { alert('Please select a driver.'); return; }
    setSavingNew(true);
    try {
      const driver = appUsers.find((u) => u.user_id === newDriverId);
      const built = newSegments
        .filter((s) => s.start_time)
        .map((s) => {
          const start = new Date(s.start_time).toISOString();
          const end = s.end_time ? new Date(s.end_time).toISOString() : null;
          const tot = start && end ? differenceInMinutes(new Date(end), new Date(start)) : null;
          return { start_time: start, end_time: end, tot };
        });
      await base44.entities.DriverDailyActivity.create({
        driver_id: newDriverId,
        driver_name: driver?.user_name || '',
        activity_date: selectedDate,
        activity_segments: built,
      });
      setShowNewForm(false);
      setNewDriverId('');
      setNewSegments([{ start_time: '', end_time: '', tot: '' }]);
      await loadRecords();
    } catch (e) {
      alert('Create failed: ' + e.message);
    } finally {
      setSavingNew(false);
    }
  };

  const VIEW_TABS = [
    { key: 'timeline', icon: BarChart2, label: 'Timeline' },
    { key: 'cards', icon: LayoutGrid, label: 'Cards' },
    { key: 'table', icon: List, label: 'Table' },
  ];

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-1">
          {VIEW_TABS.map(({ key, icon: Icon, label }) => (
            <button
              key={key}
              onClick={() => setViewMode(key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${viewMode === key ? 'bg-white shadow text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>

        <Input
          type="date"
          value={selectedDate}
          onChange={(e) => setSelectedDate(e.target.value)}
          className="w-36 h-9 text-sm" />

        {cities.length > 0 && (
          <Select value={selectedCityId} onValueChange={setSelectedCityId}>
            <SelectTrigger className="w-36 h-9 text-sm"><SelectValue placeholder="All Cities" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Cities</SelectItem>
              {cities.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}

        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={loadRecords} disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 mr-1 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setShowNewForm(true)}>
            <Plus className="w-3.5 h-3.5 mr-1" />
            Add Record
          </Button>
        </div>
      </div>

      {/* Stats bar */}
      <div className="flex gap-3 flex-wrap">
        <Badge variant="secondary" className="text-xs">{records.length} drivers</Badge>
        <Badge variant="secondary" className="text-xs">
          {records.filter((r) => (r.activity_segments || []).some((s) => !s.end_time)).length} currently active
        </Badge>
        <Badge variant="secondary" className="text-xs">
          Total: {formatDuration(records.reduce((s, r) => s + totalOnDutyMinutes(r), 0))}
        </Badge>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
        </div>
      ) : records.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <User className="w-10 h-10 mx-auto mb-3 opacity-40" />
          <p className="font-medium">No activity records for {selectedDate}</p>
          <p className="text-sm mt-1">Add a record or change the date.</p>
        </div>
      ) : viewMode === 'timeline' ? (
        <TimelineView records={records} driverNames={driverNames} onEdit={setEditingRecord} onDelete={setDeleteTarget} />
      ) : viewMode === 'cards' ? (
        <CardGridView records={records} driverNames={driverNames} onEdit={setEditingRecord} onDelete={setDeleteTarget} />
      ) : (
        <TableView records={records} driverNames={driverNames} onEdit={setEditingRecord} onDelete={setDeleteTarget} />
      )}

      {/* Edit existing record dialog */}
      {editingRecord && editingRecord !== 'new' && (
        <SegmentDialog
          record={editingRecord}
          onSave={handleSave}
          onClose={() => setEditingRecord(null)}
        />
      )}

      {/* Add new record dialog */}
      {showNewForm && (
        <Dialog open onOpenChange={(open) => { if (!open) setShowNewForm(false); }}>
          <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
            <DialogHeader><DialogTitle>Add Activity Record</DialogTitle></DialogHeader>
            <div className="space-y-4 py-2">
              <div>
                <Label className="text-xs">Driver</Label>
                <Select value={newDriverId} onValueChange={setNewDriverId}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Select driver…" /></SelectTrigger>
                  <SelectContent>
                    {drivers.map((d) => <SelectItem key={d.user_id} value={d.user_id}>{d.user_name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                {newSegments.map((seg, i) => (
                  <div key={i} className="border border-slate-200 rounded-lg p-3 space-y-2 bg-slate-50">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-600">Segment {i + 1}</span>
                      {newSegments.length > 1 && (
                        <Button variant="ghost" size="icon" className="h-6 w-6 text-red-500"
                          onClick={() => setNewSegments((prev) => prev.filter((_, idx) => idx !== i))}>
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label className="text-xs">Start Time</Label>
                        <Input type="datetime-local" value={seg.start_time}
                          onChange={(e) => setNewSegments((prev) => prev.map((s, idx) => idx === i ? { ...s, start_time: e.target.value } : s))}
                          className="text-xs h-8" />
                      </div>
                      <div>
                        <Label className="text-xs">End Time (blank = active)</Label>
                        <Input type="datetime-local" value={seg.end_time}
                          onChange={(e) => setNewSegments((prev) => prev.map((s, idx) => idx === i ? { ...s, end_time: e.target.value } : s))}
                          className="text-xs h-8" />
                      </div>
                    </div>
                  </div>
                ))}
                <Button variant="outline" size="sm" className="w-full"
                  onClick={() => setNewSegments((prev) => [...prev, { start_time: '', end_time: '', tot: '' }])}>
                  <Plus className="w-3 h-3 mr-1" /> Add Segment
                </Button>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowNewForm(false)}>Cancel</Button>
              <Button onClick={handleCreateNew} disabled={savingNew}>
                {savingNew ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null} Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Delete confirm */}
      {deleteTarget && (
        <Dialog open onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle className="flex items-center gap-2"><AlertCircle className="w-5 h-5 text-red-500" />Delete Activity Record?</DialogTitle></DialogHeader>
            <p className="text-sm text-slate-600">
              This will permanently delete the activity record for <strong>{driverNames[deleteTarget.driver_id] || deleteTarget.driver_id}</strong> on {deleteTarget.activity_date}.
            </p>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
              <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
                {deleting ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null} Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}