// DashboardView.jsx - Presentation layer for Dashboard
// All rendering logic extracted from Dashboard.jsx

import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Calendar as CalendarIcon, Clock, Truck, Plus, ChevronUp, ChevronDown, X, Settings, Sparkles, Navigation, Binoculars } from "lucide-react";
import { format } from 'date-fns';
import { AnimatePresence, motion } from "framer-motion";
import { isAppOwner } from '@/components/utils/userRoles';
import { base44 } from "@/api/base44Client";
import { offlineDB } from "@/components/utils/offlineDatabase";
import { globalFilters } from "@/components/utils/globalFilters";
import { saveSetting } from "@/components/utils/userSettingsManager";
import { smartRefreshManager } from "@/components/utils/smartRefreshManager";
import { driverLocationPoller } from "@/components/utils/driverLocationPoller";
import { pauseOfflineMutations, resumeOfflineMutations } from "@/components/utils/offlineMutations";
import { pauseOfflineSync, resumeOfflineSync } from "@/components/utils/offlineSync";
import { invalidateDeliveriesForDate } from "@/components/utils/dataManager";
import { createStopCardsScrollHandler } from "@/components/dashboard/StopCardsScrollHandler";
import { getDriverColor } from "@/components/dashboard/DeliveryMap";
import DeliveryMap from "@/components/dashboard/DeliveryMap";
import SnapshotTimeline from "@/components/snapshot/SnapshotTimeline";
import HorizontalStopCards from "@/components/dashboard/HorizontalStopCards";
import DeliveryForm from "@/components/deliveries/DeliveryForm";
import PatientForm from "@/components/patients/PatientForm";
import RouteOptimizationSettings from "@/components/dashboard/RouteOptimizationSettings";
import MapViewCycleFAB from "@/components/dashboard/MapViewCycleFAB";
import RouteSummaryModal from "@/components/dashboard/RouteSummaryModal";
import SmartRefreshIndicator from "@/components/layout/SmartRefreshIndicator";
import LocationTrackingToggle from "@/components/layout/LocationTrackingToggle";
import DashboardOfflineSync from '@/components/dashboard/DashboardOfflineSync';
import ETATracker from '@/components/dashboard/ETATracker';
import ETANotification from '@/components/dashboard/ETANotification';
import RealTimeRouteOptimizer from '@/components/dashboard/RealTimeRouteOptimizer';
import QuickRouteAdjustments from '@/components/dashboard/QuickRouteAdjustments';
import SmartPrioritizationPanel from '@/components/dashboard/SmartPrioritizationPanel';
import ActivePayStats from '@/components/dashboard/ActivePayStats';
import EndOfDayStatsDialog from '@/components/dashboard/EndOfDayStatsDialog';
import PullToSync from '@/components/dashboard/PullToSync';
import DriverLocationBadge from '@/components/dashboard/DriverLocationBadge';
import DispatcherPickupNotification from '@/components/dashboard/DispatcherPickupNotification';
import ReconcileToast from '@/components/dashboard/ReconcileToast';
import RouteNotification from '@/components/dashboard/RouteNotification';
import ProactiveAlertSystem from '@/components/dashboard/ProactiveAlertSystem';
import ConnectionIndicator from '@/components/dashboard/ConnectionIndicator';
import ErrorFlagIndicator from '@/components/dashboard/ErrorFlagIndicator';
import { toast } from 'sonner';
import { flushSync } from "react-dom";

