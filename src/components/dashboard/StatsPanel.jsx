import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Calendar as CalendarIcon, Clock, Truck, Plus, ChevronUp, ChevronDown, Settings, Sparkles, Binoculars } from "lucide-react";
import { format } from 'date-fns';
import { globalFilters } from "@/components/utils/globalFilters";
import { base44 } from "@/api/base44Client";
import { offlineDB } from "@/components/utils/offlineDatabase";
import { isAppOwner } from '@/components/utils/userRoles';
import { driverLocationPoller } from "@/components/utils/driverLocationPoller";
import { smartRefreshManager } from "@/components/utils/smartRefreshManager";
import SmartRefreshIndicator from "@/components/layout/SmartRefreshIndicator";
import ConnectionIndicator from "@/components/dashboard/ConnectionIndicator";
import ErrorFlagIndicator from "@/components/dashboard/ErrorFlagIndicator";
import DashboardOfflineSync from '@/components/dashboard/DashboardOfflineSync';
import ActivePayStats from '@/components/dashboard/ActivePayStats';
import PullToSync from '@/components/dashboard/PullToSync';
import DriverLocationBadge from '@/components/dashboard/DriverLocationBadge';
import LocationTrackingToggle from "@/components/layout/LocationTrackingToggle";
import { saveSetting } from "@/components/utils/userSettingsManager";

