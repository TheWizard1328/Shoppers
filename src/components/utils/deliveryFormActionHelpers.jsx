import { isAppOwner } from './userRoles';
import { calculateRealTimeETA } from '@/functions/calculateRealTimeETA';
import { base44 } from '@/api/base44Client';
import { scheduleDeferredReoptimization } from './deferredRouteReoptimization';

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

/**
 * UNIVERSAL DONE LAST STEP (owner spec, Oct 23 2026):
 * Whenever the Add-to-Route form's Done button is clicked, the route optimizer
 * and polyline generator must run as the LAST step for EVERY affected route:
 *  - patient deliveries manually set in_transit (scheduled by handleBatchSave's
 *    existing routeStructureChanged -> requestDeferredOptimization call),
 *  - store pickups added this session (addedPickupRoutes — direct-persisted
 *    en_route stops that never enter the staged list),
 *  - InterStore (ISP/ISD) stops added this session (deferred queue).
 * CANCEL-PARITY: managers are resumed FIRST — the Cancel button proved this
 * sequence runs the optimizer reliably, while the old Done path fired it
 * while the form's manager pauses were still active and the form was closing
 * (owner report: Done closed with no optimization, Cancel optimized).
 */
export const runDoneOptimizationLastStep = async ({ addedPickupRoutes = [] } = {}) => {
  const routes = (addedPickupRoutes || []).filter((r) => r?.driverId && r?.deliveryDate);
  const queueLen = (typeof window !== 'undefined' && Array.isArray(window.__pendingInterStoreOptimizations))
    ? window.__pendingInterStoreOptimizations.length
    : 0;
  if (routes.length === 0 && queueLen === 0) return; // nothing to do — no wasted resume/imports
  console.warn(`[DoneLastStep] universal Done optimization: ${routes.length} pickup route(s), ${queueLen} InterStore route(s)`);

  try {
    await resumeDeliveryFormManagers();
  } catch (err) {
    console.warn('[DoneLastStep] manager resume failed (non-fatal):', err?.message || err);
  }

  if (routes.length > 0) {
    try {
      const { requestDeferredOptimization } = await import('@/components/utils/optimizationDebouncer');
      for (const route of routes) {
        requestDeferredOptimization(route.driverId, route.deliveryDate, true);
      }
    } catch (err) {
      console.warn('[DoneLastStep] pickup-route optimization scheduling failed:', err?.message || err);
    }
  }

  try {
    await flushPendingInterStoreOptimizationsDeferred();
    console.warn('[DoneLastStep] complete');
  } catch (err) {
    console.warn('[DoneLastStep] InterStore flush failed:', err?.message || err);
  }
};

export const runPostDeliveryUpdateSync = ({ driverId, deliveryDate, hasTimeWindowChanges, travelModeOnly = false, currentUser, skipStatsRefresh = false }) => {
  if (!driverId || !deliveryDate || travelModeOnly) return;

  const syncKey = `${driverId}:${deliveryDate}:${hasTimeWindowChanges ? 'optimize' : 'eta'}`;
  const now = Date.now();
  if (lastPostDeliverySyncKey === syncKey && now - lastPostDeliverySyncAt < 15000) return;
  lastPostDeliverySyncKey = syncKey;
  lastPostDeliverySyncAt = now;

  if (hasTimeWindowChanges) {
    // Owner spec (Sep 24 2026): window-edit reoptimizations run on a 5-second
    // deferred timer, PAUSED while the Delivery Edit / Add To Route / Quick
    // Route Adjustment panels or a stop delete confirmation are open. The
    // countdown restarts from the full 5s when the last blocker closes, so
    // back-to-back edits batch into ONE optimization. A fresher optimization
    // (delete, quick reorder, manual FAB) absorbs the pending entry.
    scheduleDeferredReoptimization(`${driverId}:${deliveryDate}`, () =>
      executePostDeliveryUpdateSync({ driverId, deliveryDate, hasTimeWindowChanges: true, currentUser, skipStatsRefresh })
    );
    return;
  }
  setTimeout(() => {
    executePostDeliveryUpdateSync({ driverId, deliveryDate, hasTimeWindowChanges: false, currentUser, skipStatsRefresh });
  }, 0);
};

const executePostDeliveryUpdateSync = async ({ driverId, deliveryDate, hasTimeWindowChanges, currentUser, skipStatsRefresh = false }) => {
  {
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
  }
};