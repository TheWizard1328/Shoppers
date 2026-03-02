import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { flushSync } from "react-dom";
import HorizontalStopCards from "@/components/dashboard/HorizontalStopCards";
import { getDriverColor } from "@/components/dashboard/DeliveryMap";
import { createStopCardsScrollHandler } from "@/components/dashboard/StopCardsScrollHandler";

export default function StopCardsSection({
  currentUser, isDriver, isAdmin, isDispatcher, isMobile,
  deliveries, patients, stores, drivers, deliveriesWithStopOrder,
  selectedDate, isAllDriversMode, isSnapshotModeActive,
  mapViewPhase, isMapViewLocked, setIsMapViewLocked, setMapViewPhase,
  setShouldFitBounds, setMapCenter, setMapZoom, getMapPadding,
  mapLockTimeoutRef, mapLockExpiresAtRef,
  stopCardsContainerRef, horizontalStopCardsRef, retractClustersRef,
  optimizationMessage, setOptimizationMessage, isOptimizing,
  selectedCardId, handleCardClick,
  handleEditDelivery, handleEditPatient, handleDeleteDelivery,
  handleRestartDelivery, handleStatusUpdate, handleNotesUpdate,
  handleCODUpdate, handleCreateReturn, handleStartDelivery,
  refreshUser,
}) {
  return (
    <div
      ref={stopCardsContainerRef}
      className="horizontal-cards-container absolute bottom-0 right-0 z-[150] px-4 pb-1 pointer-events-none flex flex-col justify-end max-h-[80vh]"
      style={{ left: isSnapshotModeActive ? '5rem' : '0' }}
      onClick={() => { if (retractClustersRef.current) retractClustersRef.current(); }}>

      <AnimatePresence>
        {optimizationMessage && <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} className="flex justify-center mb-2 pointer-events-auto">
          <div className="rounded-lg shadow-2xl border-2 border-emerald-500 p-3 flex items-center gap-3 max-w-[90vw]" style={{ background: 'var(--bg-white)' }}>
            {isOptimizing && <div className="animate-spin w-4 h-4 border-3 border-emerald-500 border-t-transparent rounded-full flex-shrink-0"></div>}
            <p className="font-medium flex-1 text-sm" style={{ color: 'var(--text-slate-900)' }}>{optimizationMessage}</p>
            {!isOptimizing && <button onClick={() => setOptimizationMessage(null)} className="text-slate-400 hover:text-slate-600 flex-shrink-0"><X className="w-3.5 h-3.5" style={{ color: 'var(--text-slate-400)' }} /></button>}
          </div>
        </motion.div>}
      </AnimatePresence>

      <div
        className="overflow-x-auto overflow-y-visible scrollbar-thin scrollbar-thumb-slate-300 scrollbar-track-transparent pointer-events-auto"
        style={isMobile ? { scrollSnapType: 'x mandatory' } : {}}
        onWheel={e => { e.currentTarget.scrollLeft += e.deltaY; }}
        onTouchStart={() => {}}
        onScroll={isMobile ? createStopCardsScrollHandler({
          deliveriesWithStopOrder, patients, stores, mapViewPhase, isMapViewLocked,
          setIsMapViewLocked, setMapViewPhase, setShouldFitBounds, setMapCenter, setMapZoom,
          getMapPadding, mapLockTimeoutRef, mapLockExpiresAtRef
        }) : undefined}>

        {(!isAllDriversMode || isDispatcher) && (
          <HorizontalStopCards
            ref={horizontalStopCardsRef}
            pickupCards={deliveriesWithStopOrder
              .filter(delivery => delivery && delivery.status !== 'pending')
              .map(delivery => {
                if (!delivery) return delivery;
                if (!delivery.patient_id && delivery.status === 'en_route' && delivery.stop_id) {
                  let pending = deliveriesWithStopOrder.filter(d => d && d.puid === delivery.stop_id && d.status === 'pending' && d.patient_id);
                  if (isDispatcher && currentUser?.store_ids?.length > 0) {
                    const dispStoreIds = new Set(currentUser.store_ids);
                    pending = pending.filter(d => d && dispStoreIds.has(d.store_id));
                  }
                  if (pending.length > 0) return { ...delivery, projected_deliveries: pending };
                }
                if (isDispatcher && currentUser.store_ids?.length > 0 && !currentUser.store_ids.includes(delivery.store_id)) return { ...delivery, _isStripped: true };
                if (isDriver && !isDispatcher && !isAdmin) {
                  const finishedStatuses = ['completed', 'failed', 'cancelled'];
                  const allDriverDeliveries = deliveriesWithStopOrder.filter(d => d && d.driver_id === currentUser.id);
                  const checkIsReturn = d => {
                    if (!d || !d.patient_id) return false;
                    const p = patients.find(p => p && p.id === d.patient_id);
                    const notes = d.delivery_notes || '', name = d.patient_name || '', full = p?.full_name || '';
                    return notes.toLowerCase().includes('(rtn)') || name.toLowerCase().includes('(rtn)') || full.toLowerCase().includes('(rtn)') || /\breturn\b/i.test(notes) || /\breturn\b/i.test(name) || /\breturn\b/i.test(full);
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
  );
}