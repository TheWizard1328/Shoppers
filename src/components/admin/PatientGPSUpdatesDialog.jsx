import React, { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, RefreshCw, CheckCircle2, XCircle, MapPin } from 'lucide-react';

export default function PatientGPSUpdatesDialog({ open, onOpenChange }) {
  const queryClient = useQueryClient();
  const [processingIds, setProcessingIds] = useState(new Set());

  const { data: logs = [], isLoading, isFetching, refetch } = useQuery({
    queryKey: ['patient-gps-logs'],
    queryFn: () => base44.entities.PatientGPSLog.list('-created_date', 200),
    enabled: open,
    initialData: [],
  });

  // Only show the most recent "direct change" log per patient
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
    setProcessingIds((prev) => new Set([...prev, logId]));
    try {
      await base44.functions.invoke('updateMatchingPatientGPS', { action, logId });
      queryClient.invalidateQueries({ queryKey: ['patient-gps-logs'] });
    } catch (err) {
      console.error(`[GPS Dialog] ${action} failed:`, err.message);
      alert(`Failed to ${action} GPS update: ${err.message}`);
    } finally {
      setProcessingIds((prev) => {
        const next = new Set(prev);
        next.delete(logId);
        return next;
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <DialogTitle>GPS Updates — Pending Review</DialogTitle>
              <DialogDescription>
                Direct patient GPS changes awaiting admin approval to propagate to patients with similar addresses.
              </DialogDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Refresh
            </Button>
          </div>
        </DialogHeader>

        <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
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
            pendingLogs.map((log) => {
              const isProcessing = processingIds.has(log.id);
              const timestamp = log.created_date || new Date().toISOString();
              const hasOldCoords = Number.isFinite(log.old_latitude) && Number.isFinite(log.old_longitude);

              return (
                <div key={log.id} className="rounded-lg border bg-white p-4 shadow-sm">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <MapPin className="h-4 w-4 text-slate-400 shrink-0" />
                        <span className="font-semibold text-slate-900">{log.patient_name || 'Unknown Patient'}</span>
                      </div>
                      {log.patient_address && (
                        <div className="mt-1 text-sm text-slate-500 pl-6">{log.patient_address}</div>
                      )}
                    </div>
                    <Badge variant="default" className="self-start shrink-0">Direct Change</Badge>
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
                      <span className="font-medium text-slate-700">Coordinates:</span>{' '}
                      {hasOldCoords
                        ? `${log.old_latitude?.toFixed(5)}, ${log.old_longitude?.toFixed(5)} → ${log.new_latitude?.toFixed(5)}, ${log.new_longitude?.toFixed(5)}`
                        : `${log.new_latitude?.toFixed(5)}, ${log.new_longitude?.toFixed(5)}`}
                    </div>
                  </div>

                  {/* Action buttons */}
                  <div className="mt-4 flex items-center gap-3 border-t pt-3">
                    <p className="flex-1 text-xs text-slate-500">
                      Accept to update all patients at this address with the new coordinates.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={isProcessing}
                      onClick={() => handleAction(log.id, 'cancel')}
                      className="text-slate-600 border-slate-300"
                    >
                      {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      disabled={isProcessing}
                      onClick={() => handleAction(log.id, 'accept')}
                      className="bg-green-600 hover:bg-green-700 text-white"
                    >
                      {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                      Accept Bulk Update
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}