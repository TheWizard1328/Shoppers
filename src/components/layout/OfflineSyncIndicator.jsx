import React, { useState, useEffect, useRef } from 'react';
import { RefreshCw, CheckCircle, AlertCircle, ChevronUp, ChevronDown, HardDrive, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { subscribeSyncStatus, getSyncStats, forceSyncAll } from '@/components/utils/offlineSync';
import { offlineDB } from '@/components/utils/offlineDatabase';
import { motion, AnimatePresence } from 'framer-motion';
import { useUser } from '@/components/utils/UserContext';
import { formatDistanceToNow, format } from 'date-fns';

/**
 * OfflineSyncIndicator
 *
 * Displays the current background-sync / offline-DB status in the sidebar.
 *
 * CRITICAL: This component must NOT poll IndexedDB while a sync is running.
 * A previous version mounted a 1500ms setInterval that called
 * offlineDB.getAll() for Deliveries + Patients + AppUsers + Cities on every
 * tick. Because IndexedDB is single-threaded per origin, those read
 * transactions contended with the background sync's write transactions,
 * stalling the writer and blocking the React main thread while materializing
 * 50k+ records per tick — producing the visible dashboard jitter whenever a
 * sync notification appeared.
 *
 * Fix: the manager already emits `{entity, count, progress}` through
 * subscribeSyncStatus, so the indicator derives its "Syncing: X (Y%)"
 * header purely from the syncStatus object it already receives. Stats are
 * refreshed exactly once when sync completes, and the idle stats-refresh
 * interval is now 5 minutes (was 30s) — it only freshens stale counts.
 */
export default function OfflineSyncIndicator({ embedded = false, inline = false, renderInline = false }) {
  const { currentUser } = useUser();

  // Single state object for whatever syncStatus tells us — one setState per
  // emit, one re-render per emit (was three separate setStates before).
  const [syncStatus, setSyncStatus] = useState({ status: 'idle' });
  const [stats, setStats] = useState(null);
  const [deliveryCounts, setDeliveryCounts] = useState({ past: 0, today: 0, future: 0 });
  const prevCountsRef = useRef(null); // snapshot before last sync started
  const [isExpanded, setIsExpanded] = useState(false);
  const [isHistoricalSyncing, setIsHistoricalSyncing] = useState(false);

  const isVisible = !!currentUser;
  const triggerRef = useRef(null);
  const [panelStyle, setPanelStyle] = useState({});

  const isSyncing = syncStatus.status === 'syncing' || syncStatus.status === 'force_syncing';

  // ── Cheap IDB reads — only on sync start / complete, never on a timer ──
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

    getSyncStats().then(s => setStats(s)).catch(() => {});
    getDeliveryCountsFromDB().then(counts => { prevCountsRef.current = counts; }).catch(() => {});

    // One state update per status emit — syncStatus carries entity / count /
    // progress directly, so the header renders from it without any IDB read.
    const unsubscribe = subscribeSyncStatus((status) => {
      setSyncStatus(status);

      if (status.status === 'syncing' || status.status === 'force_syncing') {
        if (!prevCountsRef.current) {
          getDeliveryCountsFromDB().then(c => { prevCountsRef.current = c; }).catch(() => {});
        }
      }
      if (status.status === 'complete' || status.status === 'synced') {
        // Refresh stats ONCE on completion — no polling during the sync.
        getSyncStats().then(newStats => setStats(newStats)).catch(() => {});
        refreshDeliveryCounts(true); // show delta since last sync
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
      const { entity, count, isComplete } = event.detail || {};
      setSyncStatus({ status: isComplete ? 'complete' : 'syncing', entity, count, progress: isComplete ? 100 : 50 });
      if (isComplete) {
        setTimeout(() => {
          getSyncStats().then(newStats => setStats(newStats)).catch(() => {});
        }, 300);
      }
    };

    const handleTriggerSyncNow = () => {
      if (!isSyncing) handleForceSync();
    };

    // Debounced stats refresh on realtime DB updates — fires at most once per
    // 500ms no matter how many entity-update events arrive in that window.
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

    // Idle stats refresh — 5 minutes (was 30s). This only freshens stale
    // snapshot counts; the live "syncing" state comes from syncStatus.
    const pollInterval = setInterval(handleRealtimeDBUpdate, 5 * 60 * 1000);

    const handleHistoricalProgress = (event) => {
      setIsHistoricalSyncing(event?.detail?.active === true);
    };
    window.addEventListener('historicalDeliverySyncProgress', handleHistoricalProgress);

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
      window.removeEventListener('historicalDeliverySyncProgress', handleHistoricalProgress);
    };
  }, [isVisible]);

  if (!isVisible) return null;

  const handleForceSync = async () => {
    try {
      setSyncStatus(prev => ({ ...prev, status: 'force_syncing' }));
      prevCountsRef.current = await getDeliveryCountsFromDB().catch(() => null);
      await forceSyncAll();
      const updatedStats = await getSyncStats();
      setStats(updatedStats);
      refreshDeliveryCounts(true); // show delta
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
      window.dispatchEvent(new CustomEvent('offlineSyncComplete'));
      window.dispatchEvent(new CustomEvent('driverLocationsUpdated', { detail: { appUsers: null } }));
    } catch (error) {
      console.error('❌ [OfflineSyncIndicator] Force sync failed:', error);
    } finally {
      setSyncStatus({ status: 'idle' });
    }
  };

  const getStatusColor = () => {
    if (isSyncing) return 'text-blue-500';
    if (isHistoricalSyncing) return 'text-blue-500';
    if (syncStatus.status === 'error') return 'text-red-500';
    if (syncStatus.status === 'synced' || syncStatus.status === 'complete') return 'text-green-500';
    return 'text-slate-500 dark:text-slate-400 dark:text-slate-500';
  };

  const getStatusTooltip = () => {
    if (isSyncing) return `Syncing: ${syncStatus.entity || '...'}${syncStatus.progress ? ` (${syncStatus.progress}%)` : ''}`;
    if (isHistoricalSyncing) return 'Historical delivery sync in progress';
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

  // Cached snapshot counts — no live polling. During sync the header shows
  // the entity + progress from syncStatus instead of record counts.
  const cachedCounts = {
    patients: stats?.patients?.count ?? 0,
    deliveries: stats?.deliveries?.count ?? 0,
    appUsers: stats?.appUsers?.count ?? 0,
    cities: stats?.cities?.count ?? 0,
    driverOverviewStats: stats?.driverOverviewStats?.count ?? 0,
    squareTransactions: stats?.squareTransactions?.count ?? 0,
  };

  const cachedLastSync = stats ? {
    patients: stats.patients?.lastSync,
    deliveries: stats.deliveries?.lastSync,
    appUsers: stats.appUsers?.lastSync,
    cities: stats.cities?.lastSync,
    driverOverviewStats: stats.driverOverviewStats?.lastSync || stats.deliveries?.lastSync,
    squareTransactions: stats.squareTransactions?.lastSync,
  } : null;

  const totalRecords = cachedCounts.patients + cachedCounts.deliveries + cachedCounts.appUsers + cachedCounts.cities + cachedCounts.driverOverviewStats;
  const shouldRenderStats = !!stats;

  const handleToggle = () => {
    if (!renderInline) {
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
      setPanelStyle({});
    }
    setIsExpanded(!isExpanded);
  };

  return (
    <div className="w-full relative">
      <button
        ref={triggerRef}
        onClick={handleToggle}
        className="flex items-center justify-between w-full px-3 py-2 rounded-lg transition-colors hover:bg-slate-50 dark:bg-slate-800 dark:hover:bg-slate-800">
        <div className="flex items-center gap-2">
          {getStatusIcon()}
          <div>
            <span className="text-xs font-medium text-secondary">
              {isSyncing ? 'Syncing...' : 'Offline DB'}
            </span>
            <span className="text-xs text-muted">
              ({totalRecords})
            </span>
            <div className="text-[10px] font-mono" style={{ color: 'var(--text-slate-400)' }}>
              {isSyncing
                ? `Syncing… ${syncStatus.entity || '...'}${syncStatus.progress ? ` (${syncStatus.progress}%)` : ''}`
                : `Synced: ${deliveryCounts.past}/${deliveryCounts.today}/${deliveryCounts.future}`}
            </div>
          </div>
        </div>
        {isExpanded ? <ChevronUp className="w-4 h-4 text-slate-400 dark:text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400 dark:text-slate-400" />}
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
                        <span className="font-medium text-secondary">Users</span>
                      </div>
                      <div className="flex items-center gap-1 text-[10px] text-muted">
                        <Clock className="w-3 h-3" />
                        <span>{formatLastSync(cachedLastSync.appUsers)}</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-bold text-body">{cachedCounts.appUsers}</div>
                      {stats.fullSyncStatus?.appUsers?.completed && <CheckCircle className="w-3 h-3 text-green-500 ml-auto mt-0.5" />}
                    </div>
                  </div>

                  {stats.cities &&
                    <div className="flex items-start justify-between p-2 rounded-md" style={{ background: 'var(--bg-slate-50)' }}>
                      <div className="flex-1">
                        <div className="flex items-center gap-1 mb-1">
                          <span>{getEntityIcon('cities')}</span>
                          <span className="font-medium text-secondary">Cities</span>
                        </div>
                        <div className="flex items-center gap-1 text-[10px] text-muted">
                          <Clock className="w-3 h-3" />
                          <span>{formatLastSync(cachedLastSync.cities)}</span>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-bold text-body">{cachedCounts.cities}</div>
                        {stats.fullSyncStatus?.cities?.completed && <CheckCircle className="w-3 h-3 text-green-500 ml-auto mt-0.5" />}
                      </div>
                    </div>
                  }

                  <div className="px-2 py-1 rounded-md flex items-start justify-between" style={{ background: 'var(--bg-slate-50)' }}>
                    <div className="flex-1">
                      <div className="flex items-center gap-1 mb-1">
                        <span>{getEntityIcon('patients')}</span>
                        <span className="font-medium text-secondary">Patients</span>
                      </div>
                      <div className="flex items-center gap-1 text-[10px] text-muted">
                        <Clock className="w-3 h-3" />
                        <span>{formatLastSync(cachedLastSync.patients)}</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-bold text-body">{cachedCounts.patients}</div>
                      {stats.fullSyncStatus?.patients?.completed && <CheckCircle className="w-3 h-3 text-green-500 ml-auto mt-0.5" />}
                    </div>
                  </div>

                  <div className="px-2 py-1 rounded-md flex items-start justify-between" style={{ background: 'var(--bg-slate-50)' }}>
                    <div className="flex-1">
                      <div className="flex items-center gap-1 mb-1">
                        <span>{getEntityIcon('deliveries')}</span>
                        <span className="font-medium text-secondary">Deliveries / Stats</span>
                      </div>
                      <div className="flex items-center gap-1 text-[10px] text-muted">
                        <Clock className="w-3 h-3" />
                        <span>{formatLastSync(cachedLastSync.deliveries)}</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-bold text-body">{cachedCounts.deliveries} / {cachedCounts.driverOverviewStats}</div>
                      {stats.fullSyncStatus?.deliveries?.completed && <CheckCircle className="w-3 h-3 text-green-500 ml-auto mt-0.5" />}
                    </div>
                  </div>

                  {stats.squareTransactions &&
                    <div className="flex items-start justify-between p-2 rounded-md" style={{ background: 'var(--bg-slate-50)' }}>
                      <div className="flex-1">
                        <div className="flex items-center gap-1 mb-1">
                          <span>{getEntityIcon('squareTransactions')}</span>
                          <span className="font-medium text-secondary">Square TX</span>
                        </div>
                        <div className="flex items-center gap-1 text-[10px] text-muted">
                          <Clock className="w-3 h-3" />
                          <span>{formatLastSync(cachedLastSync.squareTransactions)}</span>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-bold text-body">{cachedCounts.squareTransactions}</div>
                        {stats.fullSyncStatus?.squareTransactions?.completed && <CheckCircle className="w-3 h-3 text-green-500 ml-auto mt-0.5" />}
                      </div>
                    </div>
                  }

                  {stats.pendingMutations > 0 &&
                    <div className="flex items-center justify-between p-2 rounded-md bg-amber-50 dark:bg-amber-950 border border-amber-200">
                      <span className="text-amber-700 font-medium">Pending sync:</span>
                      <span className="font-bold text-amber-900">{stats.pendingMutations}</span>
                    </div>
                  }
                </div>

                {isSyncing &&
                  <div className="text-xs space-y-1 p-2 rounded-md bg-blue-50 dark:bg-blue-950 border border-blue-200">
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
 className="w-full text-xs font-medium text-body bg-card"
 data-offline-sync-button
 style={{ borderColor: 'var(--border-slate-300)' }}>
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