export default function DashboardView({
  // User & roles
  currentUser, isDriver, isAdmin, isDispatcher, isMobile,
  // Data
  deliveries, patients, stores, drivers, appUsers,
  filteredDeliveries, deliveriesWithStopOrder, driversList, stats,
  // Date & driver selection
  selectedDate, selectedDateStr, selectedDriverId, isAllDriversMode,
  calendarMonth, setCalendarMonth,
  isCalendarOpen, setIsCalendarOpen,
  isDriverDropdownDisabled,
  // Map state
  mapCenter, mapZoom, shouldFitBounds, mapMode, setMapMode,
  mapViewPhase, isMapViewLocked,
  showRoutes, driverRoutes, driverLocation, allDriverLocations,
  currentToNextPolyline, googleApiKey,
  stopCardsBaseHeight, statsCardBaseHeight, cardsReadyForFAB,
  showAllDriverMarkers, showBreadcrumbs, breadcrumbsData,
  highlightedCardId, areCardsVisible, retractClustersRef,
  stopCardsContainerRef, statsCardRef, horizontalStopCardsRef,
  isStatsCardCentered, statsCardPositioning, statsPanelOpacity,
  // Refs for map control
  lastProgrammaticMapMoveRef, mapLockTimeoutRef, mapLockExpiresAtRef,
  // UI state
  isExpanded, setIsExpanded,
  optimizationMessage, setOptimizationMessage, isOptimizing,
  isReoptimizing, setIsReoptimizing,
  selectedCardId, pullToSyncKey,
  showDeliveryForm, setShowDeliveryForm,
  editingDelivery, setEditingDelivery,
  showPatientForm, setShowPatientForm,
  editingPatient, setEditingPatient, patientFormCallback, setPatientFormCallback, patientFormMode, setPatientFormMode,
  showOptimizationSettings, setShowOptimizationSettings,
  showAIAssistant, isAIEnabled,
  showRouteSummary, setShowRouteSummary, summaryDriver, setSummaryDriver,
  showEndOfDayStats, setShowEndOfDayStats, endOfDayDriver, setEndOfDayDriver,
  showQuickAdjustments, setShowQuickAdjustments,
  showSmartPrioritization, setShowSmartPrioritization,
  routeNotification, setRouteNotification,
  dailyPolylineCount,
  hasRateLimitError,
  realTimeETAEnabled,
  isDateFinished,
  isSnapshotModeActive, setIsSnapshotModeActive, setSnapshotData,
  deliveryStats, performanceStats, liveDistance, liveTimeOnDuty, isLoadingPayrollStats,
  dataSource, setIsEntityUpdating, setMapViewTrigger,
  shouldShowLocationToggle,
  // Handlers
  handleDateChange, handleDriverChange,
  handleCardClick, handleMarkerClick, handleMapInteraction, handleMapViewCycle,
  handleStatsPanelInteraction, handleCardInteraction,
  handleSaveDelivery, handleDeleteDelivery, handleStatusUpdate,
  handleNotesUpdate, handleCODUpdate, handleCreateReturn,
  handleStartDelivery, handleRestartDelivery,
  handleEditDelivery, handleEditPatient, handleCreatePatientFromDelivery,
  handleSavePatient,
  handleQuickReorder, handleAddDelay,
  handleSnapshotSelect,
  refreshData, refreshUser, updateDeliveriesLocally,
  getMapPadding, setShouldFitBounds, setMapCenter, setMapZoom,
  setShowAllDriverMarkers, setShowBreadcrumbs, setBreadcrumbsData,
  setIsMapViewLocked, setMapViewPhase,
}) {
  return (
    <div className="h-full w-full flex flex-col overflow-hidden" style={{ background: 'var(--bg-slate-50)' }}>

      {/* Snapshot Timeline */}
      {isSnapshotModeActive && isAppOwner(currentUser) &&
        <div className="absolute left-0 top-0 bottom-0 z-[250]">
          <SnapshotTimeline
            selectedDate={selectedDate}
            selectedDriverId={selectedDriverId}
            onSnapshotSelect={handleSnapshotSelect}
            onClose={() => {
              setIsSnapshotModeActive(false);
              setSnapshotData(null);
            }}
          />
        </div>
      }

      {/* Stats Card */}
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
                window.dispatchEvent(new CustomEvent('driverLocationsUpdated', { detail: { appUsers: freshAppUsers, forceAll: true } }));
              }
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
            onClick={(e) => {
              e.stopPropagation();
              handleCardInteraction(true);
              if (retractClustersRef.current) retractClustersRef.current();
            }}
            className="px-2 py-0.5 rounded-2xl shadow-xl border min-w-[340px] max-w-[345px] cursor-pointer"
            style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', pointerEvents: 'auto', touchAction: 'none', position: 'relative' }}>

            <div className="mt-1 mb-2 flex items-center justify-between">
              <div className="pr-1 flex items-center gap-2">
                <h2 className="pl-2 text-lg font-bold" style={{ color: 'var(--text-slate-900)' }}>Dashboard</h2>
                {currentUser &&
                  <div className="flex items-center gap-1.5">
                    <SmartRefreshIndicator
                      inline={true}
                      onManualRefresh={async () => {
                        const syncButton = document.querySelector('[data-offline-sync-button]');
                        if (syncButton) syncButton.click();
                      }} />
                    <ConnectionIndicator />
                    <ErrorFlagIndicator />
                  </div>
                }
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
                      footer={
                        <div className="px-3 pb-2 pt-1 border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
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
                                  style={{ color: 'var(--text-slate-600)' }}
                                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-slate-100)'; e.currentTarget.style.color = 'var(--text-slate-800)'; }}
                                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-slate-600)'; }}>
                                  <Clock className="w-3 h-3" />
                                  Today
                                </button>
                              </TooltipTrigger>
                              <TooltipContent><p>Go to today</p></TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
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
                liveTimeOnDuty={liveTimeOnDuty}
                isLoadingPayrollStats={isLoadingPayrollStats} />
              <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); setIsExpanded(!isExpanded); }} className="h-8 w-8 p-0 flex-shrink-0">
                {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </Button>
            </div>

            {isAppOwner(currentUser) && <DriverLocationBadge users={appUsers} />}

            <AnimatePresence>
              {isExpanded &&
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden">
                  <div className="mt-2 pt-2 pb-2 border-t flex items-center gap-2" style={{ borderColor: 'var(--border-slate-200)' }}>
                    <Select value={selectedDriverId} onValueChange={handleDriverChange} disabled={isDriverDropdownDisabled}>
                      <SelectTrigger className="flex h-8 w-full items-center justify-between rounded-md border px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1 flex-1" style={{ pointerEvents: 'auto', touchAction: 'manipulation', background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
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

                    {/* Show All and Breadcrumbs Buttons */}
                    {isDriver && !isAllDriversMode && (
                      <div className="flex items-center flex-shrink-0">
                        <div className="flex flex-col items-center gap-1">
                          <Button
                            variant="outline" size="icon"
                            onClick={async () => {
                              const checked = !showAllDriverMarkers;
                              setShowAllDriverMarkers(checked);
                              if (currentUser?.id) saveSetting(currentUser.id, 'show_all_driver_markers', checked);
                              setIsExpanded(false);
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
                                    const other = deliveries.filter(d => d && d.delivery_date !== selectedDateStr);
                                    updateDeliveriesLocally([...other, ...allDateDeliveries], true);
                                  }
                                  await new Promise(r => setTimeout(r, 300));
                                  const locationUpdates = await smartRefreshManager.refreshDriverLocations(appUsers, true, 'Dashboard', selectedDate);
                                  const latestAppUsers = locationUpdates?.appUsers || appUsers;
                                  window.dispatchEvent(new CustomEvent('driverLocationsUpdated', { detail: { appUsers: latestAppUsers, forceAll: true } }));
                                } catch (e) {
                                  console.error('❌ [Show All] Failed:', e);
                                } finally {
                                  setIsEntityUpdating(false);
                                }
                              }
                              if (mapLockTimeoutRef.current) { clearTimeout(mapLockTimeoutRef.current); mapLockTimeoutRef.current = null; }
                              mapLockExpiresAtRef.current = null;
                              setMapViewPhase(1);
                              setIsMapViewLocked(true);
                              lastProgrammaticMapMoveRef.current = Date.now();
                              window._lastProgrammaticMapMove = Date.now();
                              setMapViewTrigger(prev => prev + 1);
                              const lockDuration = 500;
                              const expiresAt = Date.now() + lockDuration;
                              mapLockExpiresAtRef.current = expiresAt;
                              mapLockTimeoutRef.current = setTimeout(() => {
                                if (mapLockExpiresAtRef.current === expiresAt) { setIsMapViewLocked(false); mapLockExpiresAtRef.current = null; mapLockTimeoutRef.current = null; }
                              }, lockDuration);
                            }}
                            className={`h-9 w-9 p-0 ${showAllDriverMarkers ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : ''}`}
                            style={!showAllDriverMarkers ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-700)' } : {}}>
                            <Binoculars className="w-4 h-4" />
                          </Button>
                        </div>

                        <div className="flex flex-col items-center gap-1">
                          <Button
                            variant="outline" size="icon"
                            onClick={async () => {
                              const newShowBreadcrumbs = !showBreadcrumbs;
                              setShowBreadcrumbs(newShowBreadcrumbs);
                              if (newShowBreadcrumbs) {
                                try {
                                  const driverIdToFetch = selectedDriverId === 'all' ? currentUser?.id : selectedDriverId;
                                  const historicalBreadcrumbs = await base44.entities.DeliveryBreadcrumbs.filter({ driver_id: driverIdToFetch, delivery_date: selectedDateStr });
                                  let currentBreadcrumbs = [];
                                  try {
                                    const all = await offlineDB.getByIndex(offlineDB.STORES.CURRENT_BREADCRUMBS, 'driver_id', driverIdToFetch);
                                    currentBreadcrumbs = all.filter(b => b && b.delivery_date === selectedDateStr).sort((a, b) => a.timestamp - b.timestamp);
                                  } catch (e) {}
                                  if (historicalBreadcrumbs.length === 0 && currentBreadcrumbs.length === 0) {
                                    toast.info('No breadcrumb trails available', { description: 'GPS trails are saved after deliveries are completed with tracking enabled' });
                                    setShowBreadcrumbs(false);
                                    return;
                                  }
                                  setBreadcrumbsData({ historical: historicalBreadcrumbs, current: currentBreadcrumbs });
                                } catch (e) {
                                  setBreadcrumbsData({ historical: [], current: [] });
                                }
                              } else {
                                setBreadcrumbsData({ historical: [], current: [] });
                              }
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

                    <Button variant="default" size="sm" onClick={() => { setIsExpanded(false); }} className="gap-2 h-8 flex-shrink-0 bg-emerald-600 hover:bg-emerald-700 text-white"
                      onClick={() => { const newVal = !showRoutes; window.dispatchEvent(new CustomEvent('toggleRoutes', { detail: { showRoutes: newVal } })); setIsExpanded(false); }}>
                      <Truck className="w-3.5 h-3.5" />
                      {showRoutes ? 'Hide' : 'Show'}
                    </Button>
                  </div>

                  {shouldShowLocationToggle &&
                    <>
                      <div className="border-t border-slate-200 mt-2 pt-2"></div>
                      <div className="flex items-center gap-2">
                        <LocationTrackingToggle user={currentUser} onUserUpdate={async () => { await refreshUser(); }} />
                        {isDriver && (
                          <>
                            <Button variant="outline" size="sm" onClick={() => setShowQuickAdjustments(true)} className="h-8 gap-1.5 px-2 flex-shrink-0" title="Quick route adjustments" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                              <span className="text-xs">Adjust</span>
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => setShowSmartPrioritization(true)} className="h-8 gap-1.5 px-2 flex-shrink-0" title="AI delivery prioritization" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                              <Sparkles className="w-3 h-3" />
                              <span className="text-xs">AI</span>
                            </Button>
                          </>
                        )}
                      </div>
                    </>
                  }

                  {isStatsCardCentered &&
                    <>
                      <div className="border-t border-slate-200 mt-2 pt-2"></div>
                      <DashboardOfflineSync currentUser={currentUser} dailyPolylineCount={dailyPolylineCount} isExpanded={isExpanded} />
                    </>
                  }
                </motion.div>
              }
            </AnimatePresence>
          </motion.div>

          {/* Driver Legend */}
          {isAllDriversMode && driverRoutes.length > 0 &&
            <div className="backdrop-blur-sm rounded-lg shadow-lg border px-1 py-1" style={{ background: 'var(--bg-white)', opacity: 0.95, borderColor: 'var(--border-slate-200)' }}
              onMouseEnter={() => handleCardInteraction(true)}
              onMouseLeave={() => handleCardInteraction(false)}>
              <div className="flex flex-wrap gap-x-1 gap-y-1 items-center justify-center">
                {[...driverRoutes].sort((a, b) => (a.driverName || '').localeCompare(b.driverName || '')).map((route) => (
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

      {/* Main Map Area */}
      <div className="flex-1 w-full relative min-h-0 overflow-hidden">

        {currentUser && isAppOwner(currentUser) &&
          <div className="absolute left-4 z-[140]" style={{ bottom: `${(deliveriesWithStopOrder.length > 0 ? stopCardsBaseHeight : 0) + 15}px` }}>
            <div className="px-2 py-1 text-xs font-medium rounded-lg border" style={{ background: 'transparent', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-600)' }}>
              🛣️ {dailyPolylineCount ?? '...'}
            </div>
          </div>
        }

        {!isStatsCardCentered && <DashboardOfflineSync currentUser={currentUser} dailyPolylineCount={dailyPolylineCount} isExpanded={isExpanded} stopCardsHeight={stopCardsBaseHeight} />}

        {realTimeETAEnabled && isMobile && isDriver && selectedDriverId === currentUser?.id && selectedDriverId !== 'all' &&
          <ETATracker selectedDriverId={selectedDriverId} selectedDate={selectedDateStr} currentUser={currentUser} isActive={!showDeliveryForm && !showPatientForm && !showOptimizationSettings} onETAUpdate={() => {}} />
        }

        {isMobile && isDriver && selectedDriverId === currentUser?.id && selectedDriverId !== 'all' &&
          <RealTimeRouteOptimizer selectedDriverId={selectedDriverId} selectedDate={selectedDateStr} currentUser={currentUser} isActive={!showDeliveryForm && !showPatientForm && !showOptimizationSettings} onRouteOptimized={() => {}} />
        }

        <ETANotification deliveries={filteredDeliveries} driverId={selectedDriverId} currentUser={currentUser} />

        <div className="absolute inset-0">
          <DeliveryMap
            deliveries={deliveriesWithStopOrder}
            selectedDriverId={selectedDriverId}
            selectedDate={format(selectedDate, 'yyyy-MM-dd')}
            patients={patients}
            stores={stores}
            users={drivers}
            currentUser={currentUser}
            driverLocations={allDriverLocations}
            deliveriesForLocationFilter={filteredDeliveries}
            showOtherDriverDeliveries={showAllDriverMarkers}
            currentDriverLocation={driverLocation}
            currentToNextPolyline={currentToNextPolyline}
            showBreadcrumbs={showBreadcrumbs}
            breadcrumbsData={breadcrumbsData}
            center={mapCenter}
            zoom={mapZoom}
            shouldFitBounds={shouldFitBounds}
            onBoundsFitted={() => setShouldFitBounds(null)}
            onMarkerClick={handleMarkerClick}
            mapMode={mapMode}
            onMapModeChange={setMapMode}
            autoFitBounds={true}
            showRoutes={showRoutes}
            showLegend={false}
            areCardsVisible={areCardsVisible}
            onLegendInteraction={handleCardInteraction}
            googleApiKey={googleApiKey}
            onDriverRoutesCalculated={(routes) => window.dispatchEvent(new CustomEvent('driverRoutesCalculated', { detail: routes }))}
            onMapInteraction={handleMapInteraction}
            onDoubleTap={handleMapViewCycle}
            retractClustersRef={retractClustersRef}
            areStopCardsVisible={deliveriesWithStopOrder.length > 0}
            highlightedDeliveryId={highlightedCardId}
            stopCardsHeight={stopCardsBaseHeight}
            onMapReady={() => {}} />
        </div>

        {/* Stop Cards */}
        <div
          ref={stopCardsContainerRef}
          className="horizontal-cards-container absolute bottom-0 right-0 z-[150] px-4 pb-1 pointer-events-none flex flex-col justify-end max-h-[80vh]"
          style={{ left: isSnapshotModeActive ? '5rem' : '0' }}
          onClick={() => { if (retractClustersRef.current) retractClustersRef.current(); }}>

          <AnimatePresence>
            {optimizationMessage &&
              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} className="flex justify-center mb-2 pointer-events-auto">
                <div className="rounded-lg shadow-2xl border-2 border-emerald-500 p-3 flex items-center gap-3 max-w-[90vw]" style={{ background: 'var(--bg-white)' }}>
                  {isOptimizing && <div className="animate-spin w-4 h-4 border-3 border-emerald-500 border-t-transparent rounded-full flex-shrink-0"></div>}
                  <p className="font-medium flex-1 text-sm" style={{ color: 'var(--text-slate-900)' }}>{optimizationMessage}</p>
                  {!isOptimizing && <button onClick={() => setOptimizationMessage(null)} className="text-slate-400 hover:text-slate-600 flex-shrink-0"><X className="w-3.5 h-3.5" style={{ color: 'var(--text-slate-400)' }} /></button>}
                </div>
              </motion.div>
            }
          </AnimatePresence>

          <div
            className="overflow-x-auto overflow-y-visible scrollbar-thin scrollbar-thumb-slate-300 scrollbar-track-transparent pointer-events-auto"
            style={isMobile ? { scrollSnapType: 'x mandatory' } : {}}
            onWheel={(e) => { e.currentTarget.scrollLeft += e.deltaY; }}
            onTouchStart={() => { window._lastUserInteraction = Date.now(); }}
            onScroll={isMobile ? createStopCardsScrollHandler({ deliveriesWithStopOrder, patients, stores, mapViewPhase, isMapViewLocked, setIsMapViewLocked, setMapViewPhase, setShouldFitBounds, setMapCenter, setMapZoom, getMapPadding, mapLockTimeoutRef, mapLockExpiresAtRef }) : undefined}>

            {(!isAllDriversMode || isDispatcher) && (
              <HorizontalStopCards
                ref={horizontalStopCardsRef}
                pickupCards={deliveriesWithStopOrder
                  .filter(delivery => delivery && delivery.status !== 'pending')
                  .map(delivery => {
                    if (!delivery) return delivery;
                    if (!delivery.patient_id && delivery.status === 'en_route' && delivery.stop_id) {
                      let pendingDeliveries = deliveriesWithStopOrder.filter(d => d && d.puid === delivery.stop_id && d.status === 'pending' && d.patient_id);
                      if (isDispatcher && currentUser?.store_ids?.length > 0) {
                        const dispatcherStoreIds = new Set(currentUser.store_ids);
                        pendingDeliveries = pendingDeliveries.filter(d => d && dispatcherStoreIds.has(d.store_id));
                      }
                      if (pendingDeliveries.length > 0) return { ...delivery, projected_deliveries: pendingDeliveries };
                    }
                    if (isDispatcher && currentUser.store_ids?.length > 0) {
                      if (!currentUser.store_ids.includes(delivery.store_id)) return { ...delivery, _isStripped: true };
                    }
                    if (isDriver && !isDispatcher && !isAdmin) {
                      const finishedStatuses = ['completed', 'failed', 'cancelled'];
                      const allDriverDeliveries = deliveriesWithStopOrder.filter(d => d && d.driver_id === currentUser.id);
                      const checkIsReturn = (d) => {
                        if (!d || !d.patient_id) return false;
                        const p = patients.find(p => p && p.id === d.patient_id);
                        const notes = d.delivery_notes || '', pn = d.patient_name || '', pfn = p?.full_name || '';
                        return notes.toLowerCase().includes('(rtn)') || pn.toLowerCase().includes('(rtn)') || pfn.toLowerCase().includes('(rtn)') || /\breturn\b/i.test(notes) || /\breturn\b/i.test(pn) || /\breturn\b/i.test(pfn);
                      };
                      const routeComplete = allDriverDeliveries.length > 0 && allDriverDeliveries.every(d => finishedStatuses.includes(d.status) || checkIsReturn(d));
                      if (routeComplete) {
                        const isInterStore = delivery.patient_name?.toLowerCase().includes('interstore') || delivery.delivery_notes?.toLowerCase().includes('interstore');
                        const isStorePickup = !delivery.patient_id;
                        if (!isInterStore && !isStorePickup) return { ...delivery, _isStripped: true };
                      }
                    }
                    return delivery;
                  })}
                onCardClick={handleCardClick}
                selectedCardId={selectedCardId}
                stores={stores}
                drivers={drivers}
                patients={patients}
                currentUser={currentUser}
                onSelectionChange={() => flushSync(() => {})}
                selectedDeliveryIds={{}}
                stopOrder={{}}
                showDriverName={isAllDriversMode}
                getDriverColor={getDriverColor}
                onEditDelivery={handleEditDelivery}
                onEditPatient={handleEditPatient}
                onDeleteDelivery={handleDeleteDelivery}
                onRestart={handleRestartDelivery}
                onStatusUpdate={handleStatusUpdate}
                onNotesUpdate={handleNotesUpdate}
                onCODUpdate={handleCODUpdate}
                onCreateReturn={handleCreateReturn}
                onStartDelivery={handleStartDelivery}
                allDeliveries={deliveries}
                selectedDate={selectedDate}
                onDriverStatusChange={async () => { await refreshUser(); }} />
            )}
          </div>
        </div>
      </div>

      {/* Delivery Form */}
      <AnimatePresence>
        {showDeliveryForm &&
          <DeliveryForm delivery={editingDelivery} patients={patients} stores={stores} drivers={drivers} onSave={handleSaveDelivery} onCancel={() => { setShowDeliveryForm(false); setEditingDelivery(null); }} suggestedDate={format(selectedDate, 'yyyy-MM-dd')} currentUser={currentUser} allDeliveries={deliveries} onCreatePatient={handleCreatePatientFromDelivery} />
        }
      </AnimatePresence>

      {/* Patient Form */}
      <AnimatePresence>
        {showPatientForm &&
          <PatientForm patient={editingPatient} stores={stores} cities={[]} currentUser={currentUser} allPatients={patients} duplicateMode={patientFormMode} onSave={handleSavePatient} onCancel={() => { setShowPatientForm(false); setEditingPatient(null); setPatientFormCallback(null); setPatientFormMode(null); }} returnPatientOnSave={!!patientFormCallback} />
        }
      </AnimatePresence>

      {/* Optimization Settings Dialog */}
      <Dialog open={showOptimizationSettings} onOpenChange={setShowOptimizationSettings}>
        <DialogContent className="max-w-2xl max-h-[90vh] p-0 z-[10000]">
          <RouteOptimizationSettings onClose={() => setShowOptimizationSettings(false)} currentUser={currentUser} />
        </DialogContent>
      </Dialog>

      {/* FABs */}
      {(isDriver || isDispatcher) &&
        <>
          <MapViewCycleFAB onClick={handleMapViewCycle} currentPhase={mapViewPhase} hasVisibleCards={deliveriesWithStopOrder.length > 0} isAIVisible={showAIAssistant && isAIEnabled} isLocked={isMapViewLocked} stopCardsHeight={cardsReadyForFAB ? stopCardsBaseHeight : 0} />

          {isAppOwner(currentUser) && selectedDriverId !== 'all' &&
            <motion.div initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0, opacity: 0 }} transition={{ type: "spring", stiffness: 260, damping: 20 }} className="fixed z-[100]"
              style={{ bottom: `${(deliveriesWithStopOrder.length > 0 && cardsReadyForFAB ? stopCardsBaseHeight : 0) + 15}px`, right: '64px' }}>
              <Button
                onClick={async () => {
                  if (isReoptimizing) return;
                  setIsReoptimizing(true);
                  setOptimizationMessage('Re-optimizing route...');
                  setIsEntityUpdating(true);
                  pauseOfflineMutations();
                  pauseOfflineSync();
                  await new Promise(r => setTimeout(r, 100));
                  if (mapViewPhase === 2 && isMapViewLocked) {
                    if (mapLockTimeoutRef.current) { clearTimeout(mapLockTimeoutRef.current); mapLockTimeoutRef.current = null; }
                    mapLockExpiresAtRef.current = null;
                    setIsMapViewLocked(false);
                  }
                  try {
                    const deliveryDate = format(selectedDate, 'yyyy-MM-dd');
                    const now = new Date();
                    const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
                    const response = await base44.functions.invoke('optimizeRemainingStops', { driverId: currentUser.id, deliveryDate, currentLocalTime, deviceTime: now.toISOString() });
                    const data = response?.data || response;
                    if (data?.success) {
                      setOptimizationMessage(`Route optimized! ${data.optimizedCount} stops updated.`);
                      invalidateDeliveriesForDate(deliveryDate);
                      await refreshData();
                      window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { driverId: currentUser.id, deliveryDate, triggeredBy: 'reoptimizeRoute' } }));
                      setIsMapViewLocked(true);
                      setMapViewTrigger(prev => prev + 1);
                      setTimeout(() => { setOptimizationMessage(null); setIsMapViewLocked(false); }, 3000);
                    } else {
                      setOptimizationMessage(data?.error || 'Optimization failed');
                      setTimeout(() => setOptimizationMessage(null), 5000);
                    }
                  } catch (e) {
                    setOptimizationMessage(`Error: ${e.message}`);
                    setTimeout(() => setOptimizationMessage(null), 5000);
                  } finally {
                    resumeOfflineMutations();
                    resumeOfflineSync();
                    setIsEntityUpdating(false);
                    await new Promise(r => setTimeout(r, 100));
                    setIsReoptimizing(false);
                  }
                }}
                disabled={isReoptimizing || isDateFinished || !filteredDeliveries.some(d => d && d.status === 'in_transit')}
                title="Re-optimize entire route using Google Maps"
                className={`inline-flex items-center justify-center whitespace-nowrap text-sm font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 text-primary-foreground h-10 w-10 rounded-lg shadow-2xl p-0 relative transition-all duration-200 ${isReoptimizing ? 'bg-amber-500 hover:bg-amber-600' : 'bg-emerald-600 hover:bg-emerald-700'}`}
                style={{ pointerEvents: 'auto', touchAction: 'manipulation' }}>
                {isReoptimizing ? <div className="animate-spin w-5 h-5 border-2 border-white border-t-transparent rounded-full" /> : <Navigation className="w-5 h-5 text-white" />}
              </Button>
            </motion.div>
          }
        </>
      }

      {/* Route Summary Modal */}
      <AnimatePresence>
        {showRouteSummary &&
          <RouteSummaryModal deliveries={filteredDeliveries} patients={patients} stores={stores} driver={summaryDriver || currentUser}
            onClose={async () => { setShowRouteSummary(false); setSummaryDriver(null); if (isDriver && currentUser?.id) await refreshUser(); }} />
        }
      </AnimatePresence>

      {/* End of Day Stats Dialog */}
      <AnimatePresence>
        {showEndOfDayStats &&
          <EndOfDayStatsDialog isOpen={showEndOfDayStats} onClose={() => { setShowEndOfDayStats(false); setEndOfDayDriver(null); }} deliveries={filteredDeliveries} driver={endOfDayDriver || currentUser} deliveryDate={format(selectedDate, 'yyyy-MM-dd')} />
        }
      </AnimatePresence>

      <RouteNotification notification={routeNotification} onDismiss={() => setRouteNotification(null)}
        onNavigate={() => {
          const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
          const nextIncomplete = deliveriesWithStopOrder.find(d => d && d.isNextDelivery && !finishedStatuses.includes(d.status));
          if (nextIncomplete) {
            const el = document.getElementById(`stop-card-${nextIncomplete.id}`);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
          }
        }} />

      {isDriver && isAIEnabled &&
        <ProactiveAlertSystem currentUser={currentUser} deliveries={filteredDeliveries} patients={patients} stores={stores} driverLocation={driverLocation} isEnabled={isAIEnabled} onAlert={() => {}} />
      }

      <ReconcileToast />

      <DispatcherPickupNotification deliveries={deliveries} stores={stores} appUsers={appUsers} currentUser={currentUser} isDispatcher={isDispatcher} />

      {/* Quick Route Adjustments Dialog */}
      {isDriver &&
        <Dialog open={showQuickAdjustments} onOpenChange={setShowQuickAdjustments}>
          <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto z-[10001]">
            <DialogHeader><DialogTitle>Quick Route Adjustments</DialogTitle></DialogHeader>
            {deliveriesWithStopOrder.filter(d => d && !['completed', 'failed', 'cancelled', 'returned', 'pending'].includes(d.status) && d.driver_id === currentUser?.id).length === 0
              ? <p className="text-sm text-slate-500 py-4">No active stops to adjust</p>
              : <QuickRouteAdjustments deliveries={deliveriesWithStopOrder} currentUser={currentUser} patients={patients} stores={stores} onReorder={handleQuickReorder} onAddDelay={handleAddDelay} />
            }
          </DialogContent>
        </Dialog>
      }

      {/* AI Smart Prioritization Dialog */}
      {isDriver &&
        <Dialog open={showSmartPrioritization} onOpenChange={setShowSmartPrioritization}>
          <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto z-[10001]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2" style={{ color: 'var(--text-slate-900)' }}>
                <Sparkles className="w-5 h-5 text-purple-600" />
                AI Route Intelligence
              </DialogTitle>
            </DialogHeader>
            <SmartPrioritizationPanel driverId={currentUser?.id} deliveryDate={selectedDateStr} currentUser={currentUser}
              onApplySuggestion={async (suggestion) => {
                if (suggestion.action?.type === 'move_to_next') {
                  const d = deliveriesWithStopOrder.find(d => d?.id === suggestion.deliveryId);
                  if (d) { await handleStartDelivery(d.id); setShowSmartPrioritization(false); }
                }
              }} />
          </DialogContent>
        </Dialog>
      }
    </div>
  );
}