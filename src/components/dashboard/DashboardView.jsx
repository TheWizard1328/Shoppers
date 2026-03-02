import { useEffect, useRef, useState } from "react";
import { format } from 'date-fns';
import { base44 } from "@/api/base44Client";
import { isAppOwner } from '@/components/utils/userRoles';
import SnapshotTimeline from "@/components/snapshot/SnapshotTimeline";
import StatsPanel from "@/components/dashboard/StatsPanel";
import MapSection from "@/components/dashboard/MapSection";
import StopCardsSection from "@/components/dashboard/StopCardsSection";
import FABControls from "@/components/dashboard/FABControls";
import DashboardDialogs from "@/components/dashboard/DashboardDialogs";

export default function DashboardView({
  // User & roles
  currentUser, isDriver, isAdmin, isDispatcher, isMobile,
  // Data
  deliveries, patients, stores, drivers, appUsers,
  filteredDeliveries, deliveriesWithStopOrder, stats, driversList,
  // Date & driver selection
  selectedDate, selectedDateStr, selectedDriverId, calendarMonth, setCalendarMonth,
  isCalendarOpen, setIsCalendarOpen, handleDateChange, handleDriverChange,
  isDriverDropdownDisabled, isAllDriversMode, isDateFinished,
  // Map state
  mapCenter, mapZoom, shouldFitBounds, setShouldFitBounds, setMapCenter, setMapZoom,
  mapMode, setMapMode, mapViewPhase, setMapViewPhase, isMapViewLocked, setIsMapViewLocked,
  driverLocation, allDriverLocations, currentToNextPolyline, driverRoutes, setDriverRoutes,
  showRoutes, setShowRoutes, showAllDriverMarkers, setShowAllDriverMarkers,
  showBreadcrumbs, setShowBreadcrumbs, breadcrumbsData, setBreadcrumbsData,
  highlightedCardId, retractClustersRef, googleApiKey, renderSequence, setRenderSequence,
  stopCardsBaseHeight, statsCardBaseHeight, statsCardRef, cardsReadyForFAB,
  mapLockTimeoutRef, mapLockExpiresAtRef, lastProgrammaticMapMoveRef,
  // FAB
  handleMapViewCycle, mapViewTrigger, setMapViewTrigger, getMapPadding,
  // Stats panel
  statsPanelOpacity, isExpanded, setIsExpanded, areCardsVisible,
  handleStatsPanelInteraction, handleCardInteraction, isStatsCardCentered,
  statsCardPositioning, pullToSyncKey, stopCardsContainerRef, horizontalStopCardsRef,
  // Optimization
  optimizationMessage, setOptimizationMessage, isOptimizing, isReoptimizing, setIsReoptimizing,
  setIsEntityUpdating, hasRateLimitError, updateDeliveriesLocally, updateAppUsersLocally,
  // Cards
  selectedCardId, handleCardClick, handleMarkerClick,
  // Forms
  showDeliveryForm, setShowDeliveryForm, editingDelivery, setEditingDelivery,
  showPatientForm, setShowPatientForm, editingPatient, setEditingPatient,
  patientFormCallback, setPatientFormCallback, patientFormMode, setPatientFormMode,
  showOptimizationSettings, setShowOptimizationSettings,
  showQuickAdjustments, setShowQuickAdjustments,
  showSmartPrioritization, setShowSmartPrioritization,
  // Handlers
  handleSaveDelivery, handleSavePatient, handleEditDelivery, handleEditPatient,
  handleDeleteDelivery, handleRestartDelivery, handleStatusUpdate, handleNotesUpdate,
  handleCODUpdate, handleCreateReturn, handleStartDelivery,
  handleCreatePatientFromDelivery, handleQuickReorder, handleAddDelay, handleAcceptAIOptimization,
  // Modals
  showRouteSummary, setShowRouteSummary, summaryDriver, setSummaryDriver,
  showEndOfDayStats, setShowEndOfDayStats, endOfDayDriver, setEndOfDayDriver,
  routeNotification, setRouteNotification,
  // Snapshot
  isSnapshotModeActive, setIsSnapshotModeActive, snapshotData, setSnapshotData,
  // Performance
  performanceStats, deliveryStats, liveDistance, liveTimeOnDuty, isLoadingPayrollStats,
  dailyPolylineCount,
  // AI
  isAIEnabled, showAIAssistant,
  // Live ETA
  realTimeETAEnabled,
  // Misc
  refreshUser, refreshData, dataSource,
}) {
  const handleSnapshotSelect = (snapshot) => {
    if (!snapshot) return;
    setSnapshotData({
      deliveries: snapshot.snapshot_data?.deliveries || [],
      driverLocations: snapshot.snapshot_data?.driverLocations || []
    });
  };

  // Failsafe: once deliveries + patients + stores are ready on initial load, trigger a unified UI refresh
  // ALSO: re-trigger FAB map positioning if initial FAB fired with 0 deliveries but now we have data
  const initialDataReadyRef = useRef(null);
  const [finalizedDutyTime, setFinalizedDutyTime] = useState(null);
  const initialFabRetriggeredRef = useRef(false);
  useEffect(() => {
    const dateStr = format(selectedDate, 'yyyy-MM-dd');
    const hasDeliveriesForDate = Array.isArray(deliveries) && deliveries.some(d => d && d.delivery_date === dateStr);
    const hasPatients = Array.isArray(patients) && patients.length > 0;
    const hasStores = Array.isArray(stores) && stores.length > 0;

    if (hasDeliveriesForDate && hasPatients && hasStores && initialDataReadyRef.current !== dateStr) {
      initialDataReadyRef.current = dateStr;
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'initialDataReady', deliveryDate: dateStr } }));
        window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
        window.dispatchEvent(new CustomEvent('refreshPayrollStatsAfterSync'));
      }, 0);

      const filteredCount = Array.isArray(deliveriesWithStopOrder) ? deliveriesWithStopOrder.length : 0;
      if (renderSequence.fabPhaseReady && !initialFabRetriggeredRef.current && filteredCount > 0) {
        initialFabRetriggeredRef.current = true;
        console.log(`🔄 [DashboardView Failsafe] FAB fired with 0 deliveries initially — re-triggering Phase 1 with ${filteredCount} deliveries now available`);
        setTimeout(() => {
          setMapViewPhase(1);
          setIsMapViewLocked(true);
          lastProgrammaticMapMoveRef.current = Date.now();
          window._lastProgrammaticMapMove = Date.now();
          setMapViewTrigger(prev => prev + 1);
          const lockDuration = 500;
          const expiresAt = Date.now() + lockDuration;
          mapLockExpiresAtRef.current = expiresAt;
          mapLockTimeoutRef.current = setTimeout(() => {
            if (mapLockExpiresAtRef.current === expiresAt) {
              setIsMapViewLocked(false);
              mapLockExpiresAtRef.current = null;
              mapLockTimeoutRef.current = null;
            }
          }, lockDuration);
        }, 500);
      }
    }
  }, [deliveries, patients, stores, selectedDate, deliveriesWithStopOrder, renderSequence.fabPhaseReady]);

  // Freeze and display finalized Time on Duty after off-duty or when day is finished
  useEffect(() => {
    if (!currentUser || !isDriver) return;
    const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
    if (!(isDateFinished || (currentUser.driver_status === 'off_duty'))) return;

    const completed = (deliveriesWithStopOrder || []).filter(d =>
      d && d.driver_id === currentUser.id && d.delivery_date === selectedDateStr && d.status === 'completed' && d.actual_delivery_time
    );
    if (completed.length === 0) return;

    const times = completed.map(d => new Date(d.actual_delivery_time));
    const firstTime = new Date(Math.min(...times));
    const lastTime = new Date(Math.max(...times));
    const baseMinutes = Math.max(0, Math.round((lastTime - firstTime) / 60000));

    (async () => {
      try {
        const recs = await base44.entities.DriverDailyActivity.filter({ driver_id: currentUser.id, activity_date: selectedDateStr });
        const breakMin = (recs && recs[0]?.total_break_time_minutes) || 0;
        const total = Math.max(0, baseMinutes - breakMin);
        const hh = String(Math.floor(total / 60)).padStart(2, '0');
        const mm = String(total % 60).padStart(2, '0');
        setFinalizedDutyTime(`${hh}:${mm}`);
      } catch (_) {
        const hh = String(Math.floor(baseMinutes / 60)).padStart(2, '0');
        const mm = String(baseMinutes % 60).padStart(2, '0');
        setFinalizedDutyTime(`${hh}:${mm}`);
      }
    })();
  }, [isDateFinished, currentUser?.driver_status, deliveriesWithStopOrder, selectedDate, currentUser?.id, isDriver]);

  return (
    <div className="h-full w-full flex flex-col overflow-hidden" style={{ background: 'var(--bg-slate-50)' }}>

      {isSnapshotModeActive && isAppOwner(currentUser) &&
        <div className="absolute left-0 top-0 bottom-0 z-[250]">
          <SnapshotTimeline
            selectedDate={selectedDate}
            selectedDriverId={selectedDriverId}
            onSnapshotSelect={handleSnapshotSelect}
            onClose={() => { setIsSnapshotModeActive(false); setSnapshotData(null); }}
          />
        </div>
      }

      <StatsPanel
        currentUser={currentUser} isDriver={isDriver} isAdmin={isAdmin} isDispatcher={isDispatcher}
        deliveries={deliveries} drivers={drivers} stores={stores} appUsers={appUsers} driversList={driversList}
        selectedDate={selectedDate} selectedDateStr={selectedDateStr} selectedDriverId={selectedDriverId}
        calendarMonth={calendarMonth} setCalendarMonth={setCalendarMonth}
        isCalendarOpen={isCalendarOpen} setIsCalendarOpen={setIsCalendarOpen}
        handleDateChange={handleDateChange} handleDriverChange={handleDriverChange}
        isDriverDropdownDisabled={isDriverDropdownDisabled} isAllDriversMode={isAllDriversMode} isDateFinished={isDateFinished}
        showAllDriverMarkers={showAllDriverMarkers} setShowAllDriverMarkers={setShowAllDriverMarkers}
        showBreadcrumbs={showBreadcrumbs} setShowBreadcrumbs={setShowBreadcrumbs} setBreadcrumbsData={setBreadcrumbsData}
        showRoutes={showRoutes} setShowRoutes={setShowRoutes} driverRoutes={driverRoutes}
        statsCardRef={statsCardRef} retractClustersRef={retractClustersRef}
        mapLockTimeoutRef={mapLockTimeoutRef} mapLockExpiresAtRef={mapLockExpiresAtRef} lastProgrammaticMapMoveRef={lastProgrammaticMapMoveRef}
        setMapViewPhase={setMapViewPhase} setIsMapViewLocked={setIsMapViewLocked} setMapViewTrigger={setMapViewTrigger}
        statsPanelOpacity={statsPanelOpacity} isExpanded={isExpanded} setIsExpanded={setIsExpanded} areCardsVisible={areCardsVisible}
        handleStatsPanelInteraction={handleStatsPanelInteraction} handleCardInteraction={handleCardInteraction} isStatsCardCentered={isStatsCardCentered}
        statsCardPositioning={statsCardPositioning} pullToSyncKey={pullToSyncKey}
        setIsEntityUpdating={setIsEntityUpdating} hasRateLimitError={hasRateLimitError} updateDeliveriesLocally={updateDeliveriesLocally}
        setEditingDelivery={setEditingDelivery} setShowDeliveryForm={setShowDeliveryForm}
        setShowOptimizationSettings={setShowOptimizationSettings}
        setShowQuickAdjustments={setShowQuickAdjustments} setShowSmartPrioritization={setShowSmartPrioritization}
        deliveryStats={deliveryStats} performanceStats={performanceStats} liveDistance={liveDistance} liveTimeOnDuty={liveTimeOnDuty}
        isLoadingPayrollStats={isLoadingPayrollStats} dailyPolylineCount={dailyPolylineCount} stats={stats}
        finalizedDutyTime={finalizedDutyTime}
        refreshUser={refreshUser} dataSource={dataSource}
      />

      <div className="flex-1 w-full relative min-h-0 overflow-hidden">
        <MapSection
          currentUser={currentUser} isDriver={isDriver} isDispatcher={isDispatcher} isMobile={isMobile}
          deliveries={deliveries} patients={patients} stores={stores} drivers={drivers}
          filteredDeliveries={filteredDeliveries} deliveriesWithStopOrder={deliveriesWithStopOrder}
          selectedDate={selectedDate} selectedDateStr={selectedDateStr} selectedDriverId={selectedDriverId}
          mapCenter={mapCenter} mapZoom={mapZoom} shouldFitBounds={shouldFitBounds}
          setShouldFitBounds={setShouldFitBounds} setMapCenter={setMapCenter} setMapZoom={setMapZoom}
          mapMode={mapMode} setMapMode={setMapMode}
          driverLocation={driverLocation} allDriverLocations={allDriverLocations} currentToNextPolyline={currentToNextPolyline}
          showRoutes={showRoutes} showAllDriverMarkers={showAllDriverMarkers}
          showBreadcrumbs={showBreadcrumbs} breadcrumbsData={breadcrumbsData}
          highlightedCardId={highlightedCardId} retractClustersRef={retractClustersRef} googleApiKey={googleApiKey}
          setDriverRoutes={setDriverRoutes} renderSequence={renderSequence} setRenderSequence={setRenderSequence}
          stopCardsBaseHeight={stopCardsBaseHeight} handleMarkerClick={handleMarkerClick}
          handleCardInteraction={handleCardInteraction} areCardsVisible={areCardsVisible}
          handleMapViewCycle={handleMapViewCycle} isStatsCardCentered={isStatsCardCentered}
          dailyPolylineCount={dailyPolylineCount} isExpanded={isExpanded}
          realTimeETAEnabled={realTimeETAEnabled}
          showDeliveryForm={showDeliveryForm} showPatientForm={showPatientForm} showOptimizationSettings={showOptimizationSettings}
        />

        <StopCardsSection
          currentUser={currentUser} isDriver={isDriver} isAdmin={isAdmin} isDispatcher={isDispatcher} isMobile={isMobile}
          deliveries={deliveries} patients={patients} stores={stores} drivers={drivers} deliveriesWithStopOrder={deliveriesWithStopOrder}
          selectedDate={selectedDate} isAllDriversMode={isAllDriversMode} isSnapshotModeActive={isSnapshotModeActive}
          mapViewPhase={mapViewPhase} isMapViewLocked={isMapViewLocked} setIsMapViewLocked={setIsMapViewLocked} setMapViewPhase={setMapViewPhase}
          setShouldFitBounds={setShouldFitBounds} setMapCenter={setMapCenter} setMapZoom={setMapZoom} getMapPadding={getMapPadding}
          mapLockTimeoutRef={mapLockTimeoutRef} mapLockExpiresAtRef={mapLockExpiresAtRef}
          stopCardsContainerRef={stopCardsContainerRef} horizontalStopCardsRef={horizontalStopCardsRef} retractClustersRef={retractClustersRef}
          optimizationMessage={optimizationMessage} setOptimizationMessage={setOptimizationMessage} isOptimizing={isOptimizing}
          selectedCardId={selectedCardId} handleCardClick={handleCardClick}
          handleEditDelivery={handleEditDelivery} handleEditPatient={handleEditPatient} handleDeleteDelivery={handleDeleteDelivery}
          handleRestartDelivery={handleRestartDelivery} handleStatusUpdate={handleStatusUpdate} handleNotesUpdate={handleNotesUpdate}
          handleCODUpdate={handleCODUpdate} handleCreateReturn={handleCreateReturn} handleStartDelivery={handleStartDelivery}
          refreshUser={refreshUser}
        />
      </div>

      {(isDriver || isDispatcher) &&
        <FABControls
          currentUser={currentUser} isDriver={isDriver} isDispatcher={isDispatcher}
          patients={patients} stores={stores} deliveriesWithStopOrder={deliveriesWithStopOrder} filteredDeliveries={filteredDeliveries}
          selectedDate={selectedDate} selectedDriverId={selectedDriverId} isDateFinished={isDateFinished}
          mapViewPhase={mapViewPhase} isMapViewLocked={isMapViewLocked} setIsMapViewLocked={setIsMapViewLocked}
          driverLocation={driverLocation} cardsReadyForFAB={cardsReadyForFAB} stopCardsBaseHeight={stopCardsBaseHeight}
          mapLockTimeoutRef={mapLockTimeoutRef} mapLockExpiresAtRef={mapLockExpiresAtRef}
          handleMapViewCycle={handleMapViewCycle} mapViewTrigger={mapViewTrigger} setMapViewTrigger={setMapViewTrigger} getMapPadding={getMapPadding}
          setShouldFitBounds={setShouldFitBounds} setMapCenter={setMapCenter} setMapZoom={setMapZoom}
          isReoptimizing={isReoptimizing} setIsReoptimizing={setIsReoptimizing}
          optimizationMessage={optimizationMessage} setOptimizationMessage={setOptimizationMessage}
          setIsEntityUpdating={setIsEntityUpdating}
          isAIEnabled={isAIEnabled} showAIAssistant={showAIAssistant}
          refreshData={refreshData}
        />
      }

      <DashboardDialogs
        currentUser={currentUser} isDriver={isDriver} isDispatcher={isDispatcher}
        deliveries={deliveries} patients={patients} stores={stores} drivers={drivers} appUsers={appUsers}
        filteredDeliveries={filteredDeliveries} deliveriesWithStopOrder={deliveriesWithStopOrder}
        selectedDate={selectedDate} selectedDateStr={selectedDateStr}
        driverLocation={driverLocation}
        showDeliveryForm={showDeliveryForm} setShowDeliveryForm={setShowDeliveryForm}
        editingDelivery={editingDelivery} setEditingDelivery={setEditingDelivery}
        showPatientForm={showPatientForm} setShowPatientForm={setShowPatientForm}
        editingPatient={editingPatient} setEditingPatient={setEditingPatient}
        patientFormCallback={patientFormCallback} setPatientFormCallback={setPatientFormCallback}
        patientFormMode={patientFormMode} setPatientFormMode={setPatientFormMode}
        showOptimizationSettings={showOptimizationSettings} setShowOptimizationSettings={setShowOptimizationSettings}
        showQuickAdjustments={showQuickAdjustments} setShowQuickAdjustments={setShowQuickAdjustments}
        showSmartPrioritization={showSmartPrioritization} setShowSmartPrioritization={setShowSmartPrioritization}
        handleSaveDelivery={handleSaveDelivery} handleSavePatient={handleSavePatient}
        handleCreatePatientFromDelivery={handleCreatePatientFromDelivery}
        handleQuickReorder={handleQuickReorder} handleAddDelay={handleAddDelay} handleStartDelivery={handleStartDelivery}
        showRouteSummary={showRouteSummary} setShowRouteSummary={setShowRouteSummary}
        summaryDriver={summaryDriver} setSummaryDriver={setSummaryDriver}
        showEndOfDayStats={showEndOfDayStats} setShowEndOfDayStats={setShowEndOfDayStats}
        endOfDayDriver={endOfDayDriver} setEndOfDayDriver={setEndOfDayDriver}
        routeNotification={routeNotification} setRouteNotification={setRouteNotification}
        isAIEnabled={isAIEnabled}
        refreshUser={refreshUser}
      />
    </div>
  );
}