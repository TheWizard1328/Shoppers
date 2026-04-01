import React, { useEffect, useState } from 'react';
import { Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { subscribeBulkDeleteJob } from '../utils/bulkDeleteJobMonitor';

export default function BulkDeleteJobMonitor() {
  const [job, setJob] = useState(null);

  useEffect(() => subscribeBulkDeleteJob(setJob), []);

  if (!job || !job.jobId || job.status === 'idle') return null;

  const isDone = job.status === 'finished' || job.status === 'finished_with_errors';
  const Icon = isDone ? (job.failed > 0 ? AlertCircle : CheckCircle2) : Loader2;
  const iconClass = isDone ? (job.failed > 0 ? 'text-red-500' : 'text-emerald-500') : 'text-blue-500 animate-spin';
  const progress = job.total > 0 ? Math.round((job.completed / job.total) * 100) : 0;

  return (
    <div className="fixed bottom-4 right-4 z-[100001] w-[320px] rounded-xl border bg-white shadow-xl">
      <div className="p-4 space-y-3">
        <div className="flex items-start gap-3">
          <Icon className={`w-5 h-5 mt-0.5 ${iconClass}`} />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-900">Bulk delete job</p>
            <p className="text-xs text-slate-500">
              {isDone ? (job.failed > 0 ? 'Finished with errors' : 'Finished') : `Attempt ${job.currentAttempt}`}
            </p>
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex justify-between text-xs text-slate-600">
            <span>{job.completed}/{job.total} deleted</span>
            <span>{progress}%</span>
          </div>
          <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
            <div className="h-full bg-slate-900 transition-all duration-300" style={{ width: `${progress}%` }} />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="rounded-lg bg-slate-50 p-2 text-center">
            <div className="font-semibold text-slate-900">{job.completed}</div>
            <div className="text-slate-500">Done</div>
          </div>
          <div className="rounded-lg bg-slate-50 p-2 text-center">
            <div className="font-semibold text-slate-900">{job.pending}</div>
            <div className="text-slate-500">Pending</div>
          </div>
          <div className="rounded-lg bg-slate-50 p-2 text-center">
            <div className="font-semibold text-slate-900">{job.failed}</div>
            <div className="text-slate-500">Failed</div>
          </div>
        </div>

        {job.lastError && <p className="text-xs text-slate-500">{job.lastError}</p>}
      </div>
    </div>
  );
}