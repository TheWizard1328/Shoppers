import { isAppOwner } from './userRoles';
import { optimizeRemainingStops } from '@/functions/optimizeRemainingStops';
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

export const runPostDeliveryUpdateSync = ({ driverId, deliveryDate, hasTimeWindowChanges, travelModeOnly = false, currentUser, optimizationStartTime = null, skipCurrentTimeEtaChecks = false }) => {
  if (!driverId || !deliveryDate || travelModeOnly) return;

  const syncKey = `${driverId}:${deliveryDate}:${hasTimeWindowChanges ? 'optimize' : 'eta'}:${optimizationStartTime || 'live'}:${skipCurrentTimeEtaChecks ? 'skip' : 'check'}`;
  const now = Date.now();
  if (lastPostDeliverySyncKey === syncKey && now - lastPostDeliverySyncAt < 15000) return;
  lastPostDeliverySyncKey = syncKey;
  lastPostDeliverySyncAt = now;

  setTimeout(async () => {
    const now = new Date();
    const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    try {
      if (hasTimeWindowChanges) {
        await optimizeRemainingStops({
          driverId,
          deliveryDate,
          currentLocalTime: optimizationStartTime || currentLocalTime,
          deviceTime: optimizationStartTime || currentLocalTime,
          optimizationStartTime,
          skipCurrentTimeEtaChecks
        });
      } else {
        if (skipCurrentTimeEtaChecks) {
          window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
            detail: {
              triggeredBy: 'historicalDeliveryUpdateSkippedEtaRefresh',
              driverId,
              deliveryDate,
              alreadyOptimized: false
            }
          }));
          window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
          return;
        }
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
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
    } catch (error) {
      if (shouldCatchBackgroundDeliveryError(currentUser)) {
        console.warn(`⚠️ [DeliveryForm] Background ${hasTimeWindowChanges ? 'route optimization' : 'ETA refresh'} failed:`, error?.message || error);
        return;
      }
      throw error;
    }
  }, 0);
};