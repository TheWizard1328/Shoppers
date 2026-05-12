import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Calendar as CalendarIcon, Clock, Truck, Plus, ChevronUp, ChevronDown, Settings, Binoculars, Map as MapIcon } from "lucide-react";
import TravelModeButton from '@/components/dashboard/TravelModeButton';
import { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { format } from 'date-fns';
import { globalFilters } from "@/components/utils/globalFilters";
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
import ExportRouteButton from '@/components/deliveries/ExportRouteButton';
import LocationTrackingToggle from "@/components/layout/LocationTrackingToggle";
import { saveSetting } from "@/components/utils/userSettingsManager";
import { getDriverColor } from "@/components/utils/driverUtils";
import { loadBreadcrumbsForDriver } from "@/components/utils/breadcrumbsManager";
import { sortUsers } from "@/components/utils/sorting";

export default function StatsPanel({
  currentUser, isDriver, isAdmin, isDispatcher,
  deliveries, filteredDeliveries, drivers, stores, appUsers, driversList,
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
  setShowQuickAdjustments,
  deliveryStats, performanceStats, liveDistance, liveTimeOnDuty, isLoadingPayrollStats,
  dailyPolylineCount, stats, finalizedDutyTime,
  refreshUser, dataSource,
  isMobile,
  preferredTravelMode,
  onTravelModeChange,
  mapStyle,
  setMapStyle
}) {
  const [legendDeliveries, setLegendDeliveries] = useState([]);
  const [isDemoModeActive, setIsDemoModeActive] = useState(false);
  const [showMapStyleOptions, setShowMapStyleOptions] = useState(false);

  useEffect(() => {
    let active = true;

    const loadDemoModeState = async () => {
      try {
        const me = await base44.auth.me();
        const rows = await base44.entities.DemoSettings.filter({ user_id: me.id });
        if (active) {
          setIsDemoModeActive(rows?.[0]?.is_demo_mode_active === true);
        }
      } catch {
        if (active) {
          setIsDemoModeActive(false);
        }
      }
    };

    loadDemoModeState();
    window.addEventListener('demoModeChanged', loadDemoModeState);

    return () => {
      active = false;
      window.removeEventListener('demoModeChanged', loadDemoModeState);
    };
  }, []);

  useEffect(() => {
    let active = true;

    const loadLegendDeliveries = async () => {
      const selectedCityId = globalFilters.getSelectedCityId();
      const cityStoreIds = new Set(
        (stores || []).filter((store) => store?.city_id === selectedCityId).map((store) => store.id)
      );
      const dispatcherStoreIds = new Set(isDispatcher ? currentUser?.store_ids || [] : []);

      const offlineDateDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr).catch(() => []);
      const sourceDeliveries = offlineDateDeliveries?.length > 0 ? offlineDateDeliveries : deliveries || [];
      const nextLegendDeliveries = sourceDeliveries.filter((delivery) => {
        if (!delivery || delivery.delivery_date !== selectedDateStr || !delivery.driver_id) return false;
        if (isDispatcher) return dispatcherStoreIds.has(delivery.store_id);
        return cityStoreIds.size === 0 || cityStoreIds.has(delivery.store_id);
      });

      if (active) {
        setLegendDeliveries(nextLegendDeliveries);
      }
    };

    loadLegendDeliveries();
    window.addEventListener('smartRefreshComplete', loadLegendDeliveries);
    window.addEventListener('deliveriesUpdated', loadLegendDeliveries);
    window.addEventListener('deliveriesImported', loadLegendDeliveries);

    return () => {
      active = false;
      window.removeEventListener('smartRefreshComplete', loadLegendDeliveries);
      window.removeEventListener('deliveriesUpdated', loadLegendDeliveries);
      window.removeEventListener('deliveriesImported', loadLegendDeliveries);
    };
  }, [selectedDateStr, stores, deliveries]);

  const legendData = (() => {
    if (!isAdmin && !isDispatcher) return [];

    const routeMap = new Map((driverRoutes || []).map((route) => [route.driverId, route]));
    const driverIdsWithStops = new Set(legendDeliveries.map((delivery) => delivery.driver_id));
    const finishedStatuses = new Set(['completed', 'failed', 'cancelled', 'returned']);

    return sortUsers(Array.from(driverIdsWithStops).map((driverId) => {
      const route = routeMap.get(driverId);
      const driverDeliveries = legendDeliveries.filter((delivery) => delivery.driver_id === driverId);
      const driverAppUser = (appUsers || []).find((appUser) => appUser?.user_id === driverId);
      const driverListUser = driversList.find((driver) => driver?.id === driverId);
      const driverName = route?.driverName || driverAppUser?.user_name || driverListUser?.user_name || driverListUser?.full_name || 'Unknown';
      const totalStops = driverDeliveries.filter((delivery) => {
        if (!delivery) return false;
        const isFinishedDelivery = !!delivery.patient_id && finishedStatuses.has(delivery.status);
        const isFinishedAfterHoursPickup = !delivery.patient_id && delivery.after_hours_pickup === true && finishedStatuses.has(delivery.status);
        return isFinishedDelivery || isFinishedAfterHoursPickup;
      }).length;
      const status = driverAppUser?.driver_status || 'offline';
      const heartbeatAgeMs = driverAppUser?.location_updated_at ? Date.now() - new Date(driverAppUser.location_updated_at).getTime() : Infinity;
      const hasHeartbeat = heartbeatAgeMs <= 120000;

      return {
        driverId,
        driverName,
        totalStops,
        color: route?.color || getDriverColor({ id: driverId, user_name: driverName }),
        driverStatus: status,
        hasHeartbeat,
        id: driverId,
        user_id: driverId,
        user_name: driverAppUser?.user_name || driverListUser?.user_name || driverListUser?.full_name || driverName,
        sort_order: driverAppUser?.sort_order ?? driverListUser?.sort_order
      };
    }));
  })();

  const getStatusColor = (status) => {
    if (status === 'on_duty' || status === 'online') return '#16a34a';
    if (status === 'on_break') return '#f97316';
    return '#dc2626';
  };

  const isDispatcherLockedExpanded = isDispatcher;
  const showExpandedContent = isDispatcherLockedExpanded || isExpanded;

  useEffect(() => {
    if (!showExpandedContent) {
      setShowMapStyleOptions(false);
    }
  }, [showExpandedContent]);

  // Auto-lock to polylines mode when route is finished
  useEffect(() => {
    if (isDateFinished && isDriver && !isAllDriversMode) {
      setShowBreadcrumbs(false);
      setBreadcrumbsData({ historical: [], current: [] });
      setShowRoutes(true);
    }
  }, [isDateFinished, isDriver, isAllDriversMode]);

  return (
    <div className={statsCardPositioning} style={{ zIndex: isMobile && isExpanded ? 40 : isMobile ? 100 : 600, position: 'absolute', pointerEvents: 'none' }}>
      <div className="flex flex-col items-center gap-1 min-w-[355px] max-w-[355px] relative"
      style={{ opacity: statsPanelOpacity, transition: 'opacity 0.5s ease-in-out', pointerEvents: 'auto' }}
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
            const syncedDeliveries = Array.isArray(freshDeliveries) ? freshDeliveries.filter(Boolean) : [];
            try {
              window.__selectedDashboardDate = selectedDateStr;
              window.__selectedDashboardDriverId = selectedDriverId;
            } catch (e) {}
            if (updateDeliveriesLocally && syncedDeliveries.length > 0) {
              const otherDateDeliveries = deliveries.filter((d) => d?.delivery_date !== selectedDateStr);
              updateDeliveriesLocally([...otherDateDeliveries, ...syncedDeliveries], true);
            }
            const appUsersToProcess = freshAppUsers && freshAppUsers.length > 0 ? freshAppUsers : appUsers;
            if (appUsersToProcess && appUsersToProcess.length > 0) {
              driverLocationPoller.processLocationData(currentUser, syncedDeliveries, drivers, stores, appUsersToProcess, selectedDate, true, 'Dashboard', showAllDriverMarkers);
            }
            window.dispatchEvent(new CustomEvent('driverLocationsUpdated', { detail: { appUsers: appUsersToProcess, forceAll: true } }));
            window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { deliveryDate: selectedDateStr, triggeredBy: 'pullToSyncComplete', allDrivers: true, freshDeliveries: syncedDeliveries, preserveLocalState: true } }));
            if ((window.__currentMapViewPhase ?? 1) === 1) {
              setIsMapViewLocked(true);
              lastProgrammaticMapMoveRef.current = Date.now();
              window._lastProgrammaticMapMove = Date.now();
              setMapViewTrigger((prev) => prev + 1);
              setTimeout(() => setIsMapViewLocked(false), 500);
            }
            window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
            window.dispatchEvent(new CustomEvent('refreshPayrollStatsAfterSync'));
          }} />
        

        <motion.div
          ref={statsCardRef}
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          onMouseEnter={() => handleCardInteraction(true)}
          onMouseLeave={() => handleCardInteraction(false)}
          onClick={(e) => {e.stopPropagation();handleCardInteraction(true);if (retractClustersRef.current) retractClustersRef.current();}} className="px-2 py-0.5 rounded-2xl shadow-xl border min-w-auto max-w-auto cursor-pointer"

          style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', pointerEvents: 'auto', touchAction: 'none', position: 'relative' }}>

          <div className="mb-0 flex items-center justify-between mt-0.25">
            <div className="pr-1 flex items-center gap-1">
              <h2 className="pl-2 text-lg font-bold" style={{ color: 'var(--text-slate-900)' }}>Dashboard</h2>
              {currentUser && <div className="flex items-center gap-1.5 ml-0">
                <SmartRefreshIndicator inline={true} onManualRefresh={async () => {
                  const syncButton = document.querySelector('[data-offline-sync-button]');
                  if (syncButton) syncButton.click();
                }} />
                <ConnectionIndicator />
                <ErrorFlagIndicator />
              </div>}
            </div>

            <div className="flex items-center gap-3">
              <Popover open={isCalendarOpen} onOpenChange={(open) => {setIsCalendarOpen(open);if (open) setCalendarMonth(selectedDate);}} modal={true}>
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
                      if (format(date, 'yyyy-MM-dd') === format(selectedDate, 'yyyy-MM-dd')) {setIsCalendarOpen(false);return;}
                      handleDateChange(date);
                    }}
                    month={calendarMonth}
                    onMonthChange={setCalendarMonth}
                    footer={
                    <div className="px-3 pb-2 pt-1 border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
                        <TooltipProvider><Tooltip>
                          <TooltipTrigger asChild>
                            <button type="button" onClick={() => {const d = new Date();setCalendarMonth(d);handleDateChange(d);}}
                            className="w-full flex items-center justify-center gap-1 p-1.5 rounded text-xs"
                            style={{ color: 'var(--text-slate-600)' }}
                            onMouseEnter={(e) => {e.currentTarget.style.background = 'var(--bg-slate-100)';e.currentTarget.style.color = 'var(--text-slate-800)';}}
                            onMouseLeave={(e) => {e.currentTarget.style.background = 'transparent';e.currentTarget.style.color = 'var(--text-slate-600)';}}>
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
                onClick={() => {setEditingDelivery(null);setShowDeliveryForm(true);}}
                size="sm"
                className={`relative h-8 w-8 p-0 transition-colors ${hasRateLimitError ? 'bg-red-500 hover:bg-red-600' : isDemoModeActive ? 'bg-blue-500 hover:bg-blue-600' : 'bg-emerald-500 hover:bg-emerald-600'}`}
                disabled={isDateFinished && !isAdmin}
                title={hasRateLimitError ? 'Rate limit detected - please wait' : isDemoModeActive ? 'Add demo delivery' : 'Add delivery'}>
                <Plus className="w-4 h-4" />
                {isDemoModeActive && !hasRateLimitError &&
                <span className="absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-white text-[8px] font-bold leading-none text-blue-600">
                    D
                  </span>
                }
              </Button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-1.5">
            <ActivePayStats
              deliveryStats={deliveryStats}
              localStats={stats}
              isDispatcher={isDispatcher}
              isDriver={isDriver}
              performanceStats={performanceStats}
              liveDistance={liveDistance}
              liveTimeOnDuty={finalizedDutyTime ?? liveTimeOnDuty}
              isLoadingPayrollStats={isLoadingPayrollStats} />
            {!isDispatcherLockedExpanded &&
            <Button variant="ghost" size="sm" onClick={(e) => {e.stopPropagation();setIsExpanded(!isExpanded);}} className="h-8 w-8 p-0 flex-shrink-0">
                {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </Button>
            }
          </div>

          <AnimatePresence>
            {showExpandedContent && <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
              <div className="pt-1 pb-1 border-t flex items-center gap-2" style={{ borderColor: 'var(--border-slate-200)' }}>
                <Select value={selectedDriverId} onValueChange={handleDriverChange} disabled={isDriverDropdownDisabled}>
                  <SelectTrigger className="flex h-8 w-full items-center justify-between rounded-md border px-3 py-2 text-sm flex-1" style={{ pointerEvents: 'auto', touchAction: 'manipulation', background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                    <SelectValue placeholder="All Drivers" />
                  </SelectTrigger>
                  <SelectContent className="z-[10001]" style={{ pointerEvents: 'auto', background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
                    <SelectItem value="all" style={{ color: 'var(--text-slate-900)' }}>All Drivers</SelectItem>
                    {driversList.map((driver) =>
                    <SelectItem key={driver.id} value={driver.id} style={{ color: driver._hasDispatcherStoreDeliveries ? '#047857' : 'var(--text-slate-900)', fontWeight: driver._hasDispatcherStoreDeliveries ? '700' : '400' }}>
                        {driver.user_name || driver.full_name}
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>

                {isDriver && !isAllDriversMode &&
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
                            const other = deliveries.filter((d) => d && d.delivery_date !== selDateStr);
                            updateDeliveriesLocally([...other, ...allDateDeliveries], true);
                          }
                          await new Promise((r) => setTimeout(r, 300));
                          const locUpdates = await smartRefreshManager.refreshDriverLocations(appUsers, true);
                          if (locUpdates?.hasChanges) driverLocationPoller.processLocationData(currentUser, allDateDeliveries, drivers, stores, locUpdates.appUsers, selectedDate);
                          const showAllLocUpdates = await smartRefreshManager.refreshDriverLocations(appUsers, true, 'Dashboard', selectedDate);
                          window.dispatchEvent(new CustomEvent('driverLocationsUpdated', { detail: { appUsers: showAllLocUpdates?.appUsers || appUsers, forceAll: true } }));
                        } catch (e) {console.error(e);} finally {setIsEntityUpdating(false);}
                      }
                      if (mapLockTimeoutRef.current) {clearTimeout(mapLockTimeoutRef.current);mapLockTimeoutRef.current = null;}
                      mapLockExpiresAtRef.current = null;
                      if (setMapViewPhase && setIsMapViewLocked && setMapViewTrigger) {
                        if (window.__fabFlashUpdate && (window.__currentMapViewPhase ?? 1) === 1) {
                          window.__fabFlashUpdate();
                          setIsMapViewLocked(true);
                          lastProgrammaticMapMoveRef.current = Date.now();window._lastProgrammaticMapMove = Date.now();
                          setMapViewTrigger((p) => p + 1);
                          const lockDuration = 500;const expiresAt = Date.now() + lockDuration;mapLockExpiresAtRef.current = expiresAt;
                          mapLockTimeoutRef.current = setTimeout(() => {if (mapLockExpiresAtRef.current === expiresAt) {setIsMapViewLocked(false);mapLockExpiresAtRef.current = null;mapLockTimeoutRef.current = null;}}, lockDuration);
                        }
                      }
                    }}
                    className={`h-9 w-9 p-0 ${showAllDriverMarkers ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : ''}`}
                    style={!showAllDriverMarkers ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-700)' } : {}}>
                        <Binoculars className="w-4 h-4" />
                      </Button>
                    </div>

                    <div className="flex flex-col items-center gap-1">
                      {/* Combined polylines/breadcrumbs toggle button */}
                      <Button variant="outline" size="icon"
                        disabled={isDateFinished}
                        title={isDateFinished ? 'Route complete — polylines locked' : showBreadcrumbs ? 'Breadcrumbs mode (click to turn off)' : showRoutes ? 'Polylines mode (click for breadcrumbs)' : 'Click to show polylines'}
                        onClick={async () => {
                          if (isDateFinished) return;
                          if (!showRoutes && !showBreadcrumbs) {
                            // Off → Polylines
                            setShowRoutes(true);
                            setShowBreadcrumbs(false);
                            setBreadcrumbsData({ historical: [], current: [] });
                          } else if (showRoutes && !showBreadcrumbs) {
                            // Polylines → Breadcrumbs
                            setShowRoutes(false);
                            try {
                              const selDateStr = format(selectedDate, 'yyyy-MM-dd');
                              const driverIdToFetch = selectedDriverId === 'all' ? currentUser?.id : selectedDriverId;
                              const loadedBreadcrumbs = await loadBreadcrumbsForDriver(driverIdToFetch, selDateStr, appUsers);
                              if (loadedBreadcrumbs.historical.length === 0 && loadedBreadcrumbs.current.length === 0) {
                                setShowBreadcrumbs(false);
                                setBreadcrumbsData({ historical: [], current: [] });
                                setShowRoutes(false);
                                return;
                              }
                              setBreadcrumbsData(loadedBreadcrumbs);
                              setShowBreadcrumbs(true);
                            } catch (e) {
                              setShowBreadcrumbs(false);
                              setBreadcrumbsData({ historical: [], current: [] });
                            }
                          } else {
                            // Breadcrumbs → Off
                            setShowBreadcrumbs(false);
                            setBreadcrumbsData({ historical: [], current: [] });
                            setShowRoutes(false);
                          }
                        }}
                        className={`h-9 w-9 p-0 text-white ${
                          isDateFinished
                            ? 'bg-blue-600 hover:bg-blue-600 opacity-70 cursor-not-allowed'
                            : showBreadcrumbs
                              ? 'bg-emerald-600 hover:bg-emerald-700'
                              : showRoutes
                                ? 'bg-blue-600 hover:bg-blue-700'
                                : 'text-slate-700'
                        }`}
                        style={!showRoutes && !showBreadcrumbs && !isDateFinished ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-700)' } : {}}>
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
                }

                {isDispatcherLockedExpanded && <div className="flex-1 min-w-[120px]" />}

                {!isDispatcherLockedExpanded &&
                <Button variant="outline" size="sm" onClick={() => setShowOptimizationSettings(true)} className="h-8 w-8 p-0 flex-shrink-0" title="Route Optimization Settings" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                    <Settings className="w-3.5 h-3.5" />
                  </Button>
                }

                {isDriver && !isAllDriversMode &&
                <TravelModeButton
                  currentUser={currentUser}
                  appUsers={appUsers}
                  value={preferredTravelMode}
                  onChange={onTravelModeChange}
                  selectedDriverId={selectedDriverId} />
                }

                {!(isDriver && !isDispatcher) &&
                <Button variant="default" size="sm" onClick={() => {
                  const nextShowRoutes = !showRoutes;
                  setShowRoutes(nextShowRoutes);
                  if (nextShowRoutes) {
                    setShowBreadcrumbs(false);
                    setBreadcrumbsData({ historical: [], current: [] });
                  }
                  setIsExpanded(false);
                }} className={`gap-2 h-8 flex-shrink-0 ${showRoutes ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700'} text-white`}>
                  <Truck className="w-3.5 h-3.5" />{showRoutes ? 'Hide' : 'Show'}
                </Button>
                }
              </div>

              {isDriver && !isDispatcher && <>
                <div className="pt-1 border-t border-slate-200"></div>
                <div className="flex items-center gap-1">
                  <LocationTrackingToggle user={currentUser} onUserUpdate={async () => {await refreshUser();}} />
                  {isDriver && <>
                    <Button variant="outline" size="sm" onClick={() => setShowQuickAdjustments(true)} className="h-8 gap-1.5 px-2 flex-shrink-0" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                      <span className="text-xs">Adjust</span>
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setShowMapStyleOptions((prev) => !prev)} className="h-8 w-8 p-0 flex-shrink-0" title="Map style" style={{ background: showMapStyleOptions ? 'var(--bg-slate-100)' : 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                      <MapIcon className="w-3.5 h-3.5" />
                    </Button>
                  </>}
                </div>
              </>}

              {showMapStyleOptions && <>
                <div className="pt-1 border-t border-slate-200"></div>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="sm" onClick={() => setMapStyle('explore')} className="h-8 px-2 flex-shrink-0" style={{ background: mapStyle === 'explore' ? '#16a34a' : 'var(--bg-white)', borderColor: mapStyle === 'explore' ? '#16a34a' : 'var(--border-slate-300)', color: mapStyle === 'explore' ? '#ffffff' : 'var(--text-slate-900)' }}>
                    <span className="text-xs">Explore</span>
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setMapStyle('satellite')} className="h-8 px-2 flex-shrink-0" style={{ background: mapStyle === 'satellite' ? '#16a34a' : 'var(--bg-white)', borderColor: mapStyle === 'satellite' ? '#16a34a' : 'var(--border-slate-300)', color: mapStyle === 'satellite' ? '#ffffff' : 'var(--text-slate-900)' }}>
                    <span className="text-xs">Satellite</span>
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setMapStyle('hybrid')} className="h-8 px-2 flex-shrink-0" style={{ background: mapStyle === 'hybrid' ? '#16a34a' : 'var(--bg-white)', borderColor: mapStyle === 'hybrid' ? '#16a34a' : 'var(--border-slate-300)', color: mapStyle === 'hybrid' ? '#ffffff' : 'var(--text-slate-900)' }}>
                    <span className="text-xs">Hybrid</span>
                  </Button>
                </div>
              </>}

              {isStatsCardCentered && isAppOwner(currentUser) && <>
                <div className="border-t border-slate-200 mt-2 pt-2"></div>
                <DashboardOfflineSync currentUser={currentUser} dailyPolylineCount={dailyPolylineCount} isExpanded={isExpanded} />
              </>}
            </motion.div>}
          </AnimatePresence>
        </motion.div>

        {!isAllDriversMode && !isAdmin && !isDispatcher ? null : legendData.length > 0 &&
        <div className="backdrop-blur-sm rounded-xl shadow-lg border h-auto overflow-visible w-full min-w-auto max-w-auto" style={{ background: 'var(--bg-white)', opacity: 0.95, borderColor: 'var(--border-slate-200)' }}
        onMouseEnter={() => handleCardInteraction(true)} onMouseLeave={() => handleCardInteraction(false)}>
            <div className="flex h-auto flex-wrap items-center justify-center gap-x-0.25 gap-y-0.5 leading-none">
              {legendData.map((route) =>
            <button
              key={route.driverId}
              type="button" className="my-1 px-0.5 py-0 text-base leading-none rounded inline-flex h-auto min-h-0 items-center gap-0.5 self-center hover:bg-slate-100 transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                handleDriverChange(route.driverId);
              }}>
                  <div className="relative flex items-center justify-center w-2.5 h-2.5 flex-shrink-0">
                    {route.hasHeartbeat &&
                <div
                  className="absolute inset-0 rounded-full animate-ping opacity-75"
                  style={{ backgroundColor: getStatusColor(route.driverStatus) }} />

                }
                    <div
                  className="relative w-2.5 h-2.5 rounded-full shadow-sm"
                  style={{ backgroundColor: getStatusColor(route.driverStatus) }} />
                
                  </div>
                  <span className="text-sm font-medium leading-none whitespace-nowrap" style={{ color: 'var(--text-slate-700)' }}>{route.driverName || 'Unknown'}</span>
                  <span className="text-sm leading-none" style={{ color: 'var(--text-slate-500)' }}>({route.totalStops})</span>
                </button>
            )}
            </div>
          </div>
        }
      </div>
    </div>);

}