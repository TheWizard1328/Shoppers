import React, { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle, AlertCircle, Clock, Loader2 } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";

export default function SyncStatusIndicator({ syncStatus, isSyncing, error }) {
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

  return (
    <Card className={`border ${status.borderColor}`}>
      <CardContent className={`p-4 ${status.bgColor}`}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 flex-1">
            <div className={`mt-0.5 ${status.color}`}>
              {status.icon}
            </div>
            <div className="flex-1 min-w-0">
              <div className={`font-semibold text-sm ${status.color}`}>
                {status.text}
              </div>
              <div className="text-xs text-muted-foreground mt-1 space-y-1">
                {lastSyncTime && (
                  <div>
                    Last sync: {formatDistanceToNow(new Date(lastSyncTime), { addSuffix: true })}
                  </div>
                )}
                {error && (
                  <div className="text-red-600 font-medium">
                    Error: {error}
                  </div>
                )}
                {catalogStatus?.recordCount !== undefined && (
                  <div>
                    Catalog items: {catalogStatus.recordCount}
                  </div>
                )}
                {transactionStatus?.recordCount !== undefined && (
                  <div>
                    Transactions: {transactionStatus.recordCount}
                  </div>
                )}
              </div>
            </div>
          </div>
          {lastSyncTime && (
            <div className="text-right flex-shrink-0">
              <div className="text-xs text-muted-foreground">
                {format(new Date(lastSyncTime), 'HH:mm:ss')}
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}