export default function StatsPanel({
  currentUser, isDriver, isAdmin, isDispatcher,
  deliveries, drivers, stores, appUsers, driversList,
  selectedDate, selectedDateStr, selectedDriverId, calendarMonth, setCalendarMonth,
  isCalendarOpen, setIsCalendarOpen, handleDateChange, handleDriverChange,
  isDriverDropdownDisabled, isAllDriversMode, isDateFinished,
  showAllDriverMarkers, setShowAllDriverMarkers, showBreadcrumbs, setShowBreadcrumbs, setBreadcrumbsData,
  showRoutes, setShowRoutes, driverRoutes,
  statsCardRef, retractClustersRef,
  mapLockTimeoutRef, mapLockExpiresAtRef, lastProgrammaticMapMoveRef,
  setMapViewPhase, setIsMapViewLocked, setMapViewTrigger,
  statsPanelOpacity, isExpanded, setIsExpanded, areCardsVisible,
  handleStatsPanelInteraction, handleCardInteraction, isStatsCardCentered,
  statsCardPositioning, pullToSyncKey,
  setIsEntityUpdating, hasRateLimitError, updateDeliveriesLocally,
  setEditingDelivery, setShowDeliveryForm, setShowOptimizationSettings,
  setShowQuickAdjustments, setShowSmartPrioritization,
  deliveryStats, performanceStats, liveDistance, liveTimeOnDuty, isLoadingPayrollStats,
  dailyPolylineCount, stats, finalizedDutyTime,
  refreshUser, dataSource,
}) {
  return (
    <div className={statsCardPositioning} style={{ zIndex: 600 }}>
      <div className="flex flex-col items-center gap-1 min-w-[340px] max-w-[345px] relative"
        style={{ opacity: statsPanelOpacity, transition: 'opacity 0.5s ease-in-out' }}
        onMouseEnter={() => handleStatsPanelInteraction(true)}
        onMouseLeave={() => handleStatsPanelInteraction(false)}>

        <PullToSync
          key={pullToSyncKey}
          selectedDate={selectedDate}
          selectedCityId={globalFilters.getSelectedCityId()}
          selectedDriverId={selectedDriverId}
          showAllDriverMarkers={showAllDriverMarkers}
          statsCardRef={statsCardRef}
          onSyncComplete={async (freshDeliveries, freshPatients, freshAppUsers) => {
            if (updateDeliveriesLocally) {
              const otherDateDeliveries = deliveries.filter(d => d?.delivery_date !== selectedDateStr);
              updateDeliveriesLocally([...otherDateDeliveries, ...freshDeliveries], true);
            }
            const appUsersToProcess = (freshAppUsers && freshAppUsers.length > 0) ? freshAppUsers : appUsers;
            if (appUsersToProcess && appUsersToProcess.length > 0) {
              driverLocationPoller.processLocationData(currentUser, freshDeliveries, drivers, stores, appUsersToProcess, selectedDate, true, 'Dashboard', showAllDriverMarkers);
            }
            window.dispatchEvent(new CustomEvent('driverLocationsUpdated', { detail: { appUsers: freshAppUsers, forceAll: true } }));
            window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { deliveryDate: selectedDateStr, triggeredBy: 'pullToSyncComplete', allDrivers: true } }));
            setIsMapViewLocked(true);
            lastProgrammaticMapMoveRef.current = Date.now();
            window._lastProgrammaticMapMove = Date.now();
            setMapViewTrigger(prev => prev + 1);
            setTimeout(() => setIsMapViewLocked(false), 500);
            window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
            window.dispatchEvent(new CustomEvent('refreshPayrollStatsAfterSync'));
          }}
        />

        <motion.div
          ref={statsCardRef}
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          onMouseEnter={() => handleCardInteraction(true)}
          onMouseLeave={() => handleCardInteraction(false)}
          onClick={(e) => { e.stopPropagation(); handleCardInteraction(true); if (retractClustersRef.current) retractClustersRef.current(); }}
          className="px-2 py-0.5 rounded-2xl shadow-xl border min-w-[340px] max-w-[345px] cursor-pointer"
          style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', pointerEvents: 'auto', touchAction: 'none', position: 'relative' }}>

          <div className="mt-1 mb-2 flex items-center justify-between">
            <div className="pr-1 flex items-center gap-2">
              <h2 className="pl-2 text-lg font-bold" style={{ color: 'var(--text-slate-900)' }}>Dashboard</h2>
              {currentUser && <div className="flex items-center gap-1.5">
                <SmartRefreshIndicator inline={true} onManualRefresh={async () => {
                  const syncButton = document.querySelector('[data-offline-sync-button]');
                  if (syncButton) syncButton.click();
                }} />
                <ConnectionIndicator />
                <ErrorFlagIndicator />
              </div>}
            </div>

            <div className="flex items-center gap-3">
              <Popover open={isCalendarOpen} onOpenChange={(open) => { setIsCalendarOpen(open); if (open) setCalendarMonth(selectedDate); }} modal={true}>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="bg-transparent px-3 text-xs font-medium rounded-md inline-flex items-center justify-center whitespace-nowrap transition-colors shadow-sm gap-2 h-8" style={{ pointerEvents: 'auto', touchAction: 'manipulation', background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
                    <CalendarIcon className="w-3.5 h-3.5" />
                    <span className="text-sm">{format(selectedDate, 'EEE MMM dd')}</span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0 z-[10001]" align="end" style={{ pointerEvents: 'auto', background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
                  <Calendar
                    mode="single"
                    selected={selectedDate}
                    onSelect={(date) => {
                      if (!date) return;
                      if (format(date, 'yyyy-MM-dd') === format(selectedDate, 'yyyy-MM-dd')) { setIsCalendarOpen(false); return; }
                      handleDateChange(date);
                    }}
                    month={calendarMonth}
                    onMonthChange={setCalendarMonth}
                    footer={
                      <div className="px-3 pb-2 pt-1 border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
                        <TooltipProvider><Tooltip>
                          <TooltipTrigger asChild>
                            <button type="button" onClick={() => { const d = new Date(); setCalendarMonth(d); handleDateChange(d); }}
                              className="w-full flex items-center justify-center gap-1 p-1.5 rounded text-xs"
                              style={{ color: 'var(--text-slate-600)' }}
                              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-slate-100)'; e.currentTarget.style.color = 'var(--text-slate-800)'; }}
                              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-slate-600)'; }}>
                              <Clock className="w-3 h-3" />Today
                            </button>
                          </TooltipTrigger>
                          <TooltipContent><p>Go to today</p></TooltipContent>
                        </Tooltip></TooltipProvider>
                      </div>
                    }
                    className="rdp p-3" style={{ color: 'var(--text-slate-900)' }} />
                </PopoverContent>
              </Popover>

              <Button
                onClick={() => { setEditingDelivery(null); setShowDeliveryForm(true); }}
                size="sm"
                className={`h-8 w-8 p-0 transition-colors ${hasRateLimitError ? 'bg-red-500 hover:bg-red-600' : 'bg-emerald-500 hover:bg-emerald-600'}`}
                disabled={isDateFinished && !isAdmin}
                title={hasRateLimitError ? 'Rate limit detected - please wait' : 'Add delivery'}>
                <Plus className="w-4 h-4" />
              </Button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <ActivePayStats
              deliveryStats={deliveryStats}
              localStats={stats}
              isDispatcher={isDispatcher}
              isDriver={isDriver}
              performanceStats={performanceStats}
              liveDistance={liveDistance}
              liveTimeOnDuty={finalizedDutyTime ?? liveTimeOnDuty}
              isLoadingPayrollStats={isLoadingPayrollStats} />
            <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); setIsExpanded(!isExpanded); }} className="h-8 w-8 p-0 flex-shrink-0">
              {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </Button>
          </div>

          {isAppOwner(currentUser) && <DriverLocationBadge users={appUsers} />}

          <AnimatePresence>
            {isExpanded && <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
              <div className="mt-2 pt-2 pb-2 border-t flex items-center gap-2" style={{ borderColor: 'var(--border-slate-200)' }}>
                <Select value={selectedDriverId} onValueChange={handleDriverChange} disabled={isDriverDropdownDisabled}>
                  <SelectTrigger className="flex h-8 w-full items-center justify-between rounded-md border px-3 py-2 text-sm flex-1" style={{ pointerEvents: 'auto', touchAction: 'manipulation', background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                    <SelectValue placeholder="All Drivers" />
                  </SelectTrigger>
                  <SelectContent className="z-[10001]" style={{ pointerEvents: 'auto', background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
                    <SelectItem value="all" style={{ color: 'var(--text-slate-900)' }}>All Drivers</SelectItem>
                    {driversList.map(driver => (
                      <SelectItem key={driver.id} value={driver.id} style={{ color: driver._hasDispatcherStoreDeliveries ? '#047857' : 'var(--text-slate-900)', fontWeight: driver._hasDispatcherStoreDeliveries ? '700' : '400' }}>
                        {driver.user_name || driver.full_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {isDriver && !isAllDriversMode && (
                  <div className="flex items-center flex-shrink-0">
                    <div className="flex flex-col items-center gap-1">
                      <Button variant="outline" size="icon"
                        onClick={async () => {
                          const checked = !showAllDriverMarkers;
                          setShowAllDriverMarkers(checked);
                          if (currentUser?.id) saveSetting(currentUser.id, 'show_all_driver_markers', checked);
                          setIsExpanded(false);
                          if (checked) {
                            setIsEntityUpdating(true);
                            try {
                              const selDateStr = format(selectedDate, 'yyyy-MM-dd');
                              let allDateDeliveries;
                              if (dataSource === 'online') {
                                allDateDeliveries = await base44.entities.Delivery.filter({ delivery_date: selDateStr });
                                offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, allDateDeliveries).catch(() => {});
                              } else {
                                allDateDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selDateStr);
                                if (!allDateDeliveries || allDateDeliveries.length === 0) {
                                  allDateDeliveries = await base44.entities.Delivery.filter({ delivery_date: selDateStr });
                                  await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, allDateDeliveries);
                                }
                              }
                              if (updateDeliveriesLocally) {
                                const other = deliveries.filter(d => d && d.delivery_date !== selDateStr);
                                updateDeliveriesLocally([...other, ...allDateDeliveries], true);
                              }
                              await new Promise(r => setTimeout(r, 300));
                              const locUpdates = await smartRefreshManager.refreshDriverLocations(appUsers, true);
                              if (locUpdates?.hasChanges) driverLocationPoller.processLocationData(currentUser, allDateDeliveries, drivers, stores, locUpdates.appUsers, selectedDate);
                              const showAllLocUpdates = await smartRefreshManager.refreshDriverLocations(appUsers, true, 'Dashboard', selectedDate);
                              window.dispatchEvent(new CustomEvent('driverLocationsUpdated', { detail: { appUsers: showAllLocUpdates?.appUsers || appUsers, forceAll: true } }));
                            } catch (e) { console.error(e); } finally { setIsEntityUpdating(false); }
                          }
                          if (mapLockTimeoutRef.current) { clearTimeout(mapLockTimeoutRef.current); mapLockTimeoutRef.current = null; }
                          mapLockExpiresAtRef.current = null;
                          setMapViewPhase(1); setIsMapViewLocked(true);
                          lastProgrammaticMapMoveRef.current = Date.now(); window._lastProgrammaticMapMove = Date.now();
                          setMapViewTrigger(p => p + 1);
                          const lockDuration = 500; const expiresAt = Date.now() + lockDuration; mapLockExpiresAtRef.current = expiresAt;
                          mapLockTimeoutRef.current = setTimeout(() => { if (mapLockExpiresAtRef.current === expiresAt) { setIsMapViewLocked(false); mapLockExpiresAtRef.current = null; mapLockTimeoutRef.current = null; } }, lockDuration);
                        }}
                        className={`h-9 w-9 p-0 ${showAllDriverMarkers ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : ''}`}
                        style={!showAllDriverMarkers ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-700)' } : {}}>
                        <Binoculars className="w-4 h-4" />
                      </Button>
                    </div>

                    <div className="flex flex-col items-center gap-1">
                      <Button variant="outline" size="icon"
                        onClick={async () => {
                          const newShow = !showBreadcrumbs;
                          setShowBreadcrumbs(newShow);
                          if (newShow) {
                            try {
                              const selDateStr = format(selectedDate, 'yyyy-MM-dd');
                              const driverIdToFetch = selectedDriverId === 'all' ? currentUser?.id : selectedDriverId;
                              const historical = await base44.entities.DeliveryBreadcrumbs?.filter({ driver_id: driverIdToFetch, delivery_date: selDateStr }) || [];
                              let current = [];
                              try {
                                const all = await offlineDB.getByIndex(offlineDB.STORES.CURRENT_BREADCRUMBS, 'driver_id', driverIdToFetch);
                                current = all.filter(b => b && b.delivery_date === selDateStr).sort((a, b) => a.timestamp - b.timestamp);
                              } catch (e) {}
                              if (historical.length === 0 && current.length === 0) { setShowBreadcrumbs(false); return; }
                              setBreadcrumbsData({ historical, current });
                            } catch (e) { setBreadcrumbsData({ historical: [], current: [] }); }
                          } else { setBreadcrumbsData({ historical: [], current: [] }); }
                        }}
                        className={`h-9 w-9 p-0 ${showBreadcrumbs ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : ''}`}
                        style={!showBreadcrumbs ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-700)' } : {}}>
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <circle cx="8" cy="3" r="1.5" fill="currentColor" />
                          <circle cx="4" cy="8" r="1.5" fill="currentColor" />
                          <circle cx="12" cy="9" r="1.5" fill="currentColor" />
                          <circle cx="8" cy="13" r="1.5" fill="currentColor" />
                          <path d="M 8 3 Q 6 5, 4 8" stroke="currentColor" strokeWidth="1" fill="none" />
                          <path d="M 4 8 Q 8 8.5, 12 9" stroke="currentColor" strokeWidth="1" fill="none" />
                          <path d="M 12 9 Q 10 11, 8 13" stroke="currentColor" strokeWidth="1" fill="none" />
                        </svg>
                      </Button>
                    </div>
                  </div>
                )}

                <Button variant="outline" size="sm" onClick={() => setShowOptimizationSettings(true)} className="h-8 w-8 p-0 flex-shrink-0" title="Route Optimization Settings" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                  <Settings className="w-3.5 h-3.5" />
                </Button>

                <Button variant="default" size="sm" onClick={() => { setShowRoutes(!showRoutes); setIsExpanded(false); }} className="gap-2 h-8 flex-shrink-0 bg-emerald-600 hover:bg-emerald-700 text-white">
                  <Truck className="w-3.5 h-3.5" />{showRoutes ? 'Hide' : 'Show'}
                </Button>
              </div>

              {(isDriver && !isDispatcher) && <>
                <div className="border-t border-slate-200 mt-2 pt-2"></div>
                <div className="flex items-center gap-2">
                  <LocationTrackingToggle user={currentUser} onUserUpdate={async () => { await refreshUser(); }} />
                  {isDriver && <>
                    <Button variant="outline" size="sm" onClick={() => setShowQuickAdjustments(true)} className="h-8 gap-1.5 px-2 flex-shrink-0" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                      <span className="text-xs">Adjust</span>
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setShowSmartPrioritization(true)} className="h-8 gap-1.5 px-2 flex-shrink-0" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                      <Sparkles className="w-3 h-3" /><span className="text-xs">AI</span>
                    </Button>
                  </>}
                </div>
              </>}

              {isStatsCardCentered && <>
                <div className="border-t border-slate-200 mt-2 pt-2"></div>
                <DashboardOfflineSync currentUser={currentUser} dailyPolylineCount={dailyPolylineCount} isExpanded={isExpanded} />
              </>}
            </motion.div>}
          </AnimatePresence>
        </motion.div>

        {isAllDriversMode && driverRoutes.length > 0 &&
          <div className="backdrop-blur-sm rounded-lg shadow-lg border px-1 py-1" style={{ background: 'var(--bg-white)', opacity: 0.95, borderColor: 'var(--border-slate-200)' }}
            onMouseEnter={() => handleCardInteraction(true)} onMouseLeave={() => handleCardInteraction(false)}>
            <div className="flex flex-wrap gap-x-1 gap-y-1 items-center justify-center">
              {[...driverRoutes].sort((a, b) => (a.driverName || '').localeCompare(b.driverName || '')).map(route => (
                <div key={route.driverId} className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded-full border-2 border-white shadow-sm flex-shrink-0" style={{ backgroundColor: route.color }} />
                  <span className="text-xs font-medium whitespace-nowrap" style={{ color: 'var(--text-slate-700)' }}>{route.driverName || 'Unknown'}</span>
                  <span className="text-xs" style={{ color: 'var(--text-slate-500)' }}>({route.totalStops})</span>
                </div>
              ))}
            </div>
          </div>
        }
      </div>
    </div>
  );
}