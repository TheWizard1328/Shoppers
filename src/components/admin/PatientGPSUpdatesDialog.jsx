import React, { useMemo, useState, useEffect } from 'react';
import { format } from 'date-fns';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, RefreshCw, CheckCircle2, XCircle, MapPin, Users } from 'lucide-react';

// Fetches patients that share the same normalized address as the log entry
function useMatchingPatients(logId, open) {
  const [matchingPatients, setMatchingPatients] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!logId || !open) return;
    let cancelled = false;
    setLoading(true);
    base44.functions.invoke('updateMatchingPatientGPS', { action: 'preview', logId })
      .then((res) => {
        if (!cancelled) setMatchingPatients(res?.data?.matchingPatients || res?.matchingPatients || []);
      })
      .catch(() => { if (!cancelled) setMatchingPatients([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [logId, open]);

  return { matchingPatients, loading };
}

function LogEntryCard({ log, open, onAction }) {
  const { matchingPatients, loading: loadingMatches } = useMatchingPatients(log.id, open);
  const [isProcessing, setIsProcessing] = useState(false);

  const timestamp = log.created_date || new Date().toISOString();
  const hasOldCoords = Number.isFinite(log.old_latitude) && Number.isFinite(log.old_longitude);

  const handleAction = async (action) => {
    setIsProcessing(true);
    await onAction(log.id, action);
    setIsProcessing(false);
  };

  return (
    <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
      {/* Header: Direct-change patient */}
      <div className="p-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-blue-500 shrink-0" />
              <span className="font-semibold text-slate-900">{log.patient_name || 'Unknown Patient'}</span>
              <Badge variant="default" className="shrink-0 text-xs">Direct Change</Badge>
            </div>
            {log.patient_address && (
              <div className="mt-1 text-sm text-slate-500 pl-6">{log.patient_address}</div>
            )}
          </div>
        </div>

        <div className="mt-3 grid gap-2 text-sm text-slate-600 md:grid-cols-2">
          <div>
            <span className="font-medium text-slate-700">Updated by:</span>{' '}
            {log.updated_by_user_name || 'Unknown'}
          </div>
          <div>
            <span className="font-medium text-slate-700">When:</span>{' '}
            {format(new Date(timestamp), 'MMM d, yyyy h:mm a')}
          </div>
          <div className="md:col-span-2">
            <span className="font-medium text-slate-700">New coords:</span>{' '}
            {hasOldCoords
              ? `${log.old_latitude?.toFixed(5)}, ${log.old_longitude?.toFixed(5)} → ${log.new_latitude?.toFixed(5)}, ${log.new_longitude?.toFixed(5)}`
              : `${log.new_latitude?.toFixed(5)}, ${log.new_longitude?.toFixed(5)}`}
          </div>
        </div>
      </div>

      {/* Matching patients at the same address */}
      <div className="border-t bg-slate-50 px-4 py-3">
        <div className="flex items-center gap-2 mb-2 text-xs font-semibold text-slate-600 uppercase tracking-wide">
          <Users className="h-3.5 w-3.5" />
          Patients at same address
          {!loadingMatches && (
            <Badge variant="secondary" className="text-xs">{matchingPatients.length}</Badge>
          )}
        </div>

        {loadingMatches ? (
          <div className="flex items-center gap-2 text-xs text-slate-400 py-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            Finding matching patients...
          </div>
        ) : matchingPatients.length === 0 ? (
          <p className="text-xs text-slate-400 py-1">No other patients found at this address.</p>
        ) : (
          <ul className="space-y-1">
            {matchingPatients.map((p) => (
              <li key={p.id} className="flex items-center gap-2 text-sm text-slate-700">
                <MapPin className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                <span>{p.full_name}</span>
                {p.address && p.address !== log.patient_address && (
                  <span className="text-xs text-slate-400 truncate">({p.address})</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-3 border-t px-4 py-3 bg-white">
        <p className="flex-1 text-xs text-slate-500">
          {matchingPatients.length > 0
            ? `Accept to apply new coords to ${matchingPatients.length} patient(s) above.`
            : 'Accept to confirm this direct change (no other patients to update).'}
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={isProcessing}
          onClick={() => handleAction('cancel')}
          className="text-slate-600 border-slate-300"
        >
          {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
          Discard
        </Button>
        <Button
          size="sm"
          disabled={isProcessing || loadingMatches}
          onClick={() => handleAction('accept')}
          className="bg-green-600 hover:bg-green-700 text-white"
        >
          {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
          Accept{matchingPatients.length > 0 ? ` (${matchingPatients.length})` : ''}
        </Button>
      </div>
    </div>
  );
}

export default function PatientGPSUpdatesDialog({ open, onOpenChange }) {
  const queryClient = useQueryClient();

  const { data: logs = [], isLoading, isFetching, refetch } = useQuery({
    queryKey: ['patient-gps-logs'],
    queryFn: () => base44.entities.PatientGPSLog.list('-created_date', 200),
    enabled: open,
    initialData: [],
  });

  // Only the most recent direct change per patient
  const pendingLogs = useMemo(() => {
    const directUpdates = logs.filter((log) => log.is_source_patient);
    const latestMap = new Map();
    for (const log of directUpdates) {
      const existing = latestMap.get(log.patient_id);
      if (!existing || new Date(log.created_date) > new Date(existing.created_date)) {
        latestMap.set(log.patient_id, log);
      }
    }
    return Array.from(latestMap.values()).sort(
      (a, b) => new Date(b.created_date) - new Date(a.created_date)
    );
  }, [logs]);

  const handleAction = async (logId, action) => {
    try {
      await base44.functions.invoke('updateMatchingPatientGPS', { action, logId });
      queryClient.invalidateQueries({ queryKey: ['patient-gps-logs'] });
    } catch (err) {
      console.error(`[GPS Dialog] ${action} failed:`, err.message);
      alert(`Failed to ${action} GPS update: ${err.message}`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <DialogTitle>GPS Updates — Pending Review</DialogTitle>
              <DialogDescription>
                Review direct GPS changes and choose whether to apply them to other patients at the same address.
              </DialogDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Refresh
            </Button>
          </div>
        </DialogHeader>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
          {isLoading ? (
            <div className="flex items-center justify-center py-10 text-slate-500">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              Loading GPS updates...
            </div>
          ) : pendingLogs.length === 0 ? (
            <div className="rounded-lg border border-dashed p-6 text-center text-sm text-slate-500">
              No pending GPS updates to review.
            </div>
          ) : (
            pendingLogs.map((log) => (
              <LogEntryCard key={log.id} log={log} open={open} onAction={handleAction} />
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}