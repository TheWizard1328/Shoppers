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
              <div className="flex items-center gap-1.5 flex-wrap text-xs">
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
                {(catalogStatus?.recordCount !== undefined || transactionStatus?.recordCount !== undefined) && (
                  <>
                    <span className="text-muted-foreground">•</span>
                    {catalogStatus?.recordCount !== undefined && (
                      <span className="text-muted-foreground">
                        Catalog Items: {catalogStatus.recordCount}
                      </span>
                    )}
                    {transactionStatus?.recordCount !== undefined && catalogStatus?.recordCount !== undefined && (
                      <span className="text-muted-foreground">•</span>
                    )}
                    {transactionStatus?.recordCount !== undefined && (
                      <span className="text-muted-foreground">
                        Transactions: {transactionStatus.recordCount}
                      </span>
                    )}
                  </>
                )}
              </div>
              {error && (
                <div className="text-xs text-red-600 font-medium mt-1">
                  Error: {error}
                </div>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}