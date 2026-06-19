import React, { useMemo, useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useAppData } from '@/components/utils/AppDataContext';
import { offlineDB } from '@/components/utils/offlineDatabase';
import { findMatchingPatients } from './patientGPSMatchUtils';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2, RefreshCw, CheckCircle2, XCircle, MapPin, Users, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import PatientGPSMap from './PatientGPSMap';

function LogEntryCard({ log, matchingPatients = [], onAction, stores = [], disabled = false, isSelected = false, onSelect, patients = [] }) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [matchesExpanded, setMatchesExpanded] = useState(false);
  // null = all selected (collapsed state); Set = explicit selection (expanded state)
  const [selectedPatientIds, setSelectedPatientIds] = useState(null);

  // When collapsed, reset to "all selected" mode
  const handleToggleExpanded = (e) => {
    e.stopPropagation();
    const next = !matchesExpanded;
    setMatchesExpanded(next);
    if (!next) setSelectedPatientIds(null); // collapse → all selected
    if (next && selectedPatientIds === null) {
      // expanding for first time → pre-select all
      setSelectedPatientIds(new Set(matchingPatients.map(p => p.id)));
    }
  };

  const togglePatient = (id) => {
    setSelectedPatientIds(prev => {
      const next = new Set(prev || matchingPatients.map(p => p.id));
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Patients that will actually be updated
  const effectivePatients = selectedPatientIds === null
    ? matchingPatients
    : matchingPatients.filter(p => selectedPatientIds.has(p.id));

  const rawTs = log.created_date || new Date().toISOString();
  const timestamp = rawTs.endsWith('Z') || rawTs.includes('+') ? rawTs : rawTs + 'Z';

  const handleAction = async (action) => {
    setIsProcessing(true);
    await onAction(log.id, action, effectivePatients);
    setIsProcessing(false);
  };

  return (
    <div
      className={`rounded-lg border shadow-sm overflow-hidden cursor-pointer transition-all ${isSelected ? 'border-blue-500 ring-2 ring-blue-200 bg-blue-50' : 'bg-white hover:border-slate-300'}`}
      onClick={() => onSelect(log)}>
      
      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <MapPin className="h-3.5 w-3.5 text-blue-500 shrink-0" />
              <span className="font-semibold text-slate-900 text-sm">{log.patient_name || 'Unknown Patient'}</span>
              <Badge variant="default" className="shrink-0 text-xs py-0">Direct</Badge>
            </div>
            {log.patient_address &&
            <div className="mt-0.5 text-xs text-slate-500 pl-5 truncate">
                {(() => {
                // Strip city, province, postal code — keep only street portion (up to 2nd comma)
                const parts = log.patient_address.split(',');
                const street = parts.slice(0, Math.min(2, parts.length)).join(',').trim();
                const patient = patients.find((p) => p.id === log.patient_id);
                const unit = patient?.unit_number;
                return unit ? `${street} — ${unit}` : street;
              })()}
              </div>
            }
          </div>
          {(() => {
            const store = stores.find((s) => s.id === log.store_id);
            if (!store?.abbreviation) return null;
            return (
              <Badge variant="secondary" className="shrink-0 px-2 py-0.5 text-xs font-bold rounded-full" style={{ backgroundColor: store.color || '#10B981', color: 'white' }}>
                {store.abbreviation.slice(0, 2).toUpperCase()}
              </Badge>);

          })()}
        </div>

        <div className="mt-2 text-xs text-slate-500 grid grid-cols-2 gap-x-2">
          <div><span className="text-slate-600">By:</span> {log.updated_by_user_name || 'Unknown'}</div>
          <div>{new Date(timestamp).toLocaleString('en-CA', { timeZone: 'America/Edmonton', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}</div>
        </div>
      </div>

      <div className="border-t bg-slate-50">
        <button
          onClick={handleToggleExpanded}
          className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-600 uppercase tracking-wide hover:bg-slate-100 transition-colors">
          {matchesExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <Users className="h-3 w-3" />
          Same address
          <Badge variant="secondary" className="text-xs ml-1 py-0">{matchingPatients.length}</Badge>
          {matchesExpanded && selectedPatientIds !== null && selectedPatientIds.size < matchingPatients.length &&
            <Badge variant="outline" className="text-xs ml-1 py-0 border-amber-400 text-amber-700">{selectedPatientIds.size} selected</Badge>
          }
        </button>

        {matchesExpanded &&
        <div className="px-3 pb-2" onClick={(e) => e.stopPropagation()}>
            {matchingPatients.length === 0 ?
          <p className="text-xs text-slate-400 py-1">No other patients found at this address.</p> :
          <>
            <div className="flex items-center justify-between pb-1">
              <span className="text-[10px] text-slate-400">Check/uncheck to include in update</span>
              <button
                className="text-[10px] text-blue-500 hover:underline"
                onClick={() => {
                  const allIds = new Set(matchingPatients.map(p => p.id));
                  const allSelected = selectedPatientIds !== null && selectedPatientIds.size === matchingPatients.length;
                  setSelectedPatientIds(allSelected ? new Set() : allIds);
                }}>
                {selectedPatientIds !== null && selectedPatientIds.size === matchingPatients.length ? 'Deselect all' : 'Select all'}
              </button>
            </div>
            <ul className="space-y-0.5">
                {matchingPatients.map((p) => {
              const isActive = p.status !== 'inactive';
              const storeAbbr = stores.find((s) => s.id === p.store_id)?.abbreviation;
              const isChecked = selectedPatientIds === null || selectedPatientIds.has(p.id);
              return (
                <li
                  key={p.id}
                  className={`grid items-center gap-x-2 text-xs rounded px-2 py-1 cursor-pointer transition-opacity ${isChecked ? (isActive ? 'bg-green-50 text-green-900' : 'bg-red-50 text-red-800') : 'bg-slate-100 text-slate-400 opacity-60'}`}
                  style={{ gridTemplateColumns: '1rem 0.75rem 1fr 2.5rem 2.5rem 3.5rem' }}
                  onClick={() => togglePatient(p.id)}>
                      <Checkbox
                        checked={isChecked}
                        onCheckedChange={() => togglePatient(p.id)}
                        className="h-3 w-3"
                        onClick={(e) => e.stopPropagation()} />
                      <MapPin className={`h-3 w-3 shrink-0 ${isChecked ? (isActive ? 'text-green-500' : 'text-red-400') : 'text-slate-300'}`} />
                      <span className="font-medium truncate">{p.full_name}</span>
                      <span className="text-xs font-mono text-center">{p.unit_number || ''}</span>
                      {storeAbbr ? <Badge variant="secondary" className="text-xs justify-center px-1 py-0">{storeAbbr}</Badge> : <span />}
                      <Badge variant="outline" className={`text-xs justify-center py-0 ${isActive ? 'border-green-300 text-green-700' : 'border-red-300 text-red-600'}`}>
                        {isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </li>);

            })}
              </ul>
          </>
          }
          </div>
        }
      </div>

      <div className="flex items-center gap-2 border-t px-3 py-2 bg-white" onClick={(e) => e.stopPropagation()}>
        <p className="flex-1 text-xs text-slate-400">
          {effectivePatients.length > 0 ? `Affects ${effectivePatients.length} patient(s).` : 'No others to update.'}
        </p>
        <Button variant="outline" size="sm" disabled={isProcessing || disabled} onClick={() => handleAction('cancel')} className="text-slate-600 border-slate-300 h-7 text-xs px-2">
          {isProcessing ? <Loader2 className="w-3 h-3 animate-spin" /> : <XCircle className="w-3 h-3" />}
          Discard
        </Button>
        <Button size="sm" disabled={isProcessing || disabled} onClick={() => handleAction('accept')} className="bg-green-600 hover:bg-green-700 text-white h-7 text-xs px-2">
          {isProcessing ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
          Accept{effectivePatients.length > 0 ? ` (${effectivePatients.length})` : ''}
        </Button>
      </div>
    </div>);

}

export default function PatientGPSUpdatesDialog({ open, onOpenChange, stores = [] }) {
  const queryClient = useQueryClient();
  const { applyPatientChangesLocally } = useAppData();
  const [bulkProcessing, setBulkProcessing] = useState(false);
  const [selectedLog, setSelectedLog] = useState(null);
  // All patients from offline DB — used for matching (broader than the date-filtered in-memory set)
  const [allOfflinePatients, setAllOfflinePatients] = useState([]);

  // Load full patient list from offline DB on open
  useEffect(() => {
    if (!open) return;
    offlineDB.getAll(offlineDB.STORES.PATIENTS).then((rows) => {
      setAllOfflinePatients((rows || []).filter(Boolean));
    });
  }, [open]);

  const { data: logs = [], isLoading, isFetching, refetch } = useQuery({
    queryKey: ['patient-gps-logs'],
    queryFn: () => base44.entities.PatientGPSLog.list('-created_date', 200),
    enabled: open,
    initialData: []
  });

  const pendingLogs = useMemo(() => {
    const directUpdates = logs.filter((log) => log.is_source_patient);
    const latestMap = new Map();
    for (const log of directUpdates) {
      const existing = latestMap.get(log.patient_id);
      if (!existing || new Date(log.created_date) > new Date(existing.created_date)) {
        latestMap.set(log.patient_id, log);
      }
    }
    return Array.from(latestMap.values()).sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
  }, [logs]);

  // Auto-select first log when list loads
  useEffect(() => {
    if (pendingLogs.length > 0 && !selectedLog) {
      setSelectedLog(pendingLogs[0]);
    } else if (pendingLogs.length === 0) {
      setSelectedLog(null);
    } else if (selectedLog && !pendingLogs.find((l) => l.id === selectedLog.id)) {
      setSelectedLog(pendingLogs[0] || null);
    }
  }, [pendingLogs]);

  // Match against the full offline DB patient list (not the date-filtered in-memory set)
  const matchesMap = useMemo(() => {
    const result = {};
    for (const log of pendingLogs) {
      result[log.id] = findMatchingPatients(log, allOfflinePatients);
    }
    return result;
  }, [pendingLogs, allOfflinePatients]);

  const selectedMatches = selectedLog ? matchesMap[selectedLog.id] || [] : [];

  // 1. Write to offline DB first, 2. update in-memory state, 3. then call backend to sync online DB
  const applyLocalUpdates = async (log, matchingPatients) => {
    const newLat = Math.round(Number(log.new_latitude) * 1e7) / 1e7;
    const newLon = Math.round(Number(log.new_longitude) * 1e7) / 1e7;
    const upserts = matchingPatients.map((p) => ({ ...p, latitude: newLat, longitude: newLon }));
    // Step 1: offline DB
    await Promise.all(upserts.map((p) => offlineDB.save(offlineDB.STORES.PATIENTS, p)));
    // Step 2: in-memory state
    if (upserts.length > 0) applyPatientChangesLocally({ upserts });
    // Step 3: also update the local allOfflinePatients state so subsequent matches reflect new coords
    setAllOfflinePatients((prev) => {
      const map = new Map(prev.map((p) => [p.id, p]));
      upserts.forEach((p) => map.set(p.id, p));
      return Array.from(map.values());
    });
  };

  const handleAction = async (logId, action, matchingPatients = []) => {
    if (action === 'accept') {
      const log = pendingLogs.find((l) => l.id === logId);
      // Offline DB + in-memory first
      if (log) await applyLocalUpdates(log, matchingPatients);
    }
    // Then sync to online DB
    try {
      await base44.functions.invoke('updateMatchingPatientGPS', { action, logId });
      queryClient.invalidateQueries({ queryKey: ['patient-gps-logs'] });
    } catch (err) {
      console.error(`[GPS Dialog] ${action} failed:`, err.message);
      alert(`Failed to ${action} GPS update: ${err.message}`);
    }
  };

  const handleDiscardAll = async () => {
    setBulkProcessing(true);
    for (const log of pendingLogs) {
      await base44.functions.invoke('updateMatchingPatientGPS', { action: 'cancel', logId: log.id }).catch(() => {});
    }
    queryClient.invalidateQueries({ queryKey: ['patient-gps-logs'] });
    setBulkProcessing(false);
  };

  const handleAcceptAll = async () => {
    setBulkProcessing(true);
    // Step 1 & 2: Update offline DB + in-memory for all logs first
    await Promise.all(
      pendingLogs.map((log) => applyLocalUpdates(log, matchesMap[log.id] || []))
    );
    // Step 3: Sync all to online DB
    for (const log of pendingLogs) {
      await base44.functions.invoke('updateMatchingPatientGPS', { action: 'accept', logId: log.id }).catch(() => {});
    }
    queryClient.invalidateQueries({ queryKey: ['patient-gps-logs'] });
    setBulkProcessing(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[95vw] w-[95vw] flex flex-col px-4 py-4" style={{ maxHeight: '92vh', height: '92vh' }}>
        {/* Header */}
        <DialogHeader className="pr-8 shrink-0">
          <DialogTitle>GPS Updates — Pending Review</DialogTitle>
          <DialogDescription>
            Review direct GPS changes and apply them to other patients at the same address.
          </DialogDescription>
        </DialogHeader>

        {/* Body: split left/right */}
        <div className="flex flex-1 min-h-0 gap-4 py-3">
          {/* Left: Patient Cards */}
          <div className="w-[380px] shrink-0 flex flex-col min-h-0">
            {isLoading ?
            <div className="flex items-center justify-center py-10 text-slate-500">
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                Loading GPS updates...
              </div> :
            pendingLogs.length === 0 ?
            <div className="rounded-lg border border-dashed p-6 text-center text-sm text-slate-500">
                No pending GPS updates to review.
              </div> :

            <div className="flex-1 overflow-y-auto pr-1 space-y-2">
                <div className="text-xs text-slate-500 mb-1">{pendingLogs.length} pending update{pendingLogs.length !== 1 ? 's' : ''} — click to view on map</div>
                <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}>
                  {pendingLogs.map((log) =>
                <LogEntryCard
                  key={log.id}
                  log={log}
                  matchingPatients={matchesMap[log.id] || []}
                  onAction={handleAction}
                  stores={stores}
                  disabled={bulkProcessing}
                  isSelected={selectedLog?.id === log.id}
                  onSelect={setSelectedLog}
                  patients={allOfflinePatients} />

                )}
                </div>
              </div>
            }
            {/* Bottom action buttons */}
            <div className="flex items-center gap-2 shrink-0 pt-3 pb-3 pr-6">
              <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching || bulkProcessing} className="flex-1">
                {isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                Refresh
              </Button>
              {pendingLogs.length > 1 && <>
                <Button variant="outline" size="sm" disabled={bulkProcessing} onClick={handleDiscardAll} className="flex-1 text-slate-600 border-slate-300">
                  {bulkProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                  Discard All
                </Button>
                <Button size="sm" disabled={bulkProcessing} onClick={handleAcceptAll} className="flex-1 bg-green-600 hover:bg-green-700 text-white">
                  {bulkProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                  Accept All
                </Button>
              </>}
            </div>
          </div>

          {/* Right: Map */}
          <div className="flex-1 min-h-0 rounded-lg overflow-hidden border border-slate-200 relative">
            <PatientGPSMap
              key={selectedLog?.id || 'empty'}
              log={selectedLog}
              matchingPatients={selectedMatches} />
            
          </div>
        </div>
      </DialogContent>
    </Dialog>);

}