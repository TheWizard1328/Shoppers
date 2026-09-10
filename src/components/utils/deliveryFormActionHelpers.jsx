import { isAppOwner } from './userRoles';
import { calculateRealTimeETA } from '@/functions/calculateRealTimeETA';
import { base44 } from '@/api/base44Client';

let managerControllersPromise;
let lastPostDeliverySyncKey = null;
let lastPostDeliverySyncAt = 0;

const shouldCatchBackgroundDeliveryError = (currentUser) => {
  const isLiveApp = typeof window !== 'undefined' && !window.location.hostname.includes('preview-sandbox');
  return isLiveApp && !isAppOwner(currentUser);
};

const getManagerControllers = async () => {
  if (!managerControllersPromise) {
    managerControllersPromise = Promise.all([
      import("./smartRefreshManager"),
      import("./driverLocationPoller"),
      import("./routePolylineManager"),
      import("./fabControlEvents")
    ]);
  }

  const [
    { smartRefreshManager },
    { driverLocationPoller },
    { routePolylineManager },
    { fabControlEvents }
  ] = await managerControllersPromise;

  return { smartRefreshManager, driverLocationPoller, routePolylineManager, fabControlEvents };
};

export const getClearedDraftFormData = (prev) => ({
  ...prev,
  // Record-identity scrub — must stay in sync with getClearedDraftFields()
  // (deliveryDraftStateHelpers.jsx). Prevents id/status of a previously edited
  // pending stop from leaking into the next staged stop. See notes there.
  id: null,
  status: 'Staged',
  stop_id: '',
  tracking_number: '',
  arrival_time: '',
  actual_delivery_time: '',
  isNextDelivery: false,
  _wasEdited: false,
  _tempId: null,
  _interstore_source_id: null,
  _interstore_dest_id: null,
  delivery_id: '',
  puid: '',
  patient_id: '',
  patient_name: '',
  patient_phone: '',
  unit_number: '',
  delivery_instructions: '',
  delivery_notes: '',
  prescription_number: '',
  cod_total_amount_required: 0,
  cod_payments: [],
  cod_payment_type: 'No Payment',
  cod_amount: '',
  mailbox_ok: false,
  call_upon_arrival: false,
  ring_bell: false,
  dont_ring_bell: false,
  back_door: false,
  signature_needed: false,
  fridge_item: false,
  oversized: false,
  no_charge: false,
  store_id: '',
  delivery_time_start: '',
  delivery_time_end: '',
  time_window_start: '',
  time_window_end: '',
  barcode_values: [],
  receipt_barcode_values: [],
  recurring: false,
  recurring_daily: false,
  recurring_weekly_mon: false,
  recurring_weekly_tue: false,
  recurring_weekly_wed: false,
  recurring_weekly_thu: false,
  recurring_weekly_fri: false,
  recurring_weekly_sat: false,
  recurring_weekly_sun: false,
  recurring_biweekly: false,
  recurring_weekly_x4: false,
  recurring_monthly: false,
  recurring_bimonthly: false
});

export const resumeDeliveryFormManagers = async () => {
  const { smartRefreshManager, driverLocationPoller, routePolylineManager, fabControlEvents } = await getManagerControllers();

  smartRefreshManager.resume();
  driverLocationPoller.resume();
  routePolylineManager?.resume?.();
  fabControlEvents.resumeFAB();
};

export const closeDeliveryFormAfterSave = ({ handleClearForm, onCancel }) => {
  handleClearForm();
  onCancel();
};

/**
 * Runs any pending InterStore (ISP/ISD) optimizations that were deferred during
 * the form session. Called when the delivery form closes (Done/Cancel/Save).
 *
 * Optimization is deferred so the user can add multiple ISP/ISD stops in one
 * session and they all get optimized together in a single pass — instead of
 * running the optimizer on every individual "+ Interstore" click.
 */
export const flushPendingInterStoreOptimizations = async () => {
  // Delegate to the deferred flush (local-delivery based) so every call site —
  // auto-close, cancel/close, pickup branch — uses the same robust path that
  // includes the just-created InterStore stop without a backend propagation race.
  return flushPendingInterStoreOptimizationsDeferred();
};

/**
 * Runs any pending InterStore (ISP/ISD) optimizations through the SAME deferred
 * optimization path (requestDeferredOptimization → debouncer → performRouteOptimization)
 * that the regular Done / handleBatchSave path uses for newly-created stops.
 *
 * InterStore stops are persisted directly by createInterStoreTransfer (never staged),
 * so handleBatchSave's staged-route requestDeferredOptimization call does not cover
 * them. Routing their flush through the debouncer guarantees the identical debounce,
 * KITT bar / orange overlay UI, and HERE routing behaviour as a regular delivery Done.
 */
