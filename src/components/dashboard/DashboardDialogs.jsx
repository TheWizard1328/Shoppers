import { AnimatePresence } from "framer-motion";
import { base44 } from "@/api/base44Client";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { format } from 'date-fns';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import DeliveryForm from "@/components/deliveries/DeliveryForm";
import PatientForm from "@/components/patients/PatientForm";
import RouteOptimizationSettings from "@/components/dashboard/RouteOptimizationSettings";
import RouteSummaryModal from "@/components/dashboard/RouteSummaryModal";
import RouteNotification from "@/components/dashboard/RouteNotification";
import ProactiveAlertSystem from "@/components/dashboard/ProactiveAlertSystem";
import SmartPrioritizationPanel from '@/components/dashboard/SmartPrioritizationPanel';
import EndOfDayStatsDialog from '@/components/dashboard/EndOfDayStatsDialog';
import DispatcherPickupNotification from '@/components/dashboard/DispatcherPickupNotification';
import ReconcileToast from '@/components/dashboard/ReconcileToast';
import QuickRouteAdjustments from '@/components/dashboard/QuickRouteAdjustments';

export default function DashboardDialogs({
  currentUser, isDriver, isDispatcher,
  deliveries, patients, stores, drivers, appUsers,
  filteredDeliveries, deliveriesWithStopOrder,
  selectedDate, selectedDateStr, selectedDriverId,
  driverLocation,
  // Forms
  showDeliveryForm, setShowDeliveryForm, editingDelivery, setEditingDelivery,
  showPatientForm, setShowPatientForm, editingPatient, setEditingPatient,
  patientFormCallback, setPatientFormCallback, patientFormMode, setPatientFormMode,
  showOptimizationSettings, setShowOptimizationSettings,
  showQuickAdjustments, setShowQuickAdjustments,
  showSmartPrioritization, setShowSmartPrioritization,
  // Handlers
  handleSaveDelivery, handleSavePatient, handleCreatePatientFromDelivery,
  handleQuickReorder, handleAddDelay, handleStartDelivery,
  // Modals
  showRouteSummary, setShowRouteSummary, summaryDriver, setSummaryDriver,
  showEndOfDayStats, setShowEndOfDayStats, endOfDayDriver, setEndOfDayDriver,
  routeNotification, setRouteNotification,
  // AI
  isAIEnabled,
  // Misc
  refreshUser,
}) {
  return (
    <>
      <AnimatePresence>
        {showDeliveryForm && <DeliveryForm delivery={editingDelivery} patients={patients} stores={stores} drivers={drivers} onSave={handleSaveDelivery} onCancel={() => { setShowDeliveryForm(false); setEditingDelivery(null); }} suggestedDate={format(selectedDate, 'yyyy-MM-dd')} currentUser={currentUser} allDeliveries={deliveries} onCreatePatient={handleCreatePatientFromDelivery} defaultToPickupMode={!!editingDelivery && !editingDelivery.patient_id} />}
      </AnimatePresence>

      <AnimatePresence>
        {showPatientForm && <PatientForm patient={editingPatient} stores={stores} cities={[]} currentUser={currentUser} allPatients={patients} duplicateMode={patientFormMode} onSave={handleSavePatient} onCancel={() => { setShowPatientForm(false); setEditingPatient(null); setPatientFormCallback(null); setPatientFormMode(null); }} returnPatientOnSave={!!patientFormCallback} />}
      </AnimatePresence>

      <Dialog open={showOptimizationSettings} onOpenChange={setShowOptimizationSettings}>
        <DialogContent className="max-w-2xl max-h-[90vh] p-0 z-[10000]">
          <RouteOptimizationSettings onClose={() => setShowOptimizationSettings(false)} currentUser={currentUser} />
        </DialogContent>
      </Dialog>

      <AnimatePresence>
        {showRouteSummary && <RouteSummaryModal deliveries={filteredDeliveries} patients={patients} stores={stores} driver={summaryDriver || currentUser} onClose={async () => { setShowRouteSummary(false); setSummaryDriver(null); if (isDriver && currentUser?.id) await refreshUser(); }} />}
      </AnimatePresence>

      <AnimatePresence>
        {showEndOfDayStats && <EndOfDayStatsDialog isOpen={showEndOfDayStats} onClose={() => { setShowEndOfDayStats(false); setEndOfDayDriver(null); }} deliveries={filteredDeliveries} driver={endOfDayDriver || currentUser} deliveryDate={format(selectedDate, 'yyyy-MM-dd')} />}
      </AnimatePresence>

      <RouteNotification notification={routeNotification} onDismiss={() => setRouteNotification(null)} onNavigate={() => {
        const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
        const next = deliveriesWithStopOrder.find(d => d && d.isNextDelivery && !finishedStatuses.includes(d.status));
        if (next) { const el = document.getElementById(`stop-card-${next.id}`); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }); }
      }} />

      {isDriver && isAIEnabled && <ProactiveAlertSystem currentUser={currentUser} deliveries={filteredDeliveries} patients={patients} stores={stores} driverLocation={driverLocation} isEnabled={isAIEnabled} onAlert={() => {}} />}

      <ReconcileToast />

      <DispatcherPickupNotification deliveries={deliveries} stores={stores} appUsers={appUsers} currentUser={currentUser} isDispatcher={isDispatcher} />

      {isDriver && <Dialog open={showQuickAdjustments} onOpenChange={(open) => {
        if (!open) {
          setShowQuickAdjustments(false);
          // Resume background sync when dialog closes
          window.dispatchEvent(new CustomEvent('resumeBackgroundSync'));
        } else {
          // Pause background sync when dialog opens
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

                // Build a complete ordered list: active stops in new dragged order,
                // then append any non-active stops that were excluded from drag UI
                const allRouteDeliveries = (deliveriesWithStopOrder || [])
                  .filter(d => d && d.driver_id === targetDriverId && d.delivery_date === deliveryDate)
                  .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

                const activeIds = new Set(orderedDeliveryIds);
                const nonActiveDeliveries = allRouteDeliveries.filter(d => !activeIds.has(d.id));

                // Assign new stop_order values: active stops first (in dragged order), then non-active
                const fullOrderedIds = [...orderedDeliveryIds, ...nonActiveDeliveries.map(d => d.id)];

                // Persist new stop_order to backend
                await Promise.all(
                  fullOrderedIds.map((id, index) =>
                    base44.entities.Delivery.update(id, { stop_order: index + 1 })
                  )
                );

                // Optimistically update UI immediately so cards reorder right away
                const optimisticDeliveries = allRouteDeliveries.map(d => {
                  const newOrder = fullOrderedIds.indexOf(d.id);
                  return newOrder >= 0 ? { ...d, stop_order: newOrder + 1 } : d;
                });
                window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
                  detail: { triggeredBy: 'quickReorder', freshDeliveries: optimisticDeliveries, fullReplacement: false }
                }));

                // Regenerate polylines with the new order
                const now = new Date();
                const completionTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
                await base44.functions.invoke('purgeAndRegeneratePolylines', {
                  driverId: targetDriverId,
                  deliveryDate,
                  orderedDeliveryIds: fullOrderedIds,
                  recalculateEtas: true,
                  completionTime
                });

                // Final refresh with fresh backend data
                const freshDeliveries = await base44.entities.Delivery.filter({ driver_id: targetDriverId, delivery_date: deliveryDate });
                window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'quickReorder', freshDeliveries, fullReplacement: false } }));

                // Broadcast changes to all other connected devices
                await base44.functions.invoke('forceDriverSyncRefresh', {
                  driverId: targetDriverId,
                  deliveryDate,
                  triggeredBy: 'quickReorder'
                }).catch(() => {}); // non-critical, silent fail
              } catch (err) {
                console.warn('[QuickReorder] Reorder failed:', err?.message);
              } finally {
                setShowQuickAdjustments(false);
                window.dispatchEvent(new CustomEvent('resumeBackgroundSync'));
              }
            }}
          />
        </DialogContent>
      </Dialog>}

      {isDriver && <Dialog open={showSmartPrioritization} onOpenChange={setShowSmartPrioritization}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto z-[10001]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
          <DialogHeader><DialogTitle className="flex items-center gap-2" style={{ color: 'var(--text-slate-900)' }}><Sparkles className="w-5 h-5 text-purple-600" />AI Route Intelligence</DialogTitle></DialogHeader>
          <SmartPrioritizationPanel driverId={currentUser?.id} deliveryDate={selectedDateStr} currentUser={currentUser}
            onApplySuggestion={async suggestion => {
              if (suggestion.action?.type === 'move_to_next') {
                const d = deliveriesWithStopOrder.find(d => d?.id === suggestion.deliveryId);
                if (d) { await handleStartDelivery(d.id); setShowSmartPrioritization(false); }
              }
            }} />
        </DialogContent>
      </Dialog>}
    </>
  );
}