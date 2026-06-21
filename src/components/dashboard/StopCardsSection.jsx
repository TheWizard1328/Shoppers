import { useEffect, useState } from "react";
import HorizontalStopCards from "@/components/dashboard/HorizontalStopCards";
import { getDriverColor } from "@/components/dashboard/DeliveryMap";
import { createStopCardsScrollHandler } from "@/components/dashboard/StopCardsScrollHandler";

export default function StopCardsSection({
  currentUser, isDriver, isAdmin, isDispatcher, isMobile,
  deliveries, patients, stores, drivers, appUsers, deliveriesWithStopOrder,
  selectedDate, isAllDriversMode, isSnapshotModeActive,
  mapViewPhase, isMapViewLocked, setIsMapViewLocked, setMapViewPhase,
  setShouldFitBounds, setMapCenter, setMapZoom, getMapPadding,
  mapLockTimeoutRef, mapLockExpiresAtRef,
  stopCardsContainerRef, horizontalStopCardsRef, retractClustersRef,
  selectedCardId, handleCardClick,
  immersiveHidden,
  handleEditDelivery, handleEditPatient, handleDeleteDelivery,
  handleRestartDelivery, handleStatusUpdate, handleNotesUpdate,
  handleCODUpdate, handleCreateReturn, handleStartDelivery,
  refreshUser, showStopCardCheckboxes = false,
  selectedDeliveryIds = {},
  onSelectionChange,
  // Card swipe → map fit support
  driverLocation = null,
  allDriverLocations = [],
  selectedDriverId = null,
  onCenteredCardChange = null,
  // Temp badge
  stopCardsBaseHeight = 75,
}) {

  // Fridge items for the selected driver + date (used to gate the temp badge)
  const selectedDateStr = selectedDate instanceof Date
    ? `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, '0')}-${String(selectedDate.getDate()).padStart(2, '0')}`
    : selectedDate;
  const hasFridgeItems = deliveriesWithStopOrder.some(
    (d) => d && d.fridge_item && d.delivery_date === selectedDateStr
  );

  return (
    <div
      ref={stopCardsContainerRef} className="horizontal-cards-container absolute left-0 right-0 z-[650] pointer-events-none flex flex-col justify-end transition-transform duration-500 ease-in-out will-change-transform"

      style={{
        position: 'absolute',
        isolation: 'isolate',
        left: isSnapshotModeActive ? '5rem' : '0',
        top: 'auto',
        bottom: 'calc(var(--bottom-nav-height, 0px) + 0.25rem)',
        height: 'auto',
        minHeight: undefined,
        transform: immersiveHidden ? 'translateY(calc(100% + 1rem))' : 'translateY(0)',
        opacity: immersiveHidden ? 0 : 1,
        pointerEvents: immersiveHidden ? 'none' : 'auto',
        visibility: immersiveHidden ? 'hidden' : 'visible'
      }}
      onClick={() => {if (retractClustersRef.current) retractClustersRef.current();}}>

      <div
        className="overflow-x-auto overflow-y-visible scrollbar-thin scrollbar-thumb-slate-300 scrollbar-track-transparent pointer-events-auto"
        style={isMobile ? { scrollSnapType: 'x mandatory' } : {}}
        onWheel={(e) => {
          if (!e.deltaY) return;
          e.stopPropagation();
          e.currentTarget.scrollLeft += e.deltaY;
        }}
        onTouchStart={() => {}}
        onScroll={isMobile ? createStopCardsScrollHandler({
          deliveriesWithStopOrder, patients, stores, appUsers, currentUser,
          driverLocation, allDriverLocations, selectedDriverId,
          mapViewPhase, isMapViewLocked,
          setIsMapViewLocked, setMapViewPhase, setShouldFitBounds, setMapCenter, setMapZoom,
          getMapPadding, mapLockTimeoutRef, mapLockExpiresAtRef,
          onCenteredCardChange,
        }) : undefined}>

        {deliveriesWithStopOrder.length > 0 &&
        <HorizontalStopCards
          ref={horizontalStopCardsRef}
          isSnapshotModeActive={isSnapshotModeActive}
          pickupCards={deliveriesWithStopOrder.
          filter((delivery) => delivery && (delivery.is_cycling_marker || delivery.status !== 'pending') && !delivery.is_cycling_start_marker).
          map((delivery) => {
            if (!delivery) return delivery;
            if (!delivery.patient_id && (delivery.status === 'en_route' || delivery.status === 'pending') && delivery.stop_id) {
              let pending = deliveriesWithStopOrder.filter((d) => d && d.puid === delivery.stop_id && d.status === 'pending' && d.patient_id);
              if (isDispatcher && currentUser?.store_ids?.length > 0) {
                const dispStoreIds = new Set(currentUser.store_ids);
                pending = pending.filter((d) => d && dispStoreIds.has(d.store_id));
              }
              if (pending.length > 0) return { ...delivery, projected_deliveries: pending };
            }
            if (isDispatcher && currentUser.store_ids?.length > 0 && !delivery.is_cycling_marker && !currentUser.store_ids.includes(delivery.store_id)) return { ...delivery, _isStripped: true };
            if (isDriver && !isDispatcher && !isAdmin) {
              const finishedStatuses = ['completed', 'failed', 'cancelled'];
              const allDriverDeliveries = deliveriesWithStopOrder.filter((d) => d && d.driver_id === currentUser.id);
              const checkIsReturn = (d) => {
                if (!d || !d.patient_id) return false;
                const p = patients.find((p) => p && p.id === d.patient_id);
                const notes = d.delivery_notes || '',name = d.patient_name || '',full = p?.full_name || '';
                return notes.toLowerCase().includes('(rtn)') || name.toLowerCase().includes('(rtn)') || full.toLowerCase().includes('(rtn)') || /\breturn\b/i.test(notes) || /\breturn\b/i.test(name) || /\breturn\b/i.test(full);
              };
              const routeComplete = allDriverDeliveries.length > 0 && allDriverDeliveries.every((d) => finishedStatuses.includes(d.status) || checkIsReturn(d));
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
          onSelectionChange={onSelectionChange}
          selectedDeliveryIds={selectedDeliveryIds}
          stopOrder={{}}
          bulkSelectionEnabled={showStopCardCheckboxes}
          showDriverName={isAllDriversMode}
          getDriverColor={getDriverColor}
          onEdit={handleEditDelivery}
          onEditPatient={handleEditPatient}
          onDelete={handleDeleteDelivery}
          onRestart={handleRestartDelivery}
          onStatusUpdate={handleStatusUpdate}
          onNotesUpdate={handleNotesUpdate}
          onCODUpdate={handleCODUpdate}
          onCreateReturn={handleCreateReturn}
          onStartDelivery={handleStartDelivery}
          allDeliveries={deliveries}
          selectedDate={selectedDate}
          appUsers={appUsers}
          onCenteredCardChange={onCenteredCardChange}
          onDriverStatusChange={async () => {await refreshUser();}} />
        }
      </div>
    </div>);

}