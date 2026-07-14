import { AnimatePresence } from "framer-motion";
import { base44 } from "@/api/base44Client";
import { isInterStoreDelivery } from '@/components/utils/interStoreDisplayName';
import { Button } from "@/components/ui/button";
import { format } from 'date-fns';
import PatientHistoryPanel from '@/components/dashboard/PatientHistoryPanel';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import DeliveryForm from "@/components/deliveries/DeliveryForm";
import PatientForm from "@/components/patients/PatientForm";
import RouteOptimizationSettings from "@/components/dashboard/RouteOptimizationSettings";
import RouteNotification from "@/components/dashboard/RouteNotification";
import ProactiveAlertSystem from "@/components/dashboard/ProactiveAlertSystem";
import DispatcherPickupNotification from '@/components/dashboard/DispatcherPickupNotification';
import ReconcileToast from '@/components/dashboard/ReconcileToast';
import QuickRouteAdjustments from '@/components/dashboard/QuickRouteAdjustments';
import ModeSelectionDialog from '@/components/dashboard/ModeSelectionDialog';
import useModeRouteDialog from '@/components/dashboard/useModeRouteDialog';

import EndOfDayStatsDialog from '@/components/dashboard/EndOfDayStatsDialog';

import { useEffect, useState } from 'react';

