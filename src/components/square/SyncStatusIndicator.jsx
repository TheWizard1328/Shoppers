import React, { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { CheckCircle, AlertCircle, Clock, Loader2, ChevronDown } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";

export default function SyncStatusIndicator({ syncStatus, isSyncing, error, codDeliveryCount = 0, catalogItemCount = 0, cardSpendCount = 0, salesCount = 0, collectedCodTypeBreakdown = { Cash: 0, Debit: 0, Credit: 0, Check: 0 } }) {
  const catalogStatus = syncStatus?.catalog;
  const transactionStatus = syncStatus?.transactions;

  // Determine overall sync status
  const getStatusDisplay = () => {
    if (isSyncing) {
      return {
        icon: <Loader2 className="w-4 h-4 animate-spin" />,
        color: "text-blue-600",
        bgColor: "bg-blue-50",
        borderColor: "border-blue-200",
        text: "Syncing..."
      };
    }

    if (error) {
      return {
        icon: <AlertCircle className="w-4 h-4" />,
        color: "text-red-600",
        bgColor: "bg-red-50",
        borderColor: "border-red-200",
        text: "Sync Error"
      };
    }

    if (catalogStatus?.status === 'synced' || transactionStatus?.status === 'synced') {
      return {
        icon: <CheckCircle className="w-4 h-4" />,
        color: "text-green-600",
        bgColor: "bg-green-50",
        borderColor: "border-green-200",
        text: "Synced"
      };
    }

    return {
      icon: <Clock className="w-4 h-4" />,
      color: "text-gray-600",
      bgColor: "bg-gray-50",
      borderColor: "border-gray-200",
      text: "Never Synced"
    };
  };

  const status = getStatusDisplay();
  const lastSyncTime = catalogStatus?.lastSync || transactionStatus?.lastSync;
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Card className={`border ${status.borderColor}`}>
      <CardContent className={`p-3 md:p-4 ${status.bgColor}`}>
        <Collapsible open={isOpen} onOpenChange={setIsOpen}>
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3 flex-1">
              <div className={`mt-0.5 ${status.color}`}>
                {status.icon}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap text-xs hidden md:flex">
                  <span className={`font-semibold ${status.color}`}>
                    {status.text}
                  </span>
                  {lastSyncTime && (
                    <>
                      <span className="text-muted-foreground">•</span>
                      <span className="text-muted-foreground">
                        {formatDistanceToNow(new Date(lastSyncTime), { addSuffix: true })}
                      </span>
                      <span className="text-muted-foreground">(@ {format(new Date(lastSyncTime), 'HH:mm:ss')})</span>
                    </>
                  )}
                  <>
                    <span className="text-muted-foreground">•</span>
                    <span className="text-muted-foreground">Catalog Items: {catalogItemCount}</span>
                    <span className="text-muted-foreground">•</span>
                    <span className="text-muted-foreground">Transactions: Card Spend: {cardSpendCount} Sales: {salesCount}</span>
                  </>
                </div>
                <div className="md:hidden flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className={`font-semibold ${status.color}`}>{status.text}</div>
                    {lastSyncTime && (
                      <div className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(lastSyncTime), { addSuffix: true })}
                      </div>
                    )}
                  </div>
                  <CollapsibleTrigger className="inline-flex items-center gap-1 rounded-md bg-white/70 dark:bg-slate-900/40 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300">
                    {isOpen ? 'Hide stats' : 'Show stats'}
                    <ChevronDown className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                  </CollapsibleTrigger>
                </div>

                <CollapsibleContent forceMount className={`${isOpen ? 'block' : 'hidden'} md:block`}>
                  <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2">
                    <div className="rounded-xl bg-white/70 dark:bg-slate-900/40 px-3 py-2">
                      <div className="text-[11px] text-muted-foreground">COD Deliveries</div>
                      <div className="text-sm font-semibold text-slate-900 dark:text-slate-50">{codDeliveryCount}</div>
                    </div>
                    <div className="rounded-xl bg-white/70 dark:bg-slate-900/40 px-3 py-2">
                      <div className="text-[11px] text-muted-foreground">Card Spend</div>
                      <div className="text-sm font-semibold text-slate-900 dark:text-slate-50">{cardSpendCount}</div>
                    </div>
                    <div className="rounded-xl bg-white/70 dark:bg-slate-900/40 px-3 py-2">
                      <div className="text-[11px] text-muted-foreground">Sales</div>
                      <div className="text-sm font-semibold text-slate-900 dark:text-slate-50">{salesCount}</div>
                    </div>
                    <div className="rounded-xl bg-white/70 dark:bg-slate-900/40 px-3 py-2">
                      <div className="text-[11px] text-muted-foreground">Catalog</div>
                      <div className="text-sm font-semibold text-slate-900 dark:text-slate-50">{catalogItemCount}</div>
                    </div>
                  </div>

                  <div className="mt-2 flex flex-wrap gap-2 text-[11px] md:text-xs">
                    <span className="rounded-full bg-white/70 dark:bg-slate-900/40 px-2.5 py-1 text-slate-700 dark:text-slate-300">Cash {collectedCodTypeBreakdown.Cash}</span>
                    <span className="rounded-full bg-white/70 dark:bg-slate-900/40 px-2.5 py-1 text-slate-700 dark:text-slate-300">Debit {collectedCodTypeBreakdown.Debit}</span>
                    <span className="rounded-full bg-white/70 dark:bg-slate-900/40 px-2.5 py-1 text-slate-700 dark:text-slate-300">Credit {collectedCodTypeBreakdown.Credit}</span>
                    <span className="rounded-full bg-white/70 dark:bg-slate-900/40 px-2.5 py-1 text-slate-700 dark:text-slate-300">Cheque {collectedCodTypeBreakdown.Cheque}</span>
                  </div>
                </CollapsibleContent>
                {error && (
                  <div className="text-xs text-red-600 font-medium mt-1">
                    Error: {error}
                  </div>
                )}
              </div>
            </div>
          </div>
        </Collapsible>
      </CardContent>
    </Card>
  );
}