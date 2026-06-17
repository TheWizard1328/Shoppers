import { invalidate } from '@/components/utils/dataManager';
import { createDeliveryLocal } from '@/components/utils/offlineMutations';
import { pauseOfflineSync, resumeOfflineSync } from '@/components/utils/offlineSync';
import { smartRefreshManager } from '@/components/utils/smartRefreshManager';
import { notifyDriverReturn } from '@/components/utils/deliveryMessaging';
import { getNextTrackingNumberInGroup } from '@/components/common/stopCardActionHelpers';
import { buildReturnDeliveryData } from '@/components/utils/returnDeliveryBuilder';
import { generateUniqueSID } from '@/components/dashboard/DashboardHelpers';
import { base44 } from '@/api/base44Client';
import { format } from 'date-fns';

const getEdmDate = () => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return `${p.find(x => x.type === 'year').value}-${p.find(x => x.type === 'month').value}-${p.find(x => x.type === 'day').value}`;
};

export async function handleCreateReturn({ originalDelivery, returnPatient, store }, {
  currentUser, deliveries, appUsers, setIsEntityUpdating, forceRefreshDriverDeliveries
}) {
  setIsEntityUpdating(true);
  pauseOfflineSync();
  smartRefreshManager.pause();

  await new Promise((resolve) => setTimeout(resolve, 100));

  try {
    const currentDate = getEdmDate();
    const puid = originalDelivery.puid;
    let finalStoreId = originalDelivery.store_id;
    let finalAmpm = originalDelivery.ampm_deliveries;

    if (puid) {
      const parentPickup = deliveries.find((d) => d && !d.patient_id && d.stop_id === puid);
      if (parentPickup) {
        finalStoreId = parentPickup.store_id || originalDelivery.store_id;
        finalAmpm = parentPickup.ampm_deliveries || originalDelivery.ampm_deliveries;
      }
    }

    const routeDate = currentDate;
    const routeDateDeliveries = deliveries.filter((d) => d && d.driver_id === originalDelivery.driver_id && d.delivery_date === routeDate);
    const nextTrackingNumber = getNextTrackingNumberInGroup(originalDelivery.tracking_number, deliveries, originalDelivery.driver_id, routeDate);

    const returnDeliveryData = buildReturnDeliveryData({
      originalDelivery, returnPatient, store, routeDate, routeDateDeliveries,
      finalStoreId, finalAmpm, currentUser, generateUniqueSID, nextTrackingNumber
    });

    await createDeliveryLocal(returnDeliveryData);

    try {
      await notifyDriverReturn({ driver: currentUser, patientName: returnPatient.full_name, delivery: originalDelivery, store, appUsers });
    } catch (notifyError) {
      console.warn('⚠️ [RETURN] Failed to send notification:', notifyError);
    }

    invalidate('Delivery');
    try { await forceRefreshDriverDeliveries(originalDelivery.driver_id, routeDate); } catch (_) {}
    window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'return', driverId: originalDelivery.driver_id, deliveryDate: routeDate } }));
    window.dispatchEvent(new CustomEvent('routeOptimizationStarted', { detail: { source: 'return', driverId: originalDelivery.driver_id, deliveryDate: routeDate } }));
    base44.functions.invoke('optimizeRemainingStops', {
      driverId: originalDelivery.driver_id, deliveryDate: routeDate,
      currentLocalTime: `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`,
      deviceTime: new Date().toISOString()
    }).catch((e) => console.warn('⚠️ [CREATE RETURN] Background optimize failed:', e?.message || e))
      .finally(() => window.dispatchEvent(new CustomEvent('routeOptimizationComplete', { detail: { source: 'return', driverId: originalDelivery.driver_id, deliveryDate: routeDate } })));

  } catch (error) {
    console.error('❌ [CREATE RETURN] Error:', error);
    throw error;
  } finally {
    resumeOfflineSync();
    smartRefreshManager.resume();
    setIsEntityUpdating(false);
  }
}