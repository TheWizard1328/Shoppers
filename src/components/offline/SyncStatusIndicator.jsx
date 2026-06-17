import React, { useState, useEffect } from 'react';
import { offlineManager } from '@/components/utils/offlineManager';
import { Cloud, CloudOff, RefreshCw, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export default function SyncStatusIndicator() {
  const [isOnline, setIsOnline] = useState(offlineManager.getOnlineStatus());
  const [syncStatus, setSyncStatus] = useState(offlineManager.getSyncStatus());
  const [showDetails, setShowDetails] = useState(false);
  
  useEffect(() => {
    const unsubscribe = offlineManager.subscribe((online) => {
      setIsOnline(online);
      setSyncStatus(offlineManager.getSyncStatus());
    });
    
    // Poll for sync status updates
    const interval = setInterval(() => {
      setSyncStatus(offlineManager.getSyncStatus());
    }, 1000);
    
    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, []);
  
  const handleForceSync = async () => {
    if (!isOnline) return;
    await offlineManager.forceSyncNow();
    setSyncStatus(offlineManager.getSyncStatus());
  };
  
  if (isOnline && syncStatus.pendingCount === 0 && !syncStatus.hasConflicts) {
    return null; // Don't show when everything is synced
  }
  
  const icon = !isOnline ? (
    <CloudOff className="w-4 h-4 text-slate-500" />
  ) : syncStatus.isSyncing ? (
    <RefreshCw className="w-4 h-4 text-blue-500 animate-spin" />
  ) : syncStatus.hasConflicts ? (
    <AlertCircle className="w-4 h-4 text-orange-500" />
  ) : (
    <Cloud className="w-4 h-4 text-slate-500" />
  );
  
  const statusText = !isOnline ? 'Offline' : 
    syncStatus.isSyncing ? 'Syncing...' :
    syncStatus.hasConflicts ? 'Conflicts' :
    syncStatus.pendingCount > 0 ? `${syncStatus.pendingCount} pending` :
    'Synced';
  
  return (
    <Popover open={showDetails} onOpenChange={setShowDetails}>
      <PopoverTrigger asChild>
        <button className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white border border-slate-200 hover:bg-slate-50 transition-colors">
          {icon}
          <span className="text-xs font-medium text-slate-700">{statusText}</span>
          {syncStatus.pendingCount > 0 && (
            <span className="bg-blue-500 text-white text-xs rounded-full px-1.5 py-0.5 min-w-[20px] text-center">
              {syncStatus.pendingCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 z-[10001]" align="start">
        <div className="space-y-3">
          <div>
            <h4 className="font-semibold text-slate-900 mb-2">Sync Status</h4>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-600">Connection:</span>
                <span className={`font-medium ${isOnline ? 'text-green-600' : 'text-red-600'}`}>
                  {isOnline ? 'Online' : 'Offline'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Pending Actions:</span>
                <span className="font-medium text-slate-900">{syncStatus.pendingCount}</span>
              </div>
              {syncStatus.retryCount > 0 && (
                <div className="flex justify-between">
                  <span className="text-slate-600">Retry Attempts:</span>
                  <span className="font-medium text-orange-600">{syncStatus.retryCount}/5</span>
                </div>
              )}
              {syncStatus.hasConflicts && (
                <div className="flex justify-between">
                  <span className="text-slate-600">Conflicts:</span>
                  <span className="font-medium text-orange-600">Requires attention</span>
                </div>
              )}
            </div>
          </div>
          
          {isOnline && syncStatus.pendingCount > 0 && !syncStatus.isSyncing && (
            <Button
              size="sm"
              onClick={handleForceSync}
              className="w-full gap-2"
            >
              <RefreshCw className="w-3 h-3" />
              Sync Now
            </Button>
          )}
          
          {!isOnline && (
            <p className="text-xs text-slate-500">
              Changes will sync automatically when connection is restored.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}