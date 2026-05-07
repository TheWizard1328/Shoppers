import { useEffect, useMemo, useRef, useState } from "react";
import { format } from 'date-fns';
import { base44 } from "@/api/base44Client";
import { isAppOwner } from '@/components/utils/userRoles';
import SnapshotTimeline from "@/components/snapshot/SnapshotTimeline";
import DashboardStatsPanel from "@/features/dashboard/components/DashboardStatsPanel";
import DashboardMapSection from "@/features/dashboard/components/DashboardMapSection";
import StopCardsSection from "@/components/dashboard/StopCardsSection";
import DashboardBulkEditControls from "@/components/dashboard/DashboardBulkEditControls";
import ApiUsageBadge from "@/components/dashboard/ApiUsageBadge";
import StopCardCheckboxToggle from "@/components/dashboard/StopCardCheckboxToggle";
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
  // Immersive mode
  immersiveHidden, isDriverMoving, immersiveOverrideActive, onImmersiveMapTap,
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
  preferredTravelMode, onTravelModeChange,
  mapStyle, setMapStyle,
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
  const [immersiveLiveDriverLocation, setImmersiveLiveDriverLocation] = useState(null);
  const [showStopCardCheckboxes, setShowStopCardCheckboxes] = useState(false);
  const [selectedDeliveryIds, setSelectedDeliveryIds] = useState({});
  const initialFabRetriggeredRef = useRef(false);

  const handleStopCardSelectionChange = (deliveryId, selected) => {
    setSelectedDeliveryIds((current) => {
      const next = { ...current };
      if (!deliveryId) return next;
      if (selected) next[deliveryId] = true;
      else delete next[deliveryId];
      return next;
    });
  };
  useEffect(() => {
    const dateStr = format(selectedDate, 'yyyy-MM-dd');
    const hasDeliveriesForDate = Array.isArray(deliveries) && deliveries.some(d => d && d.delivery_date === dateStr);
    const hasPatients = Array.isArray(patients) && patients.length > 0;
    const hasStores = Array.isArray(stores) && stores.length > 0;

    if (hasDeliveriesForDate && hasPatients && hasStores && initialDataReadyRef.current !== dateStr) {
      initialDataReadyRef.current = dateStr;
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'initialDataReady', deliveryDate: dateStr, fullReplacement: false, preserveLocalState: true, freshDeliveries: deliveries.filter(d => d && d.delivery_date === dateStr) } }));
        window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
        window.dispatchEvent(new CustomEvent('refreshPayrollStatsAfterSync'));
      }, 0);
    }

    // CRITICAL: Re-trigger FAB map positioning whenever deliveriesWithStopOrder gains items
    // after the FAB already fired with 0. This handles the common race condition where:
    // 1. FAB fires before offline DB loads complete (deliveriesWithStopOrder=0)
    // 2. Data arrives later via sync/WebSocket/settings-load
    // IMPORTANT: Do NOT override mapViewPhase — just re-trigger the CURRENT phase
    const filteredCount = Array.isArray(deliveriesWithStopOrder) ? deliveriesWithStopOrder.length : 0;
    if (renderSequence.fabPhaseReady && filteredCount > 0 && cardsReadyForFAB && !initialFabRetriggeredRef.current) {
      initialFabRetriggeredRef.current = true;
      console.log(`🔄 [DashboardView Failsafe] FAB fired with 0 deliveries initially — re-triggering current phase (${mapViewPhase}) with ${filteredCount} deliveries now available`);
      setTimeout(() => {
        // CRITICAL: Do NOT call setMapViewPhase here — respect the saved/current phase
        // Only re-trigger the map view to recalculate bounds with the new data
        setIsMapViewLocked(true);
        lastProgrammaticMapMoveRef.current = Date.now();
        window._lastProgrammaticMapMove = Date.now();
        setMapViewTrigger(prev => prev + 1);
        const lockDuration = 3000;
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

  useEffect(() => {
    const handleImmersiveLiveLocation = (event) => {
      const detail = event?.detail;
      if (!detail?.latitude || !detail?.longitude) return;
      setImmersiveLiveDriverLocation({
        latitude: Number(detail.latitude),
        longitude: Number(detail.longitude),
        location_updated_at: detail.location_updated_at || null
      });
    };

    window.addEventListener('driverSharedSelfLocationUpdated', handleImmersiveLiveLocation);
    return () => window.removeEventListener('driverSharedSelfLocationUpdated', handleImmersiveLiveLocation);
  }, []);

  const immersiveOverlayDelivery = useMemo(() => {
    if (!immersiveHidden) return null;
    return deliveriesWithStopOrder.find((d) => d && d.isNextDelivery === true) || null;
  }, [deliveriesWithStopOrder, immersiveHidden]);

  const immersiveOverlayPatient = useMemo(() => {
    if (!immersiveOverlayDelivery?.patient_id) return null;
    return patients.find((p) => p && (p.id === immersiveOverlayDelivery.patient_id || p.patient_id === immersiveOverlayDelivery.patient_id)) || null;
  }, [immersiveOverlayDelivery, patients]);

  const immersiveOverlayStore = useMemo(() => {
    if (!immersiveOverlayDelivery?.store_id) return null;
    return stores.find((s) => s && s.id === immersiveOverlayDelivery.store_id) || null;
  }, [immersiveOverlayDelivery, stores]);

  const immersiveOverlayIsPickup = !!immersiveOverlayDelivery && !immersiveOverlayDelivery.patient_id && !!immersiveOverlayDelivery.store_id;
  const immersiveOverlayStoreColor = immersiveOverlayStore?.color || '#10B981';
  const immersiveOverlayDisplayName = immersiveOverlayIsPickup
    ? `${immersiveOverlayStore?.name || 'Store'} Pickup`
    : immersiveOverlayPatient?.full_name || immersiveOverlayDelivery?.patient_name || 'Next stop';

  const immersiveOverlayRemainingDistanceKm = useMemo(() => {
    if (!immersiveOverlayDelivery || !selectedDriverId || selectedDriverId === 'all') return null;

    const selectedDriverLocation = selectedDriverId === currentUser?.id && immersiveLiveDriverLocation
      ? immersiveLiveDriverLocation
      : allDriverLocations.find((location) =>
          location?.user_id === selectedDriverId ||
          location?.id === selectedDriverId ||
          location?.driver_id === selectedDriverId
        ) || (selectedDriverId === currentUser?.id ? driverLocation : null);

    const driverLat = Number(
      selectedDriverLocation?.current_latitude ??
      selectedDriverLocation?.latitude ??
      selectedDriverLocation?.lat
    );
    const driverLon = Number(
      selectedDriverLocation?.current_longitude ??
      selectedDriverLocation?.longitude ??
      selectedDriverLocation?.lon
    );
    if (!Number.isFinite(driverLat) || !Number.isFinite(driverLon)) return null;

    const stopLat = Number(immersiveOverlayIsPickup ? immersiveOverlayStore?.latitude : immersiveOverlayPatient?.latitude);
    const stopLon = Number(immersiveOverlayIsPickup ? immersiveOverlayStore?.longitude : immersiveOverlayPatient?.longitude);
    if (!Number.isFinite(stopLat) || !Number.isFinite(stopLon)) return null;

    const toRad = (value) => (value * Math.PI) / 180;
    const earthRadiusKm = 6371;
    const dLat = toRad(stopLat - driverLat);
    const dLon = toRad(stopLon - driverLon);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(driverLat)) * Math.cos(toRad(stopLat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadiusKm * c;
  }, [immersiveOverlayDelivery, immersiveOverlayIsPickup, immersiveOverlayPatient, immersiveOverlayStore, immersiveLiveDriverLocation, allDriverLocations, driverLocation, selectedDriverId, currentUser?.id]);

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

      <div className="flex-1 w-full relative min-h-0 overflow-hidden">
        <div
          className="absolute top-0 left-0 right-0 z-[230] transition-transform duration-500 ease-in-out"
          style={{
            transform: immersiveHidden ? 'translateY(calc(-100% - 1rem))' : 'translateY(0)',
            opacity: immersiveHidden ? 0 : 1,
            pointerEvents: immersiveHidden ? 'none' : 'auto'
          }}
        >
        <DashboardStatsPanel
          currentUser={currentUser} isDriver={isDriver} isAdmin={isAdmin} isDispatcher={isDispatcher}
          deliveries={deliveries} filteredDeliveries={filteredDeliveries} drivers={drivers} stores={stores} appUsers={appUsers} driversList={driversList}
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
          preferredTravelMode={preferredTravelMode} onTravelModeChange={onTravelModeChange}
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
          isMobile={isMobile}
          mapStyle={mapStyle}
          setMapStyle={setMapStyle}
        />
        </div>
        <DashboardMapSection
          currentUser={currentUser} isDriver={isDriver} isDispatcher={isDispatcher} isMobile={isMobile}
          deliveries={deliveries} patients={patients} stores={stores} drivers={drivers} appUsers={appUsers}
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
          immersiveHidden={immersiveHidden}
          isDriverMoving={isDriverMoving}
          immersiveOverrideActive={immersiveOverrideActive}
          onImmersiveMapTap={onImmersiveMapTap}
          immersiveOverlayDelivery={immersiveOverlayDelivery}
          immersiveOverlayStore={immersiveOverlayStore}
          immersiveOverlayPatient={immersiveOverlayPatient}
          immersiveOverlayIsPickup={immersiveOverlayIsPickup}
          immersiveOverlayStoreColor={immersiveOverlayStoreColor}
          immersiveOverlayDisplayName={immersiveOverlayDisplayName}
          immersiveOverlayRemainingDistanceKm={immersiveOverlayRemainingDistanceKm}
          mapViewPhase={mapViewPhase}
          isMapViewLocked={isMapViewLocked}
          mapStyle={mapStyle}
        />

        <div
          className="absolute inset-x-0 bottom-0 z-[150]"
          style={{
            height: immersiveHidden ? 0 : undefined,
            overflow: immersiveHidden ? 'hidden' : 'visible',
            pointerEvents: immersiveHidden ? 'none' : 'auto'
          }}
        >
          <DashboardBulkEditControls
            deliveriesWithStopOrder={deliveriesWithStopOrder}
            drivers={drivers}
            stores={stores}
            allDeliveries={deliveries}
            currentUser={currentUser}
            isMobile={isMobile}
            stopCardsBaseHeight={stopCardsBaseHeight}
            immersiveHidden={immersiveHidden}
            refreshData={refreshData}
            selectedDeliveryIds={selectedDeliveryIds}
            onSelectionChange={handleStopCardSelectionChange}
          />
          <StopCardsSection
            currentUser={currentUser} isDriver={isDriver} isAdmin={isAdmin} isDispatcher={isDispatcher} isMobile={isMobile}
            deliveries={deliveries} patients={patients} stores={stores} drivers={drivers} deliveriesWithStopOrder={deliveriesWithStopOrder}
            selectedDate={selectedDate} isAllDriversMode={isAllDriversMode} isSnapshotModeActive={isSnapshotModeActive}
            mapViewPhase={mapViewPhase} isMapViewLocked={isMapViewLocked} setIsMapViewLocked={setIsMapViewLocked} setMapViewPhase={setMapViewPhase}
            setShouldFitBounds={setShouldFitBounds} setMapCenter={setMapCenter} setMapZoom={setMapZoom} getMapPadding={getMapPadding}
            mapLockTimeoutRef={mapLockTimeoutRef} mapLockExpiresAtRef={mapLockExpiresAtRef}
            stopCardsContainerRef={stopCardsContainerRef} horizontalStopCardsRef={horizontalStopCardsRef} retractClustersRef={retractClustersRef}
            selectedCardId={selectedCardId} handleCardClick={handleCardClick}
            immersiveHidden={immersiveHidden}
            handleEditDelivery={handleEditDelivery} handleEditPatient={handleEditPatient} handleDeleteDelivery={handleDeleteDelivery}
            handleRestartDelivery={handleRestartDelivery} handleStatusUpdate={handleStatusUpdate} handleNotesUpdate={handleNotesUpdate}
            handleCODUpdate={handleCODUpdate} handleCreateReturn={handleCreateReturn} handleStartDelivery={handleStartDelivery}
            refreshUser={refreshUser}
            showStopCardCheckboxes={showStopCardCheckboxes}
            selectedDeliveryIds={selectedDeliveryIds}
            onSelectionChange={handleStopCardSelectionChange}
          />
        </div>

        {optimizationMessage && (
          <div className="pointer-events-none fixed left-1/2 top-[5.5rem] -translate-x-1/2 z-[9998] w-full max-w-md px-4">
            <div className="pointer-events-auto rounded-xl border border-slate-200 bg-white/95 px-4 py-3 text-sm font-medium text-slate-800 shadow-xl backdrop-blur-sm">
              {optimizationMessage}
            </div>
          </div>
        )}

        <StopCardCheckboxToggle
          checked={showStopCardCheckboxes}
          onCheckedChange={(checked) => {
            const nextChecked = !!checked;
            setShowStopCardCheckboxes(nextChecked);
            if (!nextChecked) {
              setSelectedDeliveryIds({});
            }
          }}
          stopCardsHeight={!immersiveHidden && cardsReadyForFAB ? stopCardsBaseHeight : 0}
          hasVisibleCards={!immersiveHidden && deliveriesWithStopOrder.length > 0}
          immersiveHidden={immersiveHidden}
        >
          <ApiUsageBadge currentUser={currentUser} stopCardsHeight={immersiveHidden ? 0 : stopCardsBaseHeight} />
        </StopCardCheckboxToggle>
      </div>

      {isAppOwner(currentUser) && (isDriver || isDispatcher) &&
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
          immersiveHidden={immersiveHidden}
          topOverlayHeight={immersiveHidden ? 0 : statsCardBaseHeight}
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