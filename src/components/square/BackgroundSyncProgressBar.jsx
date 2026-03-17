import React from "react";
import { Progress } from "@/components/ui/progress";
import { Loader2, CheckCircle } from "lucide-react";

export default function BackgroundSyncProgressBar({ progress }) {
  if (!progress || progress.stage === 'idle') return null;

  const stages = {
    starting: { label: 'Starting background sync...', percent: 5 },
    cleanup: { label: 'Running COD cleanup scan...', percent: 20 },
    catalog_sync: { label: 'Syncing with Square...', percent: 50 },
    payments_sync: { label: 'Loading synced COD records...', percent: 75 },
    saving_offline: { label: 'Saving synced data locally...', percent: 90 },
    complete: { label: 'Background sync complete', percent: 100 },
    error: { label: `Sync error: ${progress.error || 'unknown'}`, percent: progress.lastPercent || 0 },
  };

  const current = stages[progress.stage] || stages.starting;
  const isComplete = progress.stage === 'complete';
  const isError = progress.stage === 'error';

  return (
    <div className={`rounded-lg border p-3 transition-all duration-300 ${
      isComplete ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800' :
      isError ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800' :
      'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800'
    }`}>
      <div className="flex items-center gap-2 mb-2">
        {isComplete ? (
          <CheckCircle className="w-3.5 h-3.5 text-green-600 dark:text-green-400" />
        ) : isError ? null : (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600 dark:text-blue-400" />
        )}
        <span className={`text-xs font-medium ${
          isComplete ? 'text-green-700 dark:text-green-300' :
          isError ? 'text-red-700 dark:text-red-300' :
          'text-blue-700 dark:text-blue-300'
        }`}>
          {current.label}
        </span>
        {progress.detail && (
          <span className="text-xs text-muted-foreground ml-auto">{progress.detail}</span>
        )}
      </div>
      <Progress 
        value={current.percent} 
        className={`h-1.5 ${isError ? '[&>div]:bg-red-500' : isComplete ? '[&>div]:bg-green-500' : '[&>div]:bg-blue-500'}`}
      />
    </div>
  );
}