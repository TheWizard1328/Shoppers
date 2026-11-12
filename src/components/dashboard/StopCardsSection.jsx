import { useEffect, useState, useMemo, memo } from "react";
import HorizontalStopCards from "@/components/dashboard/HorizontalStopCards";
import { getDriverColor } from "@/components/dashboard/DeliveryMap";
import { createStopCardsScrollHandler } from "@/components/dashboard/StopCardsScrollHandler";

function StopCardsSection({
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

  // Notify GuideAssistant when a card expands/collapses so it can lower its z-index
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('stopCardExpandedChange', { detail: { cardId: selectedCardId || null } }));
  }, [selectedCardId]);

  // Fridge items for the selected driver + date (used to gate the temp badge)
  const selectedDateStr = selectedDate instanceof Date
    ? `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, '0')}-${String(selectedDate.getDate()).padStart(2, '0')}`
    : selectedDate;
  const hasFridgeItems = deliveriesWithStopOrder.some(
    (d) => d && d.fridge_item && d.delivery_date === selectedDateStr
  );

  // Memoize the expensive per-delivery transform so it only re-runs when deliveries,
  // patients, or role-flags actually change — not on every unrelated state update.
  const pickupCards = useMemo(() => {
    const dispStoreIds = (isDispatcher && currentUser?.store_ids?.length > 0)
      ? new Set(currentUser.store_ids)
      : null;

    const finishedStatuses = ['completed', 'failed', 'cancelled'];
    // Pre-compute allDriverDeliveries once (only needed for driver role-check)
    const allDriverDeliveries = (isDriver && !isDispatcher && !isAdmin && currentUser?.id)
      ? deliveriesWithStopOrder.filter((d) => d && d.driver_id === currentUser.id)
      : null;

    const checkIsReturn = (d) => {
      if (!d || !d.patient_id) return false;
      const p = patients.find((p) => p && p.id === d.patient_id);
      const notes = d.delivery_notes || '', name = d.patient_name || '', full = p?.full_name || '';
      return notes.toLowerCase().includes('(rtn)') || name.toLowerCase().includes('(rtn)') || full.toLowerCase().includes('(rtn)')
        || /\breturn\b/i.test(notes) || /\breturn\b/i.test(name) || /\breturn\b/i.test(full);
    };

    const routeComplete = allDriverDeliveries
      ? allDriverDeliveries.length > 0 && allDriverDeliveries.every((d) => finishedStatuses.includes(d.status) || checkIsReturn(d))
      : false;

    // A pickup is the container for the stops that share its PUID. Two things
    // broke that (owner report Nov 11 2026, stops + pickup transferred together
    // to tomorrow with the SAME PUID and still not attaching):
    //   1. a pickup whose status came back 'pending' after the date move was
    //      dropped from the container list entirely, so its own stops had no
    //      card to appear under;
    //   2. a stop whose PUID matches no pickup IN VIEW (other date, or the
    //      pickup re-created with a new stop_id) was silently orphaned.
    // Containers now survive a 'pending' status when they actually own stops,
    // and a PUID-less match falls back to store / date / AM-PM, then to
    // store / date when that pickup is unambiguous.
    const allPickupStops = deliveriesWithStopOrder.filter(
      (d) => d && !d.patient_id && d.stop_id && !d.is_cycling_start_marker && !d.is_cycling_marker
    );
    const containerStopIds = new Set(allPickupStops.map((d) => d.stop_id));
    const slotKey = (d) => `${d?.store_id || ''}|${d?.delivery_date || ''}|${d?.ampm_deliveries || 'AM'}`;
    const dayKey = (d) => `${d?.store_id || ''}|${d?.delivery_date || ''}`;

    // Pending patient stops, grouped by the pickup they name, and the ones whose
    // PUID resolves to no pickup in view.
    const pendingChildrenByPuid = new Map();
    const orphanPending = [];
    deliveriesWithStopOrder.forEach((d) => {
      if (!d || !d.patient_id || d.status !== 'pending') return;
      if (d.puid && containerStopIds.has(d.puid)) {
        if (!pendingChildrenByPuid.has(d.puid)) pendingChildrenByPuid.set(d.puid, []);
        pendingChildrenByPuid.get(d.puid).push(d);
      } else {
        orphanPending.push(d);
      }
    });

    const orphanBySlot = new Map();
    orphanPending.forEach((d) => {
      const k = slotKey(d);
      if (!orphanBySlot.has(k)) orphanBySlot.set(k, []);
      orphanBySlot.get(k).push(d);
    });

    const containerList = deliveriesWithStopOrder.filter((d) => {
      if (!d || d.patient_id || !d.stop_id || d.is_cycling_start_marker) return false;
      if (d.is_cycling_marker || d.status !== 'pending') return true;
      // Pending pickup: keep it visible only when it actually owns stops.
      return (pendingChildrenByPuid.get(d.stop_id) || []).length > 0;
    });

    // ACCEPTED-STOP CARDS (fix Nov 12 2026, Sharuk / Sherwood Park Mall): the
    // pickup-only container list above quietly dropped every patient stop that
    // was no longer 'pending'. Accept All moves stops pending -> in_transit, so
    // the driver's accepted route disappeared from the cards while the map
    // markers stayed (markers read filteredDeliveries, not this list). Any
    // live (non-finished) patient stop is its own card again, in stop_order
    // position; 'pending' stays projected inside its pickup.
    // EVERY non-pending patient stop keeps its own card, finished ones included
    // (owner report Nov 12 2026: completed / cancelled / failed stops vanished
    // after Accept All, because v29 only re-added live statuses). This matches
    // the pre-w18 behaviour: pending is the ONLY status hidden, and it is hidden
    // because it is projected inside its pickup card.
    // Rule (owner, Nov 12 2026): pending and staged stops are the ONLY ones
    // without a card. Everything else - in_transit, en_route, accepted,
    // completed, cancelled, failed, returned - keeps its card.
    const NO_CARD_STATUSES = ['pending', 'staged'];
    const cardIds = new Set(containerList.map((c) => c && c.id));
    deliveriesWithStopOrder.forEach((d) => {
      if (!d || !d.patient_id || d.is_cycling_marker) return;
      if (NO_CARD_STATUSES.includes(d.status)) return;
      cardIds.add(d.id);
    });
    const cardList = deliveriesWithStopOrder.filter((d) => d && cardIds.has(d.id));

    return cardList
      .map((delivery) => {
        if (!delivery) return delivery;

        // Attach projected pending deliveries to pickup containers
        if (!delivery.patient_id && delivery.stop_id) {
          let pending = pendingChildrenByPuid.get(delivery.stop_id) || [];
          // Orphan rescue: pending stops whose PUID points at no pickup in view.
          const k = slotKey(delivery);
          let orphans = orphanBySlot.get(k) || [];
          if (!orphans.length && !delivery.is_cycling_marker) {
            // Looser pass: same store + date, driver-matched, only when this
            // store/date has exactly one pickup to receive them.
            const dk = dayKey(delivery);
            const dayPickups = allPickupStops.filter((c) => dayKey(c) === dk);
            if (dayPickups.length === 1) {
              orphans = orphanPending.filter((o) => dayKey(o) === dk);
            }
          }
          if (orphans.length) {
            const sameDriver = orphans.filter((o) => String(o.driver_id || '') === String(delivery.driver_id || ''));
            const clusterSize = containerList.filter((c) => slotKey(c) === k).length;
            const rescued = sameDriver.length
              ? sameDriver
              : (clusterSize === 1 ? orphans : []);
            if (rescued.length) {
              const seen = new Set(pending.map((p) => p.id));
              pending = [...pending, ...rescued.filter((r) => !seen.has(r.id))];
            }
          }
          if (dispStoreIds) {
            pending = pending.filter((d) => d && dispStoreIds.has(d.store_id));
          }
          if (pending.length > 0) return { ...delivery, projected_deliveries: pending };
        }

        // Dispatcher: strip stops outside their store scope
        if (dispStoreIds && !delivery.is_cycling_marker && !currentUser.store_ids.includes(delivery.store_id)) {
          return { ...delivery, _isStripped: true };
        }

        // Driver: strip non-essential stops after route completion
        if (routeComplete) {
          const isInterStore = delivery.patient_name?.toLowerCase().includes('interstore') || delivery.delivery_notes?.toLowerCase().includes('interstore');
          const isStorePickup = !delivery.patient_id;
          if (!isInterStore && !isStorePickup) return { ...delivery, _isStripped: true };
        }

        return delivery;
      });
  }, [deliveriesWithStopOrder, patients, isDispatcher, isDriver, isAdmin, currentUser?.id, currentUser?.store_ids]);

  return (
    <div
      ref={stopCardsContainerRef} className="horizontal-cards-container absolute left-0 right-0 z-[10070] pointer-events-none flex flex-col justify-end transition-transform duration-500 ease-in-out will-change-transform"

      style={{
        position: 'absolute',
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
          pickupCards={pickupCards}
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
          isAllDriversMode={isAllDriversMode}
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

export default memo(StopCardsSection);