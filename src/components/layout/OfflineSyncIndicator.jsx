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

  const isVisible = currentUser && isAppOwner(currentUser);

  useEffect(() => {
    if (!isVisible) return;
    // Load initial stats
    getSyncStats().then(setStats);

    // Subscribe to sync updates
    const unsubscribe = subscribeSyncStatus((status) => {
      setSyncStatus(status);
      setIsSyncing(status.status === 'syncing' || status.status === 'force_syncing');

      // Refresh stats in real-time during sync AND when complete
      if (status.status === 'syncing' || status.status === 'force_syncing' || status.status === 'complete' || status.status === 'synced') {
        getSyncStats().then(setStats);
        
        // CRITICAL: Update UI in real-time if syncing entities relevant to current screen
        const relevantEntities = ['Deliveries', 'Patients', 'AppUsers', 'Cities'];
        if (status.entity && relevantEntities.includes(status.entity)) {
          console.log(`🔄 [OfflineSyncIndicator] ${status.entity} synced - updating UI`);
          
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
      const { offlineDB } = await import('../utils/offlineDatabase');

      // CRITICAL: Check which dates are missing from offline DB
      console.log('📋 [Manual Sync] Analyzing offline DB for missing dates...');
      
      // Get all deliveries from API (last 90 days) and compare with offline DB
      const today = new Date();
      const ninetyDaysAgo = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);
      
      // Get offline deliveries to check what we have
      const offlineDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES) || [];
      const offlineDates = new Set(offlineDeliveries.map(d => d?.delivery_date).filter(Boolean));
      
      console.log(`💾 [Manual Sync] Offline DB has ${offlineDates.size} unique delivery dates`);
      
      // Fetch metadata from API to find which dates have deliveries
      // We'll fetch ALL deliveries for the range to find what's missing
      let allApiDeliveries = [];
      try {
        allApiDeliveries = await base44.entities.Delivery.filter(
          {
            delivery_date: {
              $gte: ninetyDaysAgo.toISOString().split('T')[0],
              $lte: today.toISOString().split('T')[0]
            }
          },
          '-delivery_date',
          10000
        );
        
        console.log(`📥 [Manual Sync] API has ${allApiDeliveries.length} total deliveries in last 90 days`);
        
        // Find unique dates on API
        const apiDates = new Set(allApiDeliveries.map(d => d?.delivery_date).filter(Boolean));
        
        // Find missing dates
        const missingDates = Array.from(apiDates).filter(date => !offlineDates.has(date)).sort();
        
        console.log(`🔍 [Manual Sync] Found ${missingDates.length} dates with missing deliveries`);
        
        if (missingDates.length > 0) {
          console.log(`📅 [Manual Sync] Syncing missing dates: ${missingDates.slice(0, 5).join(', ')}${missingDates.length > 5 ? '...' : ''}`);
          
          // Sync missing dates gradually (one per second to avoid rate limits)
          let synced = 0;
          for (const dateStr of missingDates) {
            try {
              const dateDeliveries = await base44.entities.Delivery.filter({ delivery_date: dateStr }, '-delivery_date', 1000);
              if (dateDeliveries && dateDeliveries.length > 0) {
                await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, dateDeliveries);
                synced++;
                console.log(`✅ [Manual Sync] Synced ${dateDeliveries.length} deliveries for ${dateStr}`);
              }
              
              // Slow rate limit protection - 1 second between requests
              if (synced < missingDates.length) {
                await new Promise(r => setTimeout(r, 1000));
              }
            } catch (dateError) {
              console.warn(`⚠️ [Manual Sync] Error syncing ${dateStr}:`, dateError.message);
              // If rate limited, wait longer
              if (dateError.response?.status === 429 || dateError.message?.includes('429')) {
                console.log('⏰ [Manual Sync] Rate limited - waiting 30 seconds before retry');
                await new Promise(r => setTimeout(r, 30000));
              }
            }
          }
          
          console.log(`✅ [Manual Sync] Complete - synced ${synced} dates with missing deliveries`);
        } else {
          console.log('✅ [Manual Sync] All dates already synced - offline DB is up to date');
        }
        
      } catch (apiError) {
        console.warn('⚠️ [Manual Sync] Error checking API deliveries:', apiError.message);
        // Fall back to standard sync
        await forceSyncAll();
      }
      
      // Get updated stats
      const updatedStats = await getSyncStats();
      setStats(updatedStats);

      console.log('✅ [OfflineSyncIndicator] Manual sync complete - refreshing UI');
      
      // Wait for offline DB to update
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Refresh delivery stats
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
      window.dispatchEvent(new CustomEvent('offlineSyncComplete'));
      
      // Load fresh deliveries for current date
      const selectedDateStr = sessionStorage.getItem('rxdeliver_selected_date') || 
                             new Date().toISOString().split('T')[0];
      
      const freshDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr);
      
      if (freshDeliveries && freshDeliveries.length > 0) {
        console.log(`📦 [Manual Sync] Triggering deliveriesImported event with ${freshDeliveries.length} deliveries`);
        window.dispatchEvent(new CustomEvent('deliveriesImported', {
          detail: { source: 'manual_sync', deliveries: freshDeliveries }
        }));
      }
      
      window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
        detail: { appUsers: null }
      }));
      
    } catch (error) {
      console.error('Force sync failed:', error);
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