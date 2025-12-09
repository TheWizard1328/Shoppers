import React, { useState, useEffect } from 'react';
import { Database, RefreshCw, CheckCircle, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { subscribeSyncStatus, getSyncStats, forceSyncAll, processPendingMutations } from '@/components/utils/offlineSync';
import { motion, AnimatePresence } from 'framer-motion';

export default function OfflineSyncIndicator() {
  const [syncStatus, setSyncStatus] = useState({ status: 'idle' });
  const [stats, setStats] = useState(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  useEffect(() => {
    // Load initial stats
    getSyncStats().then(setStats);

    // Subscribe to sync updates
    const unsubscribe = subscribeSyncStatus((status) => {
      setSyncStatus(status);
      setIsSyncing(status.status === 'syncing' || status.status === 'force_syncing');
      
      // Refresh stats when sync completes
      if (status.status === 'complete' || status.status === 'synced') {
        getSyncStats().then(setStats);
      }
    });

    return unsubscribe;
  }, []);

  const handleForceSync = async () => {
    try {
      setIsSyncing(true);
      await forceSyncAll();
      const newStats = await getSyncStats();
      setStats(newStats);
      
      // Trigger UI refresh after sync completes
      window.dispatchEvent(new CustomEvent('offlineSyncComplete'));
    } catch (error) {
      console.error('Force sync failed:', error);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSyncMutations = async () => {
    try {
      setIsSyncing(true);
      await processPendingMutations();
      const newStats = await getSyncStats();
      setStats(newStats);
      
      // Trigger UI refresh after mutations synced
      window.dispatchEvent(new CustomEvent('offlineSyncComplete'));
    } catch (error) {
      console.error('Mutation sync failed:', error);
    } finally {
      setIsSyncing(false);
    }
  };

  const getStatusColor = () => {
    if (isSyncing) return 'text-blue-500';
    if (syncStatus.status === 'error') return 'text-red-500';
    if (syncStatus.status === 'synced' || syncStatus.status === 'complete') return 'text-green-500';
    return 'text-slate-500';
  };

  const getStatusIcon = () => {
    if (isSyncing) return <RefreshCw className={`w-4 h-4 animate-spin ${getStatusColor()}`} />;
    if (syncStatus.status === 'error') return <AlertCircle className={`w-4 h-4 ${getStatusColor()}`} />;
    if (syncStatus.status === 'synced' || syncStatus.status === 'complete') return <CheckCircle className={`w-4 h-4 ${getStatusColor()}`} />;
    return <Database className={`w-4 h-4 ${getStatusColor()}`} />;
  };

  return (
    <div className="fixed bottom-4 left-4 z-[100]">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white rounded-lg shadow-lg border border-slate-200 overflow-hidden"
      >
        {/* Collapsed View */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-2 px-3 py-2 hover:bg-slate-50 transition-colors w-full"
        >
          {getStatusIcon()}
          <span className="text-xs font-medium text-slate-700">
            {isSyncing ? 'Syncing...' : 'Offline DB'}
          </span>
          {stats && !isSyncing && (
            <span className="text-xs text-slate-500 ml-1">
              ({stats.patients.count + stats.deliveries.count} records)
            </span>
          )}
        </button>

        {/* Expanded View */}
        <AnimatePresence>
          {isExpanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="border-t border-slate-200"
            >
              <div className="p-3 space-y-2">
                {stats && (
                  <>
                    <div className="text-xs space-y-1">
                      <div className="flex justify-between">
                        <span className="text-slate-600">Patients:</span>
                        <span className="font-medium">{stats.patients.count}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-600">Deliveries:</span>
                        <span className="font-medium">{stats.deliveries.count}</span>
                      </div>
                      {stats.pendingMutations > 0 && (
                        <div className="flex justify-between text-amber-600">
                          <span>Pending sync:</span>
                          <span className="font-medium">{stats.pendingMutations}</span>
                        </div>
                      )}
                    </div>
                    
                    {syncStatus.entity && syncStatus.status === 'syncing' && (
                      <div className="text-xs space-y-1">
                        <div className="flex justify-between text-blue-600">
                          <span>Syncing {syncStatus.entity}...</span>
                          <span>{syncStatus.progress || 0}%</span>
                        </div>
                        <div className="w-full bg-slate-200 rounded-full h-1.5">
                          <div 
                            className="bg-blue-500 h-1.5 rounded-full transition-all duration-300"
                            style={{ width: `${syncStatus.progress || 0}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </>
                )}

                <div className="space-y-1">
                  {stats?.pendingMutations > 0 && (
                    <Button
                      onClick={handleSyncMutations}
                      disabled={isSyncing}
                      size="sm"
                      variant="outline"
                      className="w-full text-xs"
                    >
                      <RefreshCw className={`w-3 h-3 mr-1 ${isSyncing ? 'animate-spin' : ''}`} />
                      Sync Changes ({stats.pendingMutations})
                    </Button>
                  )}
                  
                  <Button
                    onClick={handleForceSync}
                    disabled={isSyncing}
                    size="sm"
                    variant="outline"
                    className="w-full text-xs"
                  >
                    <RefreshCw className={`w-3 h-3 mr-1 ${isSyncing ? 'animate-spin' : ''}`} />
                    {isSyncing ? 'Syncing...' : 'Force Sync'}
                  </Button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}