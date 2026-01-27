import React, { useState, useEffect } from 'react';
import { RefreshCw, CheckCircle, AlertCircle, ChevronUp, ChevronDown, HardDrive, Clock, Database } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { subscribeSyncStatus, getSyncStats, forceSyncAll } from '@/components/utils/offlineSync';
import { motion, AnimatePresence } from 'framer-motion';
import { useUser } from '@/components/utils/UserContext';
import { isAppOwner } from '@/components/utils/userRoles';
import { formatDistanceToNow } from 'date-fns';

export default function OfflineSyncIndicator({ embedded = false, inline = false }) {
  const { currentUser } = useUser();
  const [syncStatus, setSyncStatus] = useState({ status: 'idle' });
  const [stats, setStats] = useState(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [runtimeStats, setRuntimeStats] = useState({});

  const isVisible = currentUser && isAppOwner(currentUser);

  useEffect(() => {
    if (!isVisible) return;
    // Load initial stats
    getSyncStats().then(setStats);

    // Subscribe to sync updates
    const unsubscribe = subscribeSyncStatus((status) => {
      setSyncStatus(status);
      setIsSyncing(status.status === 'syncing' || status.status === 'force_syncing');

      // CRITICAL: Update runtime stats with entity count during sync
      if (status.entity && status.count !== undefined) {
        setRuntimeStats(prev => ({
          ...prev,
          [status.entity.toLowerCase()]: status.count
        }));
        console.log(`🔄 [OfflineSyncIndicator] ${status.entity} syncing - count: ${status.count} (progress: ${status.progress || 0}%)`);
      }
      
      // CRITICAL: Refresh stats on sync complete
      if (status.status === 'complete' || status.status === 'synced') {
        getSyncStats().then(newStats => {
          setStats(newStats);
          setRuntimeStats({}); // Clear runtime stats when sync completes
        });
      }
      
      // CRITICAL: Update UI in real-time if syncing entities relevant to current screen
      const relevantEntities = ['Deliveries', 'Patients', 'AppUsers', 'Cities'];
      if (status.entity && relevantEntities.includes(status.entity)) {
        // Trigger partial UI refresh for relevant data
        if (status.entity === 'Deliveries' || status.entity === 'Patients') {
          window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
        }
        
        if (status.entity === 'AppUsers') {
          window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
            detail: { appUsers: null }
          }));
        }
      }
    });

    return unsubscribe;
  }, [isVisible]);

  // Only show to app owners - MUST be after all hooks
  if (!isVisible) {
    return null;
  }

  const handleForceSync = async () => {
    try {
      setIsSyncing(true);
      console.log('🔄 [OfflineSyncIndicator] Starting manual sync...');

      // DON'T clear the offline DB - just force a fresh sync from API
      // Clearing causes data loss if the sync fails
      const syncResult = await forceSyncAll();
      console.log('✅ [OfflineSyncIndicator] forceSyncAll complete:', syncResult);
      
      // Wait for DB to settle
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const updatedStats = await getSyncStats();
      console.log('📊 [OfflineSyncIndicator] Updated stats:', updatedStats);
      setStats(updatedStats);

      // Wait for UI to update before dispatching events
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Refresh delivery stats
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
      
      // Force data refresh on Dashboard/current screen
      window.dispatchEvent(new CustomEvent('offlineSyncComplete'));
      
      // Load fresh deliveries and trigger delivery update event
      const selectedDateStr = sessionStorage.getItem('rxdeliver_selected_date') || 
                             new Date().toISOString().split('T')[0];
      
      const { offlineDB } = await import('../utils/offlineDatabase');
      const freshDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr);
      
      if (freshDeliveries && freshDeliveries.length > 0) {
        console.log(`📦 [OfflineSyncIndicator] Triggering deliveriesImported with ${freshDeliveries.length} deliveries`);
        window.dispatchEvent(new CustomEvent('deliveriesImported', {
          detail: { source: 'manual_sync', deliveries: freshDeliveries }
        }));
      }
      
      // Trigger driver locations update to refresh map markers
      window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
        detail: { appUsers: null }
      }));
      
      console.log('✅ [OfflineSyncIndicator] Manual sync complete - all events dispatched');
      
    } catch (error) {
      console.error('❌ [OfflineSyncIndicator] Force sync failed:', error);
      console.error('   Error message:', error.message);
      console.error('   Stack:', error.stack);
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
    try {
      return formatDistanceToNow(new Date(lastSync), { addSuffix: true });
    } catch {
      return 'Unknown';
    }
  };

  const getEntityIcon = (entityName) => {
    if (entityName === 'patients' || entityName === 'Patients') return '👥';
    if (entityName === 'deliveries' || entityName === 'Deliveries') return '📦';
    if (entityName === 'appUsers' || entityName === 'AppUsers') return '👤';
    if (entityName === 'cities' || entityName === 'Cities') return '🏙️';
    if (entityName === 'squareTransactions' || entityName === 'Square Transactions') return '💳';
    return '📊';
  };

  // Inline mode for stats card (mobile) or upper-left (desktop)
  if (embedded || inline) {
    return (
      <div className="w-full">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center justify-between w-full px-3 py-2 rounded-lg transition-colors hover:bg-slate-50">

          <div className="flex items-center gap-2">
            {getStatusIcon()}
            <span className="text-xs font-medium" style={{ color: 'var(--text-slate-700)' }}>
              {isSyncing ? 'Syncing...' : 'Offline DB'}
            </span>
            {stats && !isSyncing &&
            <span className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
                ({stats.patients.count + stats.deliveries.count + stats.appUsers.count + (stats.cities?.count || 0) + (stats.driverOverviewStats?.count || 0)})
              </span>
            }
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
                {stats &&
              <>
                    <div className="text-xs space-y-0">
                      {/* Patients */}
                      <div className="px-2 py-1 rounded-md flex items-start justify-between" style={{ background: 'var(--bg-slate-50)' }}>
                        <div className="flex-1">
                          <div className="flex items-center gap-1 mb-1">
                            <span>{getEntityIcon('patients')}</span>
                            <span className="font-medium" style={{ color: 'var(--text-slate-700)' }}>Patients</span>
                          </div>
                          <div className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-slate-500)' }}>
                            <Clock className="w-3 h-3" />
                            <span>{formatLastSync(runtimeStats.patients ? undefined : stats.patients.lastSync)}</span>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-bold" style={{ color: 'var(--text-slate-900)' }}>{runtimeStats.patients !== undefined ? runtimeStats.patients : stats.patients.count}</div>
                          {stats.fullSyncStatus?.patients?.completed &&
                      <CheckCircle className="w-3 h-3 text-green-500 ml-auto mt-0.5" />
                      }
                        </div>
                      </div>

                      {/* Deliveries - Mobile: single row, Desktop: split into 2 rows */}
                      <div className="hidden md:block">
                        {/* Desktop: 2 rows */}
                        <div className="px-2 py-1 rounded-md flex items-start justify-between" style={{ background: 'var(--bg-slate-50)' }}>
                          <div className="flex-1">
                            <div className="flex items-center gap-1 mb-1">
                              <span>{getEntityIcon('deliveries')}</span>
                              <span className="font-medium" style={{ color: 'var(--text-slate-700)' }}>Deliveries</span>
                            </div>
                            <div className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-slate-500)' }}>
                              <Clock className="w-3 h-3" />
                              <span>{formatLastSync(runtimeStats.deliveries !== undefined ? undefined : stats.deliveries.lastSync)}</span>
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="font-bold" style={{ color: 'var(--text-slate-900)' }}>{runtimeStats.deliveries !== undefined ? runtimeStats.deliveries : stats.deliveries.count}</div>
                            {stats.fullSyncStatus?.deliveries?.completed &&
                        <CheckCircle className="w-3 h-3 text-green-500 ml-auto mt-0.5" />
                        }
                          </div>
                        </div>
                        <div className="px-2 py-1 rounded-md flex items-start justify-between mt-1" style={{ background: 'var(--bg-slate-50)' }}>
                          <div className="flex-1">
                            <div className="flex items-center gap-1 mb-1">
                              <span>📊</span>
                              <span className="font-medium" style={{ color: 'var(--text-slate-700)' }}>Stats</span>
                            </div>
                            <div className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-slate-500)' }}>
                              <Clock className="w-3 h-3" />
                              <span>{formatLastSync(stats.driverOverviewStats?.lastSync || stats.deliveries.lastSync)}</span>
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="font-bold" style={{ color: 'var(--text-slate-900)' }}>{stats.driverOverviewStats?.count || 0}</div>
                          </div>
                        </div>
                      </div>
                      {/* Mobile: single row */}
                      <div className="md:hidden px-2 py-1 rounded-md flex items-start justify-between" style={{ background: 'var(--bg-slate-50)' }}>
                        <div className="flex-1">
                          <div className="flex items-center gap-1 mb-1">
                            <span>{getEntityIcon('deliveries')}</span>
                            <span className="font-medium" style={{ color: 'var(--text-slate-700)' }}>Deliveries / Stats</span>
                          </div>
                          <div className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-slate-500)' }}>
                            <Clock className="w-3 h-3" />
                            <span>{formatLastSync(stats.deliveries.lastSync)}</span>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-bold" style={{ color: 'var(--text-slate-900)' }}>{stats.deliveries.count} / {stats.driverOverviewStats?.count || 0}</div>
                          {stats.fullSyncStatus?.deliveries?.completed &&
                      <CheckCircle className="w-3 h-3 text-green-500 ml-auto mt-0.5" />
                      }
                        </div>
                      </div>

                      {/* AppUsers */}
                      <div className="px-2 py-1 rounded-md flex items-start justify-between" style={{ background: 'var(--bg-slate-50)' }}>
                        <div className="flex-1">
                          <div className="flex items-center gap-1 mb-1">
                            <span>{getEntityIcon('appUsers')}</span>
                            <span className="font-medium" style={{ color: 'var(--text-slate-700)' }}>Users</span>
                          </div>
                          <div className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-slate-500)' }}>
                            <Clock className="w-3 h-3" />
                            <span>{formatLastSync(runtimeStats.appusers !== undefined ? undefined : stats.appUsers.lastSync)}</span>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-bold" style={{ color: 'var(--text-slate-900)' }}>{runtimeStats.appusers !== undefined ? runtimeStats.appusers : stats.appUsers.count}</div>
                          {stats.fullSyncStatus?.appUsers?.completed &&
                      <CheckCircle className="w-3 h-3 text-green-500 ml-auto mt-0.5" />
                      }
                        </div>
                      </div>

                      {/* Cities */}
                      {stats.cities &&
                  <div className="flex items-start justify-between p-2 rounded-md" style={{ background: 'var(--bg-slate-50)' }}>
                          <div className="flex-1">
                            <div className="flex items-center gap-1 mb-1">
                              <span>{getEntityIcon('cities')}</span>
                              <span className="font-medium" style={{ color: 'var(--text-slate-700)' }}>Cities</span>
                            </div>
                            <div className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-slate-500)' }}>
                              <Clock className="w-3 h-3" />
                              <span>{formatLastSync(stats.cities.lastSync)}</span>
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="font-bold" style={{ color: 'var(--text-slate-900)' }}>{stats.cities.count}</div>
                            {stats.fullSyncStatus?.cities?.completed &&
                      <CheckCircle className="w-3 h-3 text-green-500 ml-auto mt-0.5" />
                      }
                          </div>
                        </div>
                  }

                      {/* Square Transactions */}
                      {stats.squareTransactions &&
                  <div className="flex items-start justify-between p-2 rounded-md" style={{ background: 'var(--bg-slate-50)' }}>
                          <div className="flex-1">
                            <div className="flex items-center gap-1 mb-1">
                              <span>{getEntityIcon('squareTransactions')}</span>
                              <span className="font-medium" style={{ color: 'var(--text-slate-700)' }}>Square TX</span>
                            </div>
                            <div className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-slate-500)' }}>
                              <Clock className="w-3 h-3" />
                              <span>{formatLastSync(stats.squareTransactions.lastSync)}</span>
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="font-bold" style={{ color: 'var(--text-slate-900)' }}>{stats.squareTransactions.count}</div>
                            {stats.fullSyncStatus?.squareTransactions?.completed &&
                      <CheckCircle className="w-3 h-3 text-green-500 ml-auto mt-0.5" />
                      }
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
                  </>
              }

                <Button
                onClick={handleForceSync}
                disabled={isSyncing}
                size="sm"
                variant="outline"
                className="w-full text-xs font-medium"
                style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>

                  <RefreshCw className={`w-3 h-3 mr-1.5 ${isSyncing ? 'animate-spin' : ''}`} />
                  {isSyncing ? 'Syncing...' : 'Manual Sync'}
                </Button>
              </div>
            </motion.div>
          }
        </AnimatePresence>
      </div>);

  }

  // Floating mode for map (desktop)
  return (
    <div className="fixed top-2 left-1 z-[100000]">
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-lg shadow-lg border overflow-hidden"
        style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>

        {/* Collapsed View */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-2 px-3 py-2 transition-colors w-full hover:bg-slate-50"
          style={{
            background: 'var(--bg-white)',
            color: 'var(--text-slate-700)'
          }}>

          {getStatusIcon()}
          <span className="text-xs font-medium" style={{ color: 'var(--text-slate-700)' }}>
            {isSyncing ? 'Syncing...' : 'Offline DB'}
          </span>
          {stats && !isSyncing &&
          <span className="text-xs ml-1" style={{ color: 'var(--text-slate-500)' }}>
              ({stats.patients.count + stats.deliveries.count + stats.appUsers.count + (stats.cities?.count || 0) + (stats.driverOverviewStats?.count || 0)} records)
            </span>
          }
        </button>

        {/* Expanded View */}
        <AnimatePresence>
          {isExpanded &&
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="border-t"
            style={{ borderColor: 'var(--border-slate-200)' }}>

              <div className="p-3 space-y-3">
                {stats &&
              <>
                    <div className="text-xs space-y-2">
                      {/* Patients */}
                      <div className="flex items-start justify-between p-2 rounded-md" style={{ background: 'var(--bg-slate-50)' }}>
                        <div className="flex-1">
                          <div className="flex items-center gap-1 mb-1">
                            <span>{getEntityIcon('patients')}</span>
                            <span className="font-medium" style={{ color: 'var(--text-slate-700)' }}>Patients</span>
                          </div>
                          <div className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-slate-500)' }}>
                            <Clock className="w-3 h-3" />
                            <span>{formatLastSync(stats.patients.lastSync)}</span>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-bold" style={{ color: 'var(--text-slate-900)' }}>{stats.patients.count}</div>
                          {stats.fullSyncStatus?.patients?.completed &&
                      <CheckCircle className="w-3 h-3 text-green-500 ml-auto mt-0.5" />
                      }
                        </div>
                      </div>

                      {/* Deliveries - Desktop: 2 rows, Mobile: 1 row */}
                      <div className="hidden md:block">
                        {/* Desktop: 2 rows */}
                        <div className="flex items-start justify-between p-2 rounded-md" style={{ background: 'var(--bg-slate-50)' }}>
                          <div className="flex-1">
                            <div className="flex items-center gap-1 mb-1">
                              <span>{getEntityIcon('deliveries')}</span>
                              <span className="font-medium" style={{ color: 'var(--text-slate-700)' }}>Deliveries</span>
                            </div>
                            <div className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-slate-500)' }}>
                              <Clock className="w-3 h-3" />
                              <span>{formatLastSync(stats.deliveries.lastSync)}</span>
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="font-bold" style={{ color: 'var(--text-slate-900)' }}>{stats.deliveries.count}</div>
                            {stats.fullSyncStatus?.deliveries?.completed &&
                        <CheckCircle className="w-3 h-3 text-green-500 ml-auto mt-0.5" />
                        }
                          </div>
                        </div>
                        <div className="flex items-start justify-between p-2 rounded-md mt-2" style={{ background: 'var(--bg-slate-50)' }}>
                          <div className="flex-1">
                            <div className="flex items-center gap-1 mb-1">
                              <span>📊</span>
                              <span className="font-medium" style={{ color: 'var(--text-slate-700)' }}>Stats</span>
                            </div>
                            <div className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-slate-500)' }}>
                              <Clock className="w-3 h-3" />
                              <span>{formatLastSync(stats.driverOverviewStats?.lastSync || stats.deliveries.lastSync)}</span>
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="font-bold" style={{ color: 'var(--text-slate-900)' }}>{stats.driverOverviewStats?.count || 0}</div>
                          </div>
                        </div>
                      </div>
                      {/* Mobile: single row */}
                      <div className="md:hidden flex items-start justify-between p-2 rounded-md" style={{ background: 'var(--bg-slate-50)' }}>
                        <div className="flex-1">
                          <div className="flex items-center gap-1 mb-1">
                            <span>{getEntityIcon('deliveries')}</span>
                            <span className="font-medium" style={{ color: 'var(--text-slate-700)' }}>Deliveries / Stats</span>
                          </div>
                          <div className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-slate-500)' }}>
                            <Clock className="w-3 h-3" />
                            <span>{formatLastSync(stats.deliveries.lastSync)}</span>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-bold" style={{ color: 'var(--text-slate-900)' }}>{stats.deliveries.count} / {stats.driverOverviewStats?.count || 0}</div>
                          {stats.fullSyncStatus?.deliveries?.completed &&
                      <CheckCircle className="w-3 h-3 text-green-500 ml-auto mt-0.5" />
                      }
                        </div>
                      </div>

                      {/* AppUsers */}
                      <div className="flex items-start justify-between p-2 rounded-md" style={{ background: 'var(--bg-slate-50)' }}>
                        <div className="flex-1">
                          <div className="flex items-center gap-1 mb-1">
                            <span>{getEntityIcon('appUsers')}</span>
                            <span className="font-medium" style={{ color: 'var(--text-slate-700)' }}>Users</span>
                          </div>
                          <div className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-slate-500)' }}>
                            <Clock className="w-3 h-3" />
                            <span>{formatLastSync(stats.appUsers.lastSync)}</span>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-bold" style={{ color: 'var(--text-slate-900)' }}>{stats.appUsers.count}</div>
                          {stats.fullSyncStatus?.appUsers?.completed &&
                      <CheckCircle className="w-3 h-3 text-green-500 ml-auto mt-0.5" />
                      }
                        </div>
                      </div>

                      {/* Cities */}
                      {stats.cities &&
                  <div className="flex items-start justify-between p-2 rounded-md" style={{ background: 'var(--bg-slate-50)' }}>
                          <div className="flex-1">
                            <div className="flex items-center gap-1 mb-1">
                              <span>{getEntityIcon('cities')}</span>
                              <span className="font-medium" style={{ color: 'var(--text-slate-700)' }}>Cities</span>
                            </div>
                            <div className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-slate-500)' }}>
                              <Clock className="w-3 h-3" />
                              <span>{formatLastSync(stats.cities.lastSync)}</span>
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="font-bold" style={{ color: 'var(--text-slate-900)' }}>{stats.cities.count}</div>
                            {stats.fullSyncStatus?.cities?.completed &&
                      <CheckCircle className="w-3 h-3 text-green-500 ml-auto mt-0.5" />
                      }
                          </div>
                        </div>
                  }

                      {/* Square Transactions */}
                      {stats.squareTransactions &&
                  <div className="flex items-start justify-between p-2 rounded-md" style={{ background: 'var(--bg-slate-50)' }}>
                          <div className="flex-1">
                            <div className="flex items-center gap-1 mb-1">
                              <span>{getEntityIcon('squareTransactions')}</span>
                              <span className="font-medium" style={{ color: 'var(--text-slate-700)' }}>Square TX</span>
                            </div>
                            <div className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-slate-500)' }}>
                              <Clock className="w-3 h-3" />
                              <span>{formatLastSync(stats.squareTransactions.lastSync)}</span>
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="font-bold" style={{ color: 'var(--text-slate-900)' }}>{stats.squareTransactions.count}</div>
                            {stats.fullSyncStatus?.squareTransactions?.completed &&
                      <CheckCircle className="w-3 h-3 text-green-500 ml-auto mt-0.5" />
                      }
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
                  </>
              }

                <Button
                onClick={handleForceSync}
                disabled={isSyncing}
                size="sm"
                variant="outline"
                className="w-full text-xs font-medium">

                  <RefreshCw className={`w-3 h-3 mr-1.5 ${isSyncing ? 'animate-spin' : ''}`} />
                  {isSyncing ? 'Syncing...' : 'Manual Sync'}
                </Button>
              </div>
            </motion.div>
          }
        </AnimatePresence>
      </motion.div>
    </div>);

}