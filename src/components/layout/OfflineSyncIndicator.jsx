import React, { useState, useEffect, useRef } from 'react';
import { RefreshCw, CheckCircle, AlertCircle, ChevronUp, ChevronDown, HardDrive, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { subscribeSyncStatus, getSyncStats, forceSyncAll } from '@/components/utils/offlineSync';
import { offlineDB } from '@/components/utils/offlineDatabase';
import { motion, AnimatePresence } from 'framer-motion';
import { useUser } from '@/components/utils/UserContext';
import { formatDistanceToNow, format } from 'date-fns';

export default function OfflineSyncIndicator({ embedded = false, inline = false, renderInline = false }) {
  const { currentUser } = useUser();
  const [syncStatus, setSyncStatus] = useState({ status: 'idle' });
  const [stats, setStats] = useState(null);
  const [deliveryCounts, setDeliveryCounts] = useState({ past: 0, today: 0, future: 0 });
  const prevCountsRef = useRef(null); // snapshot before last sync started
  const [isExpanded, setIsExpanded] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [runtimeStats, setRuntimeStats] = useState({});
  const [liveCachedCounts, setLiveCachedCounts] = useState(null);
  const liveCountPollRef = useRef(null);

  const isVisible = !!currentUser;
  const triggerRef = useRef(null);
  const [panelStyle, setPanelStyle] = useState({});

  const pollLiveDBCounts = async () => {
    try {
      const [deliveries, patients, appUsers, cities] = await Promise.all([
        offlineDB.getAll(offlineDB.STORES.DELIVERIES),
        offlineDB.getAll(offlineDB.STORES.PATIENTS),
        offlineDB.getAll(offlineDB.STORES.APP_USERS),
        offlineDB.getAll(offlineDB.STORES.CITIES),
      ]);
      const todayStr = format(new Date(), 'yyyy-MM-dd');
      let past = 0, today = 0, future = 0;
      (deliveries || []).forEach(d => {
        if (!d?.delivery_date) return;
        if (d.delivery_date < todayStr) past++;
        else if (d.delivery_date === todayStr) today++;
        else future++;
      });
      setLiveCachedCounts({
        deliveries: (deliveries || []).length,
        patients: (patients || []).length,
        appUsers: (appUsers || []).length,
        cities: (cities || []).length,
        deliveryBreakdown: { past, today, future },
      });
    } catch (_) {}
  };

  const startLivePolling = () => {
    if (liveCountPollRef.current) return;
    liveCountPollRef.current = setInterval(pollLiveDBCounts, 1500);
    pollLiveDBCounts();
  };

  const stopLivePolling = () => {
    if (liveCountPollRef.current) {
      clearInterval(liveCountPollRef.current);
      liveCountPollRef.current = null;
    }
  };

  const getDeliveryCountsFromDB = async () => {
    const todayStr = format(new Date(), 'yyyy-MM-dd');
    const all = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
    let past = 0, today = 0, future = 0;
    (all || []).forEach(d => {
      if (!d?.delivery_date) return;
      if (d.delivery_date < todayStr) past++;
      else if (d.delivery_date === todayStr) today++;
      else future++;
    });
    return { past, today, future };
  };

  const refreshDeliveryCounts = async (isPostSync = false) => {
    try {
      const current = await getDeliveryCountsFromDB();
      const prev = prevCountsRef.current;
      if (isPostSync && prev) {
        setDeliveryCounts({
          past: Math.max(0, current.past - prev.past),
          today: Math.max(0, current.today - prev.today),
          future: Math.max(0, current.future - prev.future),
        });
      } else if (!isPostSync) {
        // Snapshot current state before the next sync starts
        prevCountsRef.current = current;
        setDeliveryCounts({ past: 0, today: 0, future: 0 });
      }
    } catch (_) {}
  };

  useEffect(() => {
    if (!isVisible) return;

    getSyncStats().then(stats => {
      setStats(stats);
    }).catch(() => {});
    // On mount: snapshot current counts (delta will be computed after next sync)
    getDeliveryCountsFromDB().then(counts => { prevCountsRef.current = counts; }).catch(() => {});

    const unsubscribe = subscribeSyncStatus((status) => {
      setSyncStatus(status);
      setIsSyncing(status.status === 'syncing' || status.status === 'force_syncing');

      if (status.entity && status.count !== undefined) {
        setRuntimeStats(prev => ({ ...prev, [status.entity.toLowerCase()]: status.count }));
      }

      if (status.status === 'syncing' || status.status === 'force_syncing') {
        // Snapshot before sync so we can compute delta when done
        if (!prevCountsRef.current) {
          getDeliveryCountsFromDB().then(counts => { prevCountsRef.current = counts; }).catch(() => {});
        }
        startLivePolling();
      }
      if (status.status === 'complete' || status.status === 'synced') {
        stopLivePolling();
        getSyncStats().then(newStats => {
          setStats(newStats);
          setRuntimeStats({});
        }).catch(() => {});
        refreshDeliveryCounts(true); // show delta since last sync
        pollLiveDBCounts(); // final count update
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
      stopLivePolling();
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
      prevCountsRef.current = await getDeliveryCountsFromDB().catch(() => null);
      await forceSyncAll();
      const updatedStats = await getSyncStats();
      setStats(updatedStats);
      setRuntimeStats({});
      refreshDeliveryCounts(true); // show delta
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
      window.dispatchEvent(new CustomEvent('offlineSyncComplete'));
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

  const getStatusTooltip = () => {
    if (isSyncing) return `Syncing: ${syncStatus.entity || '...'}${syncStatus.progress ? ` (${syncStatus.progress}%)` : ''}`;
    if (syncStatus.status === 'error') return `Error: ${syncStatus.error || 'Sync failed'}`;
    if (syncStatus.status === 'synced' || syncStatus.status === 'complete') return 'Sync complete';
    return 'Offline DB';
  };

  const getStatusIcon = () => {
    const tooltip = getStatusTooltip();
    if (isSyncing) return <RefreshCw title={tooltip} className={`w-4 h-4 animate-spin ${getStatusColor()}`} />;
    if (syncStatus.status === 'error') return <AlertCircle title={tooltip} className={`w-4 h-4 ${getStatusColor()}`} />;
    if (syncStatus.status === 'synced' || syncStatus.status === 'complete') return <CheckCircle title={tooltip} className={`w-4 h-4 ${getStatusColor()}`} />;
    return <HardDrive title={tooltip} className={`w-4 h-4 ${getStatusColor()}`} />;
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

  // During syncs: use live-polled DB counts; otherwise fall back to stats snapshot
  const liveCounts = {
    patients: (isSyncing && liveCachedCounts) ? liveCachedCounts.patients : (stats?.patients?.count ?? 0),
    deliveries: (isSyncing && liveCachedCounts) ? liveCachedCounts.deliveries : (stats?.deliveries?.count ?? 0),
    appUsers: (isSyncing && liveCachedCounts) ? liveCachedCounts.appUsers : (stats?.appUsers?.count ?? 0),
    cities: (isSyncing && liveCachedCounts) ? liveCachedCounts.cities : (stats?.cities?.count ?? 0),
    driverOverviewStats: stats?.driverOverviewStats?.count ?? 0,
    squareTransactions: stats?.squareTransactions?.count ?? 0,
  };

  const liveLastSync = stats ? {
    patients: stats.patients?.lastSync,
    deliveries: stats.deliveries?.lastSync,
    appUsers: stats.appUsers?.lastSync,
    cities: stats.cities?.lastSync,
    driverOverviewStats: stats.driverOverviewStats?.lastSync || stats.deliveries?.lastSync,
    squareTransactions: stats.squareTransactions?.lastSync,
  } : null;

  const liveTotalRecords = liveCounts.patients + liveCounts.deliveries + liveCounts.appUsers + liveCounts.cities + liveCounts.driverOverviewStats;

  const shouldRenderStats = !!stats || !!liveCachedCounts;

  const handleToggle = () => {
    if (!renderInline) {
      // Floating mode: position:absolute relative to this wrapper div
      setPanelStyle({
        position: 'absolute',
        top: '100%',
        left: 0,
        marginTop: '4px',
        width: '240px',
        zIndex: 10050,
        background: 'var(--bg-white)',
        border: '1px solid var(--border-slate-200)',
        borderRadius: '12px',
        boxShadow: '0 8px 24px rgba(15,23,42,0.12)'
      });
    } else {
      // Inline/accordion mode: no positioning — panel renders in normal flow below button
      setPanelStyle({});
    }
    setIsExpanded(!isExpanded);
  };

  return (
    <div className="w-full relative">
      <button
        ref={triggerRef}
        onClick={handleToggle}
        className="flex items-center justify-between w-full px-3 py-2 rounded-lg transition-colors hover:bg-slate-50">
        <div className="flex items-center gap-2">
          {getStatusIcon()}
          <div>
            <span className="text-xs font-medium" style={{ color: 'var(--text-slate-700)' }}>
              {isSyncing ? 'Syncing...' : 'Offline DB'}
            </span>
            <span className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
              ({liveTotalRecords})
            </span>
            <div className="text-[10px] font-mono" style={{ color: 'var(--text-slate-400)' }}>
              {isSyncing && liveCachedCounts
                ? `📦 ${liveCachedCounts.deliveries} · 👥 ${liveCachedCounts.patients}`
                : `Synced: ${deliveryCounts.past}/${deliveryCounts.today}/${deliveryCounts.future}`
              }
            </div>
          </div>
        </div>
        {isExpanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
      </button>

      <AnimatePresence>
        {isExpanded &&
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            style={renderInline ? {
              marginTop: '4px',
              background: 'var(--bg-white)',
              border: '1px solid var(--border-slate-200)',
              borderRadius: '12px',
            } : panelStyle}>
            <div className="px-1 py-1 space-y-1">
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
                {isSyncing ? 'Syncing...' : 'Force Sync All'}
              </Button>
            </div>
          </motion.div>
        }
      </AnimatePresence>
    </div>
  );
}