export const flushPendingInterStoreOptimizationsDeferred = async () => {
  if (typeof window === 'undefined' || !window.__pendingInterStoreOptimizations) return;
  const pending = window.__pendingInterStoreOptimizations;
  window.__pendingInterStoreOptimizations = null;
  if (!pending || pending.length === 0) return;

  try {
    const { performRouteOptimization } = await import('@/components/utils/routeOptimizationCoordinator');
    for (const { driverId, deliveryDate, stores, appUsers } of pending) {
      if (!driverId || !deliveryDate) continue;
      try {
        // Use LOCAL deliveries/patients from window state so the just-created
        // InterStore stop is ALWAYS included — avoids a backend propagation race
        // where a fresh filter() might not yet see the new stop. Falls back to a
        // fresh backend fetch when local state isn't populated yet.
        const localDeliveries = Array.isArray(window.__appDeliveries)
          ? window.__appDeliveries.filter((d) => d && d.driver_id === driverId && d.delivery_date === deliveryDate)
          : null;
        const localPatients = Array.isArray(window.__appPatients) ? window.__appPatients : null;

        // Surface the same KITT bar / orange overlay UI the regular Done path uses
        // (handleBatchSave → routeOptimizationStarted/optimizationRunning) so the
        // dispatcher sees the optimization running, not a silent no-op.
        window.dispatchEvent(new CustomEvent('routeOptimizationStarted', { detail: { source: 'interstore_done', driverId, deliveryDate, showUI: true } }));
        window.dispatchEvent(new CustomEvent('optimizationRunning', { detail: { driverId, deliveryDate, active: true } }));
        console.log(`[InterStoreDeferred] Running optimization for driver ${driverId} on ${deliveryDate} (local deliveries: ${localDeliveries?.length ?? 0})`);
        await performRouteOptimization({
          driverId,
          deliveryDate,
          deliveries: localDeliveries && localDeliveries.length > 0 ? localDeliveries : null,
          patients: localPatients,
          stores: stores || null,   // gap-fill context for stop coordinates
          appUsers: appUsers || null,
          source: 'interstore_done',
          skipPolyline: false,
        });
        window.dispatchEvent(new CustomEvent('optimizationRunning', { detail: { driverId, deliveryDate, active: false } }));
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { driverId, deliveryDate, triggeredBy: 'interstore_done_optimization', fullReplacement: false } }));
        window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
        console.log(`[InterStoreDeferred] Optimization complete for driver ${driverId}`);
      } catch (err) {
        window.dispatchEvent(new CustomEvent('optimizationRunning', { detail: { driverId, deliveryDate, active: false } }));
        console.warn(`[InterStoreDeferred] Optimization failed for driver ${driverId}:`, err?.message || err);
      }
    }
  } catch (err) {
    console.warn('[InterStoreDeferred] Failed to load routeOptimizationCoordinator:', err?.message || err);
  }
};

export const runPostDeliveryUpdateSync = ({ driverId, deliveryDate, hasTimeWindowChanges, travelModeOnly = false, currentUser, skipStatsRefresh = false }) => {
  if (!driverId || !deliveryDate || travelModeOnly) return;

  const syncKey = `${driverId}:${deliveryDate}:${hasTimeWindowChanges ? 'optimize' : 'eta'}`;
  const now = Date.now();
  if (lastPostDeliverySyncKey === syncKey && now - lastPostDeliverySyncAt < 15000) return;
  lastPostDeliverySyncKey = syncKey;
  lastPostDeliverySyncAt = now;

  setTimeout(async () => {
    const now = new Date();
    const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    try {
      if (hasTimeWindowChanges) {
        const { performRouteOptimization } = await import('@/components/utils/routeOptimizationCoordinator');
        const optimizationResponse = await performRouteOptimization({
          driverId,
          deliveryDate,
          source: 'post_delivery_sync',
        });
      } else {
        const [driverRecords, deliveryRecords] = await Promise.all([
          base44.entities.AppUser.filter({ user_id: driverId }).catch((error) => {
            console.warn('⚠️ [DeliveryForm] Driver refresh skipped:', error?.message || error);
            return [];
          }),
          base44.entities.Delivery.filter({ driver_id: driverId, delivery_date: deliveryDate }).catch((error) => {
            console.warn('⚠️ [DeliveryForm] Delivery refresh skipped:', error?.message || error);
            return [];
          })
        ]);

        const driverRecord = driverRecords?.[0];
        const etaDeliveries = (deliveryRecords || [])
          .filter((delivery) => delivery?.status !== 'completed' && delivery?.status !== 'failed' && delivery?.status !== 'cancelled')
          .map((delivery) => ({
            id: delivery.id,
            delivery_id: delivery.delivery_id,
            latitude: delivery.latitude,
            longitude: delivery.longitude
          }))
          .filter((delivery) => Number.isFinite(Number(delivery.latitude)) && Number.isFinite(Number(delivery.longitude)));

        if (driverRecord && etaDeliveries.length > 0) {
          await calculateRealTimeETA({
            driver: driverRecord,
            currentLocation: {
              lat: driverRecord.current_latitude,
              lng: driverRecord.current_longitude
            },
            deliveries: etaDeliveries
          }).catch((error) => {
            const status = error?.response?.status || error?.status;
            const message = String(error?.message || '').toLowerCase();
            if (status === 404 || status === 429 || message.includes('not found') || message.includes('rate limit')) return;
            console.warn('⚠️ [DeliveryForm] ETA refresh skipped:', error?.message || error);
          });
        }
      }

      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: {
          triggeredBy: hasTimeWindowChanges ? 'routeOptimizationAfterUpdate' : 'etaUpdateAfterDeliveryUpdate',
          driverId,
          deliveryDate,
          alreadyOptimized: hasTimeWindowChanges
        }
      }));
      // Only refresh stats if not explicitly skipped (e.g. pending stop edits that don't affect stats)
      if (!skipStatsRefresh) window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
    } catch (error) {
      if (shouldCatchBackgroundDeliveryError(currentUser)) {
        console.warn(`⚠️ [DeliveryForm] Background ${hasTimeWindowChanges ? 'route optimization' : 'ETA refresh'} failed:`, error?.message || error);
        return;
      }
      throw error;
    }
  }, 0);
};