export default function DashboardDialogs({
  currentUser, isDriver, isDispatcher,
  deliveries, patients, stores, drivers, appUsers, cities,
  filteredDeliveries, deliveriesWithStopOrder,
  selectedDate, selectedDateStr, selectedDriverId,
  driverLocation,
  // Forms
  showDeliveryForm, setShowDeliveryForm, editingDelivery, setEditingDelivery,
  showPatientForm, setShowPatientForm, editingPatient, setEditingPatient,
  patientFormCallback, setPatientFormCallback, patientFormMode, setPatientFormMode,
  showOptimizationSettings, setShowOptimizationSettings,
  showQuickAdjustments, setShowQuickAdjustments,
  // Handlers
  handleSaveDelivery, handleSavePatient, handleCreatePatientFromDelivery,
  handleQuickReorder, handleAddDelay, handleStartDelivery,
  // Modals
  showRouteSummary, setShowRouteSummary, summaryDriver, setSummaryDriver,
  showEndOfDayStats, setShowEndOfDayStats, endOfDayDriver, setEndOfDayDriver,
  isEntityUpdating,
  routeNotification, setRouteNotification,
  // Stats from dashboard card
  performanceStats, localStats,
  // AI
  isAIEnabled,
  // Misc
  refreshUser,
  // Mode dialog (cycling)
  setPreferredTravelMode,
}) {
  const [historyPatient, setHistoryPatient] = useState(null);

  useEffect(() => {
    const handler = (e) => {
      const { patient, patientId } = e.detail || {};
      if (patient) {
        setHistoryPatient(patient);
      } else if (patientId) {
        const found = patients?.find((p) => p?.id === patientId);
        setHistoryPatient(found || null);
      }
    };
    window.addEventListener('openPatientHistoryPanel', handler);
    return () => window.removeEventListener('openPatientHistoryPanel', handler);
  }, [patients]);

  const {
    modeDialogOpen, setModeDialogOpen,
    nearbyModeStops, selectedModeStopIds, toggleModeStop,
    returnToCurrentLocation, toggleReturnToCurrentLocation,
    handleModeOptimize, isOptimizingModeRoute,
  } = useModeRouteDialog({
    currentUser,
    appUsers,
    driverLocation,
    deliveriesWithStopOrder,
    patients,
    stores,
    setPreferredTravelMode: setPreferredTravelMode || (() => {}),
    selectedDate,
  });

  // NOTE: openCyclingModeDialog is handled by useModeRouteDialog (pre-seeds cycling stops).
  // No duplicate listener here.

  return (
    <>
      <AnimatePresence>
        {showDeliveryForm && <DeliveryForm delivery={editingDelivery} patients={patients} stores={stores} drivers={drivers} cities={cities} onSave={handleSaveDelivery} onCancel={() => { setShowDeliveryForm(false); setEditingDelivery(null); }} suggestedDate={format(selectedDate, 'yyyy-MM-dd')} currentUser={currentUser} allDeliveries={deliveries} onCreatePatient={handleCreatePatientFromDelivery} defaultToPickupMode={!!editingDelivery && !editingDelivery.patient_id} openMode={editingDelivery && isInterStoreDelivery(editingDelivery.delivery_id) ? 'interstore_edit' : null} />}
      </AnimatePresence>

      <AnimatePresence>
        {showPatientForm && <PatientForm patient={editingPatient} stores={stores} cities={[]} currentUser={currentUser} allPatients={patients} duplicateMode={patientFormMode} onSave={handleSavePatient} onCancel={() => { setShowPatientForm(false); setEditingPatient(null); setPatientFormCallback(null); setPatientFormMode(null); }} returnPatientOnSave={!!patientFormCallback} onCreateDuplicate={(p) => { setPatientFormMode('newAddress'); setEditingPatient(p); }} />}
      </AnimatePresence>

      <Dialog open={showOptimizationSettings} onOpenChange={setShowOptimizationSettings}>
        <DialogContent className="max-w-2xl max-h-[90vh] p-0 z-[10000]">
          <RouteOptimizationSettings onClose={() => setShowOptimizationSettings(false)} currentUser={currentUser} />
        </DialogContent>
      </Dialog>

      <AnimatePresence>
        {showEndOfDayStats && (() => {
          const isAllDrivers = !selectedDriverId || selectedDriverId === 'all';
          const selectedDriver = endOfDayDriver ||
            (!isAllDrivers
              ? (appUsers.find(au => au?.user_id === selectedDriverId) || drivers.find(d => d?.id === selectedDriverId))
              : null) ||
            (isAllDrivers ? { user_name: 'All Drivers' } : currentUser);
          return (
            <EndOfDayStatsDialog
              isOpen={showEndOfDayStats}
              onClose={() => { setShowEndOfDayStats(false); setEndOfDayDriver(null); }}
              deliveries={filteredDeliveries}
              allYearDeliveries={deliveries || []}
              driver={selectedDriver}
              deliveryDate={format(selectedDate, 'yyyy-MM-dd')}
              isProcessing={isEntityUpdating}
              performanceStats={performanceStats}
              localStats={localStats}
              isRouteComplete={!!endOfDayDriver}
            />
          );
        })()}
      </AnimatePresence>

      <RouteNotification notification={routeNotification} onDismiss={() => setRouteNotification(null)} onNavigate={() => {
        const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
        const next = deliveriesWithStopOrder.find(d => d && d.isNextDelivery && !finishedStatuses.includes(d.status));
        if (next) { const el = document.getElementById(`stop-card-${next.id}`); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }); }
      }} />

      {isDriver && isAIEnabled && <ProactiveAlertSystem currentUser={currentUser} deliveries={filteredDeliveries} patients={patients} stores={stores} driverLocation={driverLocation} isEnabled={isAIEnabled} onAlert={() => {}} />}

      <ReconcileToast />

      <ModeSelectionDialog
        open={modeDialogOpen}
        onOpenChange={setModeDialogOpen}
        modeLabel="Cycling"
        nearbyStops={nearbyModeStops}
        selectedStopIds={selectedModeStopIds}
        onToggleStop={toggleModeStop}
        returnToCurrentLocation={returnToCurrentLocation}
        onToggleReturn={toggleReturnToCurrentLocation}
        onOptimize={handleModeOptimize}
        isSubmitting={isOptimizingModeRoute}
      />

      <DispatcherPickupNotification deliveries={deliveries} stores={stores} appUsers={appUsers} currentUser={currentUser} isDispatcher={isDispatcher} />

      <PatientHistoryPanel
        patient={historyPatient}
        currentUser={currentUser}
        onClose={() => {
          setHistoryPatient(null);
          window.dispatchEvent(new CustomEvent('patientHistoryPanelClosed'));
        }}
        onEditDelivery={(delivery) => {
          setHistoryPatient(null);
          setEditingDelivery(delivery);
          setShowDeliveryForm(true);
        }}
      />

      <Dialog open={isDriver ? showQuickAdjustments : false} onOpenChange={(open) => {
        if (!open) {
          setShowQuickAdjustments(false);
          window.dispatchEvent(new CustomEvent('resumeBackgroundSync'));
        } else {
          window.dispatchEvent(new CustomEvent('pauseBackgroundSync'));
          setShowQuickAdjustments(true);
        }
      }}>
        <DialogContent className="max-w-[300px] max-h-[80vh] overflow-hidden z-[10001]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
          <DialogHeader><DialogTitle style={{ color: 'var(--text-slate-900)' }}>Quick Route Adjustments</DialogTitle></DialogHeader>
          <QuickRouteAdjustments
            deliveries={deliveriesWithStopOrder}
            patients={patients}
            stores={stores}
            onCancel={() => setShowQuickAdjustments(false)}
            onReoptimize={async (reorderPayload) => {
              try {
                const orderedDeliveryIds = reorderPayload.map(u => u.id);
                const deliveryDate = format(selectedDate, 'yyyy-MM-dd');
                const targetDriverId = selectedDriverId && selectedDriverId !== 'all' ? selectedDriverId : currentUser.id;

                const allRouteDeliveries = (deliveriesWithStopOrder || [])
                  .filter(d => d && d.driver_id === targetDriverId && d.delivery_date === deliveryDate)
                  .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

                const activeIds = new Set(orderedDeliveryIds);
                const finishedStatuses = new Set(['completed', 'failed', 'cancelled', 'returned']);
                const nonActiveDeliveries = allRouteDeliveries.filter(d => !activeIds.has(d.id));

                const finishedDeliveries = nonActiveDeliveries
                  .filter(d => finishedStatuses.has(d.status))
                  .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
                const pendingDeliveries = nonActiveDeliveries.filter(d => !finishedStatuses.has(d.status));

                const fullOrderedIds = [
                  ...finishedDeliveries.map(d => d.id),
                  ...orderedDeliveryIds,
                  ...pendingDeliveries.map(d => d.id)
                ];

                await Promise.all(
                  fullOrderedIds.map((id, index) =>
                    base44.entities.Delivery.update(id, { stop_order: index + 1 })
                  )
                );

                const optimisticDeliveries = allRouteDeliveries.map(d => {
                  const newOrder = fullOrderedIds.indexOf(d.id);
                  return newOrder >= 0 ? { ...d, stop_order: newOrder + 1 } : d;
                });
                window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
                  detail: { triggeredBy: 'quickReorder', freshDeliveries: optimisticDeliveries, fullReplacement: false }
                }));

                const now = new Date();
                const completionTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
                await base44.functions.invoke('purgeAndRegeneratePolylines', {
                  driverId: targetDriverId,
                  deliveryDate,
                  routeStopOrder: fullOrderedIds,
                  reason: 'route_reordered',
                  scope: 'active_only',
                  bypassDriverStatus: true,
                });

                // Wait for backend to finish writing polylines before fetching fresh data
                await new Promise(resolve => setTimeout(resolve, 1500));

                const freshDeliveries = await base44.entities.Delivery.filter({ driver_id: targetDriverId, delivery_date: deliveryDate });
                window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'quickReorder', freshDeliveries, fullReplacement: true } }));
              } catch (err) {
                console.warn('[QuickReorder] Reorder failed:', err?.message);
              } finally {
                setShowQuickAdjustments(false);
                window.dispatchEvent(new CustomEvent('resumeBackgroundSync'));
              }
            }}
          />
        </DialogContent>
      </Dialog>


    </>
  );
}