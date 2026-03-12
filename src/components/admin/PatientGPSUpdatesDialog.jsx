import React from 'react';
import { format } from 'date-fns';
import { useQuery } from '@tanstack/react-query';
import { PatientGPSLog } from '@/entities/PatientGPSLog';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, RefreshCw } from 'lucide-react';

export default function PatientGPSUpdatesDialog({ open, onOpenChange }) {
  const { data: logs = [], isLoading, isFetching, refetch } = useQuery({
    queryKey: ['patient-gps-logs'],
    queryFn: () => PatientGPSLog.list('-created_date', 100),
    enabled: open,
    initialData: [],
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <DialogTitle>GPS Updates</DialogTitle>
              <DialogDescription>
                Recent patient coordinate changes and matched address updates.
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
          ) : logs.length === 0 ? (
            <div className="rounded-lg border border-dashed p-6 text-center text-sm text-slate-500">
              No GPS updates logged yet.
            </div>
          ) : (
            logs.map((log) => {
              const timestamp = log.created_date || new Date().toISOString();
              const hasOldCoords = Number.isFinite(log.old_latitude) && Number.isFinite(log.old_longitude);

              return (
                <div key={log.id} className="rounded-lg border bg-white p-4 shadow-sm">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-900">{log.patient_name || 'Unknown Patient'}</div>
                      {log.patient_address && (
                        <div className="mt-1 text-sm text-slate-500">{log.patient_address}</div>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant={log.is_source_patient ? 'default' : 'secondary'}>
                        {log.is_source_patient ? 'Direct update' : 'Matched update'}
                      </Badge>
                      {log.related_patients_updated_count > 0 && (
                        <Badge variant="outline">
                          {log.related_patients_updated_count} related updated
                        </Badge>
                      )}
                    </div>
                  </div>

                  <div className="mt-3 grid gap-2 text-sm text-slate-600 md:grid-cols-2">
                    <div>
                      <span className="font-medium text-slate-700">Updated by:</span> {log.updated_by_user_name || 'Unknown'}
                    </div>
                    <div>
                      <span className="font-medium text-slate-700">When:</span> {format(new Date(timestamp), 'MMM d, yyyy h:mm a')}
                    </div>
                    <div className="md:col-span-2">
                      <span className="font-medium text-slate-700">Address key:</span> {log.normalized_address || '-'}
                    </div>
                    <div className="md:col-span-2">
                      <span className="font-medium text-slate-700">Coordinates:</span>{' '}
                      {hasOldCoords
                        ? `${log.old_latitude}, ${log.old_longitude} → ${log.new_latitude}, ${log.new_longitude}`
                        : `${log.new_latitude}, ${log.new_longitude}`}
                    </div>
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