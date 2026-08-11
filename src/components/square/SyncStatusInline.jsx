import React from "react";
import { CheckCircle, AlertCircle, Clock, Loader2 } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";

// Compact, single-row sync status pill for embedding inside a list-view header.
// Renders: [icon] Synced • 10 minutes ago (@ HH:mm:ss) | Cash X · Debit X · Credit X · Cheque X
export default function SyncStatusInline({ syncStatus, isSyncing, error, collectedCodTypeBreakdown = { Cash: 0, Debit: 0, Credit: 0, Check: 0 } }) {
  const catalogStatus = syncStatus?.catalog;
  const transactionStatus = syncStatus?.transactions;
  const lastSyncTime = catalogStatus?.lastSync || transactionStatus?.lastSync;

  let icon = <Clock className="w-4 h-4" />;
  let color = "text-slate-500 dark:text-slate-400";
  let bg = "bg-slate-50 dark:bg-slate-800";
  let border = "border-slate-200 dark:border-slate-700";
  let text = "Never Synced";

  if (isSyncing) {
    icon = <Loader2 className="w-4 h-4 animate-spin" />;
    color = "text-blue-600 dark:text-blue-400";
    bg = "bg-blue-50 dark:bg-blue-950/40";
    border = "border-blue-200 dark:border-blue-800";
    text = "Syncing...";
  } else if (error) {
    icon = <AlertCircle className="w-4 h-4" />;
    color = "text-red-600 dark:text-red-400";
    bg = "bg-red-50 dark:bg-red-950/40";
    border = "border-red-200 dark:border-red-800";
    text = "Sync Error";
  } else if (catalogStatus?.status === 'synced' || transactionStatus?.status === 'synced') {
    icon = <CheckCircle className="w-4 h-4" />;
    color = "text-emerald-600 dark:text-emerald-400";
    bg = "bg-emerald-50 dark:bg-emerald-950/40";
    border = "border-emerald-200 dark:border-emerald-800";
    text = "Synced";
  }

  const pill = "rounded-full bg-white/80 dark:bg-slate-900/60 px-2 py-0.5 text-slate-700 dark:text-slate-300 whitespace-nowrap shrink-0";

  return (
    <div className={`flex items-center gap-2 rounded-full border ${border} ${bg} px-3 py-1.5 text-xs flex-wrap`}>
      <span className={`${color} shrink-0`}>{icon}</span>
      <span className={`font-semibold ${color} shrink-0`}>{text}</span>
      {lastSyncTime &&
      <span className="text-slate-500 dark:text-slate-400 whitespace-nowrap shrink-0">
          • {formatDistanceToNow(new Date(lastSyncTime), { addSuffix: true })} (@ {format(new Date(lastSyncTime), 'HH:mm:ss')})
        </span>
      }
      <span className="w-px h-4 bg-slate-200 dark:bg-slate-600 shrink-0 hidden md:inline-block" />
      <span className={`${pill}`}>Cash {collectedCodTypeBreakdown.Cash | 0}</span>
      <span className={`${pill}`}>Debit {collectedCodTypeBreakdown.Debit | 0}</span>
      <span className={`${pill}`}>Credit {collectedCodTypeBreakdown.Credit | 0}</span>
      <span className={`${pill}`}>Cheque {collectedCodTypeBreakdown.Check | 0}</span>
    </div>
  );
}