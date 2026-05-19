import React, { useState, useEffect } from 'react';
import { RefreshCw, CheckCircle, AlertCircle, ChevronUp, ChevronDown, HardDrive, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { subscribeSyncStatus, getSyncStats, manualSyncSelected } from '@/components/utils/offlineSync';
import { motion, AnimatePresence } from 'framer-motion';
import { useUser } from '@/components/utils/UserContext';
import { formatDistanceToNow } from 'date-fns';

export default function OfflineSyncIndicator({ embedded = false, inline = false }) {
  const { currentUser } = useUser();
  const [syncStatus, setSyncStatus] = useState({ status: 'idle' });
  const [stats, setStats] = useState(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [runtimeStats, setRuntimeStats] = useState({});

  const isVisible = !!currentUser;

  useEffect(() => {
    if (!isVisible) return;

    getSyncStats().then(stats => {
      setStats(stats);
    }).catch(() => {});

    const unsubscribe = subscribeSyncStatus((status) => {
      setSyncStatus(status);
      setIsSyncing(status.status === 'syncing' || status.status === 'force_syncing');

      if (status.entity && status.count !== undefined) {
        setRuntimeStats(prev => ({ ...prev, [status.entity.toLowerCase()]: status.count }));
      }

      if (status.status === 'complete' || status.status === 'synced') {
        getSyncStats().then(newStats => {
          setStats(newStats);
          setRuntimeStats({});
        }).catch(() => {});
      }

      const relevantEntities = ['Deliveries', 'Patients', 'AppUsers', 'Cities'];
      if (status.entity && relevantEntities.includes(status.entity)) {
        if (status.entity === 'Deliveries' || status.entity === 'Patients') {
          window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
        }
        if (status.entity === 'AppUsers') {
          window.dispatchEvent(new CustomEvent('driverLocationsUpdated', { detail: { appUsers: null } }));
        }
      }
    });

    const handlePeriodicSync = (event) => {
      const { entity, count, isComplete } = event.detail;
      setIsSyncing(true);
      setSyncStatus({ status: 'syncing', entity, count, progress: isComplete ? 100 : 50 });
      setRuntimeStats(prev => ({ ...prev, [entity.toLowerCase()]: count }));
      if (isComplete) {
        setTimeout(() => {
          getSyncStats().then(newStats => {
            setStats(newStats);
            setRuntimeStats({});
            setIsSyncing(false);
          }).catch(() => { setIsSyncing(false); });
        }, 300);
      }
    };

    const handleTriggerSyncNow = () => {
      if (!isSyncing) handleForceSync();
    };

    let refreshDebounceTimer = null;
    const handleRealtimeDBUpdate = () => {
      clearTimeout(refreshDebounceTimer);
      refreshDebounceTimer = setTimeout(() => {
        getSyncStats().then(newStats => setStats(newStats)).catch(() => {});
      }, 500);
    };

    window.addEventListener('periodicSyncProgress', handlePeriodicSync);
    window.addEventListener('triggerOfflineSyncNow', handleTriggerSyncNow);
    window.addEventListener('realtimeUpdate_AppUser', handleRealtimeDBUpdate);
    window.addEventListener('realtimeUpdate_Delivery', handleRealtimeDBUpdate);
    window.addEventListener('realtimeUpdate_Patient', handleRealtimeDBUpdate);
    window.addEventListener('offlineSyncComplete', handleRealtimeDBUpdate);
    window.addEventListener('deliveriesUpdated', handleRealtimeDBUpdate);

    const pollInterval = setInterval(handleRealtimeDBUpdate, 30000);

    return () => {
      unsubscribe();
      clearTimeout(refreshDebounceTimer);
      clearInterval(pollInterval);
      window.removeEventListener('periodicSyncProgress', handlePeriodicSync);
      window.removeEventListener('triggerOfflineSyncNow', handleTriggerSyncNow);
      window.removeEventListener('realtimeUpdate_AppUser', handleRealtimeDBUpdate);
      window.removeEventListener('realtimeUpdate_Delivery', handleRealtimeDBUpdate);
      window.removeEventListener('realtimeUpdate_Patient', handleRealtimeDBUpdate);
      window.removeEventListener('offlineSyncComplete', handleRealtimeDBUpdate);
      window.removeEventListener('deliveriesUpdated', handleRealtimeDBUpdate);
    };
  }, [isVisible]);

  if (!isVisible) return null;

  const handleForceSync = async () => {
    try {
      setIsSyncing(true);
      const { offlineDB } = await import('../utils/offlineDatabase');
      const { globalFilters } = await import('../utils/globalFilters');
      const dateForSync = sessionStorage.getItem('rxdeliver_selected_date') || new Date().toISOString().split('T')[0];
      const selectedCityId = globalFilters?.getSelectedCityId?.();
      await manualSyncSelected(dateForSync, selectedCityId);
      await new Promise(resolve => setTimeout(resolve, 500));
      const updatedStats = await getSyncStats();
      setStats(updatedStats);
      setRuntimeStats({});
      await new Promise(resolve => setTimeout(resolve, 500));
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
      window.dispatchEvent(new CustomEvent('offlineSyncComplete'));
      const freshDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, dateForSync);
      if (freshDeliveries && freshDeliveries.length > 0) {
        window.dispatchEvent(new CustomEvent('deliveriesImported', {
          detail: { source: 'manual_sync', deliveries: freshDeliveries }
        }));
      }
      window.dispatchEvent(new CustomEvent('driverLocationsUpdated', { detail: { appUsers: null } }));
    } catch (error) {
      console.error('❌ [OfflineSyncIndicator] Force sync failed:', error);
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
    return <HardDrive className={`w-4 h-4 ${getStatusColor()}`} />;
  };

  const formatLastSync = (lastSync) => {
    if (!lastSync || lastSync === 'Never') return 'Never';
    try { return formatDistanceToNow(new Date(lastSync), { addSuffix: true }); }
    catch { return 'Unknown'; }
  };

  const getEntityIcon = (entityName) => {
    if (entityName === 'patients' || entityName === 'Patients') return '👥';
    if (entityName === 'deliveries' || entityName === 'Deliveries') return '📦';
    if (entityName === 'appUsers' || entityName === 'AppUsers') return '👤';
    if (entityName === 'cities' || entityName === 'Cities') return '🏙️';
    if (entityName === 'squareTransactions' || entityName === 'Square Transactions') return '💳';
    return '📊';
  };

  const liveCounts = stats ? {
    patients: stats.patients?.count ?? 0,
    deliveries: stats.deliveries?.count ?? 0,
    appUsers: stats.appUsers?.count ?? 0,
    cities: stats.cities?.count ?? 0,
    driverOverviewStats: stats.driverOverviewStats?.count ?? 0,
    squareTransactions: stats.squareTransactions?.count ?? 0,
  } : null;

  const liveLastSync = stats ? {
    patients: stats.patients?.lastSync,
    deliveries: stats.deliveries?.lastSync,
    appUsers: stats.appUsers?.lastSync,
    cities: stats.cities?.lastSync,
    driverOverviewStats: stats.driverOverviewStats?.lastSync || stats.deliveries?.lastSync,
    squareTransactions: stats.squareTransactions?.lastSync,
  } : null;

  const liveTotalRecords = liveCounts
    ? liveCounts.patients + liveCounts.deliveries + liveCounts.appUsers + liveCounts.cities + liveCounts.driverOverviewStats
    : 0;

  const shouldRenderStats = !!stats;

  return (
    <div className="w-full">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center justify-between w-full px-3 py-2 rounded-lg transition-colors hover:bg-slate-50">
        <div className="flex items-center gap-2">
          {getStatusIcon()}
          <div>
            <span className="text-xs font-medium" style={{ color: 'var(--text-slate-700)' }}>
              {isSyncing ? 'Syncing...' : 'Offline DB'}
            </span>
            {shouldRenderStats &&
              <span className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
                ({liveTotalRecords})
              </span>
            }
            <div className="text-[10px] font-mono" style={{ color: 'var(--text-slate-400)' }}>rxdeliver_persistent_offline_v2</div>
          </div>
        </div>
        {isExpanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
      </button>

      <AnimatePresence>
        {isExpanded &&
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden">
            <div className="px-1 py-1 space-y-1 border-t border-slate-200">
              {shouldRenderStats && <>
                <div className="text-xs space-y-0">
                  <div className="px-2 py-1 rounded-md flex items-start justify-between" style={{ background: 'var(--bg-slate-50)' }}>
                    <div className="flex-1">
                      <div className="flex items-center gap-1 mb-1">
                        <span>{getEntityIcon('appUsers')}</span>
                        <span className="font-medium" style={{ color: 'var(--text-slate-700)' }}>Users</span>
                      </div>
                      <div className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-slate-500)' }}>
                        <Clock className="w-3 h-3" />
                        <span>{formatLastSync(liveLastSync.appUsers)}</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-bold" style={{ color: 'var(--text-slate-900)' }}>{liveCounts.appUsers}</div>
                      {stats.fullSyncStatus?.appUsers?.completed && <CheckCircle className="w-3 h-3 text-green-500 ml-auto mt-0.5" />}
                    </div>
                  </div>

                  {stats.cities &&
                    <div className="flex items-start justify-between p-2 rounded-md" style={{ background: 'var(--bg-slate-50)' }}>
                      <div className="flex-1">
                        <div className="flex items-center gap-1 mb-1">
                          <span>{getEntityIcon('cities')}</span>
                          <span className="font-medium" style={{ color: 'var(--text-slate-700)' }}>Cities</span>
                        </div>
                        <div className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-slate-500)' }}>
                          <Clock className="w-3 h-3" />
                          <span>{formatLastSync(liveLastSync.cities)}</span>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-bold" style={{ color: 'var(--text-slate-900)' }}>{liveCounts.cities}</div>
                        {stats.fullSyncStatus?.cities?.completed && <CheckCircle className="w-3 h-3 text-green-500 ml-auto mt-0.5" />}
                      </div>
                    </div>
                  }

                  <div className="px-2 py-1 rounded-md flex items-start justify-between" style={{ background: 'var(--bg-slate-50)' }}>
                    <div className="flex-1">
                      <div className="flex items-center gap-1 mb-1">
                        <span>{getEntityIcon('patients')}</span>
                        <span className="font-medium" style={{ color: 'var(--text-slate-700)' }}>Patients</span>
                      </div>
                      <div className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-slate-500)' }}>
                        <Clock className="w-3 h-3" />
                        <span>{formatLastSync(liveLastSync.patients)}</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-bold" style={{ color: 'var(--text-slate-900)' }}>{liveCounts.patients}</div>
                      {stats.fullSyncStatus?.patients?.completed && <CheckCircle className="w-3 h-3 text-green-500 ml-auto mt-0.5" />}
                    </div>
                  </div>

                  <div className="px-2 py-1 rounded-md flex items-start justify-between" style={{ background: 'var(--bg-slate-50)' }}>
                    <div className="flex-1">
                      <div className="flex items-center gap-1 mb-1">
                        <span>{getEntityIcon('deliveries')}</span>
                        <span className="font-medium" style={{ color: 'var(--text-slate-700)' }}>Deliveries / Stats</span>
                      </div>
                      <div className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-slate-500)' }}>
                        <Clock className="w-3 h-3" />
                        <span>{formatLastSync(liveLastSync.deliveries)}</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-bold" style={{ color: 'var(--text-slate-900)' }}>{liveCounts.deliveries} / {liveCounts.driverOverviewStats}</div>
                      {stats.fullSyncStatus?.deliveries?.completed && <CheckCircle className="w-3 h-3 text-green-500 ml-auto mt-0.5" />}
                    </div>
                  </div>

                  {stats.squareTransactions &&
                    <div className="flex items-start justify-between p-2 rounded-md" style={{ background: 'var(--bg-slate-50)' }}>
                      <div className="flex-1">
                        <div className="flex items-center gap-1 mb-1">
                          <span>{getEntityIcon('squareTransactions')}</span>
                          <span className="font-medium" style={{ color: 'var(--text-slate-700)' }}>Square TX</span>
                        </div>
                        <div className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-slate-500)' }}>
                          <Clock className="w-3 h-3" />
                          <span>{formatLastSync(liveLastSync.squareTransactions)}</span>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-bold" style={{ color: 'var(--text-slate-900)' }}>{liveCounts.squareTransactions}</div>
                        {stats.fullSyncStatus?.squareTransactions?.completed && <CheckCircle className="w-3 h-3 text-green-500 ml-auto mt-0.5" />}
                      </div>
                    </div>
                  }

                  {stats.pendingMutations > 0 &&
                    <div className="flex items-center justify-between p-2 rounded-md bg-amber-50 border border-amber-200">
                      <span className="text-amber-700 font-medium">Pending sync:</span>
                      <span className="font-bold text-amber-900">{stats.pendingMutations}</span>
                    </div>
                  }
                </div>

                {isSyncing &&
                  <div className="text-xs space-y-1 p-2 rounded-md bg-blue-50 border border-blue-200">
                    <div className="flex justify-between text-blue-700">
                      <span className="font-medium">
                        {getEntityIcon(syncStatus.entity)} {syncStatus.entity || 'Loading'}
                        {syncStatus.count ? ` (${syncStatus.count})` : ''}
                      </span>
                      <span className="font-bold">{syncStatus.progress || 0}%</span>
                    </div>
                    <div className="w-full rounded-full h-2 bg-blue-100">
                      <div
                        className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                        style={{ width: `${syncStatus.progress || 0}%` }} />
                    </div>
                  </div>
                }
              </>}

              <Button
                onClick={handleForceSync}
                disabled={isSyncing}
                size="sm"
                variant="outline"
                className="w-full text-xs font-medium"
                data-offline-sync-button
                style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                <RefreshCw className={`w-3 h-3 mr-1.5 ${isSyncing ? 'animate-spin' : ''}`} />
                {isSyncing ? 'Syncing...' : 'Manual Sync'}
              </Button>
            </div>
          </motion.div>
        }
      </AnimatePresence>
    </div>
  );
}