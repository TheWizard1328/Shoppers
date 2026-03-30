import React, { useMemo } from "react";
import { format } from "date-fns";
import { AnimatePresence, motion } from "framer-motion";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Calendar as CalendarIcon, Clock, ChevronUp, ChevronDown, Settings, Binoculars, Sparkles } from "lucide-react";
import AddDeliveryButton from "@/components/dashboard/AddDeliveryButton";
import SmartRefreshIndicator from "@/components/layout/SmartRefreshIndicator";
import ConnectionIndicator from "@/components/dashboard/ConnectionIndicator";
import ErrorFlagIndicator from "@/components/dashboard/ErrorFlagIndicator";
import ActivePayStats from "@/components/dashboard/ActivePayStats";
import DriverLocationBadge from "@/components/dashboard/DriverLocationBadge";
import BreadcrumbToggleButton from "@/components/dashboard/BreadcrumbToggleButton";
import LocationTrackingToggle from "@/components/layout/LocationTrackingToggle";
import DashboardOfflineSync from "@/components/dashboard/DashboardOfflineSync";
import { isAppOwner } from "@/components/utils/userRoles";

export default function DashboardTopOverlay(props) {
  const {
    currentUser,
    statsLegendRef,
    selectedDate,
    selectedDriverId,
    deliveries,
    appUsers,
    driversList,
    isDriver,
    isDispatcher,
    isAdmin,
    isAllDriversMode,
    isExpanded,
    setIsExpanded,
    statsPanelOpacity,
    handleStatsPanelInteraction,
    handleCardInteraction,
    statsCardRef,
    pullToSyncKey,
    showAllDriverMarkers,
    setShowAllDriverMarkers,
    stats,
    deliveryStats,
    performanceStats,
    liveDistance,
    liveTimeOnDuty,
    isLoadingPayrollStats,
    hasRateLimitError,
    isCalendarOpen,
    setIsCalendarOpen,
    calendarMonth,
    setCalendarMonth,
    handleDateChange,
    setShowDeliveryForm,
    setEditingDelivery,
    setIsEntityUpdating,
    updateDeliveriesLocally,
    selectedDateStr,
    drivers,
    stores,
    patients,
    driverLocationPoller,
    smartRefreshManager,
    saveSetting,
    mapLockTimeoutRef,
    mapLockExpiresAtRef,
    setMapViewPhase,
    setIsMapViewLocked,
    lastProgrammaticMapMoveRef,
    setMapViewTrigger,
    setShowOptimizationSettings,
    shouldShowLocationToggle,
    refreshUser,
    setShowQuickAdjustments,
    setShowSmartPrioritization,
    showBreadcrumbs,
    setShowBreadcrumbs,
    setShowRoutes,
    setBreadcrumbsData,
    isRouteComplete,
    isMobile,
    dailyPolylineCount,
    statsCardPositioning,
    screenWidth,
    cardWidth,
    getDriverColor,
    driverRoutes,
    setSelectedCardId,
    cardExpandedAtRef,
    setAreCardsVisible,
    selectedCardId,
    dataSource,
    offlineDB,
    base44,
    globalFilters,
    setPullToSyncKey,
    retractClustersRef,
  } = props;

  const legendData = useMemo(() => {
    const dateKey = format(selectedDate, 'yyyy-MM-dd');
    if (isAdmin) {
      return driversList
        .filter(driver => deliveries.some(d => d && d.delivery_date === dateKey && d.driver_id === driver.id))
        .map(driver => {
          const s = (appUsers || []).find(au => au && au.user_id === driver.id)?.driver_status;
          const c = s === 'on_duty' ? '#16a34a' : s === 'on_break' ? '#3b82f6' : s === 'off_duty' ? '#dc2626' : '#94a3b8';
          return {
            driverId: driver.id,
            driverName: driver.user_name || driver.full_name || 'Unknown',
            color: getDriverColor(driver),
            totalStops:
              deliveries.filter(d => d && d.delivery_date === dateKey && d.driver_id === driver.id && d.patient_id && String(d.patient_id).trim() !== '').length +
              deliveries.filter(d => d && d.delivery_date === dateKey && d.driver_id === driver.id && (!d.patient_id || String(d.patient_id).trim() === '') && d.after_hours_pickup === true).length,
            statusRingColor: c
          };
        });
    }
    if (isAllDriversMode) {
      return [...driverRoutes].sort((a, b) => (a.driverName || '').localeCompare(b.driverName || ''));
    }
    return [];
  }, [selectedDate, isAdmin, driversList, deliveries, appUsers, getDriverColor, isAllDriversMode, driverRoutes]);

  return (
    <div className={statsCardPositioning} style={{ zIndex: 600 }}>
      <div
        className="dashboard-top-overlay flex flex-col items-center gap-0.5 min-w-[345px] max-w-[345px] relative"
        style={{ opacity: statsPanelOpacity, transition: 'opacity 0.5s ease-in-out' }}
        onMouseEnter={() => handleStatsPanelInteraction(true)}
        onMouseLeave={() => handleStatsPanelInteraction(false)}
      >
        <motion.div
          ref={statsCardRef}
          data-spotlight-anchor
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          onMouseEnter={() => handleCardInteraction(true)}
          onMouseLeave={() => handleCardInteraction(false)}
          onClick={(e) => {
            e.stopPropagation();
            handleCardInteraction(true);
            retractClustersRef?.current?.();
          }}
          className="px-1 rounded-2xl shadow-xl border min-w-[350px] max-w-[350px] cursor-pointer"
          style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', pointerEvents: 'auto', touchAction: 'none', position: 'relative' }}
        >
          <div className="mt-1 flex items-center justify-between">
            <div className="pr-1 flex items-center gap-2">
              <h2 className="pl-2 text-lg font-bold" style={{ color: 'var(--text-slate-900)' }}>Dashboard</h2>
              {currentUser && (
                <div className="flex items-center gap-1.5">
                  <SmartRefreshIndicator inline={true} onManualRefresh={async () => {
                    const syncButton = document.querySelector('[data-offline-sync-button]');
                    syncButton?.click();
                  }} />
                  <ConnectionIndicator />
                  <ErrorFlagIndicator />
                </div>
              )}
            </div>
            <div className="flex items-center gap-3">
              <Popover open={isCalendarOpen} onOpenChange={(open) => {
                setIsCalendarOpen(open);
                if (open) setCalendarMonth(selectedDate);
              }} modal={true}>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="bg-transparent px-3 text-xs font-medium rounded-md inline-flex items-center justify-center whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow-sm gap-2 h-8" style={{ pointerEvents: 'auto', touchAction: 'manipulation', background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
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
                      if (format(date, 'yyyy-MM-dd') === format(selectedDate, 'yyyy-MM-dd')) {
                        setIsCalendarOpen(false);
                        return;
                      }
                      handleDateChange(date);
                    }}
                    month={calendarMonth}
                    onMonthChange={setCalendarMonth}
                    footer={<div className="px-3 pb-2 pt-1 border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() => {
                                const todayDate = new Date();
                                setCalendarMonth(todayDate);
                                handleDateChange(todayDate);
                              }}
                              className="w-full flex items-center justify-center gap-1 p-1.5 rounded text-xs"
                              onMouseEnter={(e) => {
                                e.currentTarget.style.background = 'var(--bg-slate-100)';
                                e.currentTarget.style.color = 'var(--text-slate-800)';
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.background = 'transparent';
                                e.currentTarget.style.color = 'var(--text-slate-600)';
                              }}
                              style={{ color: 'var(--text-slate-600)' }}
                            >
                              <Clock className="w-3 h-3" />
                              Today
                            </button>
                          </TooltipTrigger>
                          <TooltipContent><p>Go to today</p></TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>}
                    className="px-2 py-2 rdp"
                    style={{ color: 'var(--text-slate-900)' }}
                  />
                </PopoverContent>
              </Popover>
              <AddDeliveryButton
                onClick={() => {
                  setEditingDelivery(null);
                  setShowDeliveryForm(true);
                }}
                disabled={(isDriver || isDispatcher) && !isAdmin && !isAppOwner(currentUser) && (() => {
                  const now = new Date();
                  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                  const selectedDay = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate());
                  if (selectedDay < today) return true;
                  if (selectedDay.getTime() === today.getTime()) {
                    const currentTime = now.getHours() * 100 + now.getMinutes();
                    return currentTime >= 2100;
                  }
                  return false;
                })()}
                hasRateLimitError={hasRateLimitError}
              />
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
              liveTimeOnDuty={liveTimeOnDuty}
              isLoadingPayrollStats={isLoadingPayrollStats}
            />
            <Button variant="ghost" size="sm" onClick={(e) => {
              e.stopPropagation();
              setIsExpanded(!isExpanded);
            }} className="h-8 w-8 p-0 flex-shrink-0">
              {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </Button>
          </div>

          {isAppOwner(currentUser) && <DriverLocationBadge users={appUsers} />}

          <AnimatePresence>
            {isExpanded && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                <div className="pt-1 pb-1 border-t flex items-center gap-2" style={{ borderColor: 'var(--border-slate-200)' }}>
                  <Select value={selectedDriverId} onValueChange={handleDriverChange} disabled={isDriver && !isAdmin && !isDispatcher}>
                    <SelectTrigger className="whitespace-nowrap border-input bg-transparent shadow-sm data-[placeholder]:text-muted-foreground flex h-10 w-full items-center justify-between rounded-md border px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1 flex-1" style={{ pointerEvents: 'auto', touchAction: 'manipulation', background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                      <SelectValue placeholder="All Drivers" />
                    </SelectTrigger>
                    <SelectContent className="z-[10001]" style={{ pointerEvents: 'auto', background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
                      <SelectItem value="all" style={{ color: 'var(--text-slate-900)' }}>All Drivers</SelectItem>
                      {driversList.map((driver) => <SelectItem key={driver.id} value={driver.id}>{driver.user_name || driver.full_name}</SelectItem>)}
                    </SelectContent>
                  </Select>

                  {isDriver && !isAllDriversMode && (
                    <div className="flex items-center flex-shrink-0">
                      <div className="flex flex-col items-center gap-1">
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={async () => {
                            const checked = !showAllDriverMarkers;
                            setShowAllDriverMarkers(checked);
                            if (currentUser?.id) saveSetting(currentUser.id, 'show_all_driver_markers', checked);
                            setIsExpanded(false);
                            setSelectedCardId(null);
                            cardExpandedAtRef.current = null;
                            setAreCardsVisible(false);
                            if (checked) {
                              setIsEntityUpdating(true);
                              try {
                                let allDateDeliveries;
                                if (dataSource === 'online') {
                                  allDateDeliveries = await base44.entities.Delivery.filter({ delivery_date: selectedDateStr });
                                  offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, allDateDeliveries).catch(() => {});
                                } else {
                                  allDateDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr);
                                  if (!allDateDeliveries || allDateDeliveries.length === 0) {
                                    allDateDeliveries = await base44.entities.Delivery.filter({ delivery_date: selectedDateStr });
                                    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, allDateDeliveries);
                                  }
                                }
                                if (updateDeliveriesLocally) {
                                  const otherDateDeliveries = deliveries.filter((d) => d && d.delivery_date !== selectedDateStr);
                                  updateDeliveriesLocally([...otherDateDeliveries, ...allDateDeliveries], true);
                                }
                                await new Promise((resolve) => setTimeout(resolve, 300));
                                const showAllLocationUpdates = await smartRefreshManager.refreshDriverLocations(appUsers, true, 'Dashboard', selectedDate);
                                const showAllLatestAppUsers = showAllLocationUpdates?.appUsers || appUsers;
                                driverLocationPoller.processLocationData(currentUser, allDateDeliveries, drivers, stores, showAllLatestAppUsers, selectedDate);
                                window.dispatchEvent(new CustomEvent('driverLocationsUpdated', { detail: { appUsers: showAllLatestAppUsers, forceAll: true } }));
                              } finally {
                                setIsEntityUpdating(false);
                              }
                            }
                            if (mapLockTimeoutRef.current) clearTimeout(mapLockTimeoutRef.current);
                            mapLockTimeoutRef.current = null;
                            mapLockExpiresAtRef.current = null;
                            setMapViewPhase(1);
                            setIsMapViewLocked(false);
                            lastProgrammaticMapMoveRef.current = Date.now();
                            window._lastProgrammaticMapMove = Date.now();
                            setMapViewTrigger((prev) => prev + 1);
                          }}
                          className={`h-9 w-9 p-0 ${showAllDriverMarkers ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : ''}`}
                          style={!showAllDriverMarkers ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-700)' } : {}}
                        >
                          <Binoculars className="w-4 h-4" />
                        </Button>
                      </div>
                      <div className="flex flex-col items-center gap-1">
                        <BreadcrumbToggleButton
                          isMobile={isMobile}
                          isDriver={isDriver}
                          isRouteComplete={isRouteComplete}
                          showBreadcrumbs={showBreadcrumbs}
                          setShowBreadcrumbs={setShowBreadcrumbs}
                          setShowRoutes={setShowRoutes}
                          setBreadcrumbsData={setBreadcrumbsData}
                          selectedDate={selectedDate}
                          showAllDriverMarkers={showAllDriverMarkers}
                          selectedDriverId={selectedDriverId}
                          currentUser={currentUser}
                          appUsers={appUsers}
                        />
                      </div>
                    </div>
                  )}

                  <Button variant="outline" size="sm" onClick={() => setShowOptimizationSettings(true)} className="h-8 w-8 p-0 flex-shrink-0" title="Route Optimization Settings" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                    <Settings className="w-3.5 h-3.5" />
                  </Button>
                </div>

                {shouldShowLocationToggle && (
                  <>
                    <div className="border-t border-slate-200"></div>
                    <div className="py-1 flex items-center gap-2">
                      <LocationTrackingToggle user={currentUser} onUserUpdate={async () => { await refreshUser(); }} />
                      {isDriver && (
                        <>
                          <Button variant="outline" size="sm" onClick={() => setShowQuickAdjustments(true)} className="h-8 gap-1.5 px-2 flex-shrink-0" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}><span className="text-xs">Adjust</span></Button>
                          <Button variant="outline" size="sm" onClick={() => setShowSmartPrioritization(true)} className="h-8 gap-1.5 px-2 flex-shrink-0" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}><Sparkles className="w-3 h-3" /><span className="text-xs">AI</span></Button>
                        </>
                      )}
                    </div>
                  </>
                )}

                {isStatsCardCentered && (
                  <>
                    <div className="border-t border-slate-200 mt-2 pt-2"></div>
                    <DashboardOfflineSync currentUser={currentUser} dailyPolylineCount={dailyPolylineCount} isExpanded={isExpanded} />
                  </>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>

        {legendData.length > 0 && (
          <div ref={statsLegendRef} className="dashboard-driver-legend rounded-lg backdrop-blur-sm shadow-lg border" style={{ background: 'var(--bg-white)', opacity: 0.95, borderColor: 'var(--border-slate-200)', width: cardWidth }} onMouseEnter={() => handleCardInteraction(true)} onMouseLeave={() => handleCardInteraction(false)}>
            <div className="flex w-full flex-wrap gap-x-0.5 gap-y-0.5 items-center justify-center">
              {legendData.map((route) => {
                const au = (appUsers || []).find(a => a && a.user_id === route.driverId);
                const s = au?.driver_status;
                const isOnline = s === 'on_duty' || s === 'online' || (au?.location_updated_at && (Date.now() - new Date(au.location_updated_at).getTime() < 300000));
                const c = s === 'on_duty' ? '#16a34a' : s === 'on_break' ? '#3b82f6' : s === 'off_duty' ? '#dc2626' : '#94a3b8';
                const bg = isAllDriversMode ? route.color : c;
                const bd = isAllDriversMode ? `3px solid ${c}` : '0 solid transparent';
                return (
                  <div key={route.driverId} className="flex items-center gap-1.5">
                    <div className="relative flex items-center justify-center w-3 h-3">
                      {isOnline && <div className="absolute inset-0 rounded-full animate-ping opacity-75" style={{ backgroundColor: c }} />}
                      <div className="relative w-3 h-3 rounded-full shadow-sm flex-shrink-0" style={{ backgroundColor: bg, border: bd }} />
                    </div>
                    <span className="text-xs font-medium whitespace-nowrap" style={{ color: 'var(--text-slate-700)' }}>{route.driverName || 'Unknown'}</span>
                    <span className="text-xs" style={{ color: 'var(--text-slate-500)' }}>({route.totalStops})</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}