import { format } from 'date-fns';
import { base44 } from '@/api/base44Client';

const APP_TIMEZONE = 'America/Edmonton';

function getEdmontonDateString(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(value));

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}
import { getDriverDisplayName } from '../utils/driverUtils';
import { sendDeliveryMessage } from '../utils/deliveryMessaging';

export async function runDeliverySubmitSideEffects({
  delivery,
  formData,
  selectedPatient,
  currentUser,
  oldDriver,
  newDriver,
  driverChanged,
  isCurrentUserDriver,
  statusChangedToCompletion,
  actualDeliveryTimeChanged,
  timeWindowChanged,
  travelModeChanged,
  t,
  allDeliveries,
  isPickupMode,
  updateDeliveryLocal,
  dateChanged,
  skipRouteOptimization = false
}) {
  if (driverChanged && oldDriver && newDriver && currentUser && isCurrentUserDriver) {
    const patientName = delivery.patient_name || selectedPatient?.full_name || 'Unknown';
    const messageContent = `🚚 ${getDriverDisplayName(oldDriver)} reassigned a Delivery to you:\n• ${patientName}\n• ${format(new Date(formData.delivery_date), 'MMM d, yyyy')}`;

    await sendDeliveryMessage({
      senderId: currentUser.id,
      senderName: getDriverDisplayName(currentUser),
      receiverId: newDriver.id,
      receiverName: getDriverDisplayName(newDriver),
      content: messageContent
    });
  }

  if (statusChangedToCompletion && delivery && formData.status === 'completed') {
    try {
      if (delivery.isNextDelivery) {
        const appUsers = await base44.entities.AppUser.filter({ user_id: formData.driver_id });
        const driverAppUser = appUsers?.[0];

        if (driverAppUser && driverAppUser.driver_status === 'on_break') {
          await base44.entities.AppUser.update(driverAppUser.id, {
            driver_status: 'on_duty'
          });
        }
      }
    } catch (error) {
      console.error('❌ [DeliveryForm] Auto back-on-duty failed:', error);
    }
  }

  if (delivery && formData.driver_id && formData.delivery_date && statusChangedToCompletion) {
    try {
      const completionStatuses = ['completed', 'failed', 'cancelled', 'returned'];
      const driverDeliveries = allDeliveries.filter((d) => d && d.driver_id === formData.driver_id && d.delivery_date === formData.delivery_date);
      const incompleteDeliveries = driverDeliveries
        .filter((d) => d.id !== delivery.id && !completionStatuses.includes(d.status) && d.status !== 'pending')
        .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

      if (incompleteDeliveries.length > 0) {
        try {
          await base44.functions.invoke('setNextDeliveryFlag', {
            driverId: formData.driver_id,
            deliveryDate: formData.delivery_date,
            targetDeliveryId: incompleteDeliveries[0].id
          });
        } catch (error) {
          console.warn('[DeliveryForm] setNextDeliveryFlag failed:', error?.message);
        }

        if (delivery.isNextDelivery && skipRouteOptimization) {
          await base44.functions.invoke('calculateRealTimeETA', {
            deliveries: incompleteDeliveries,
            lastStopCompletionTime: t,
            lastStopServiceTime: delivery.extra_time || 0
          }).catch(() => null);
        }
      }

    } catch (error) {
      console.error('❌ [DeliveryForm] Completion side effects failed:', error);
    }
  }

  if (statusChangedToCompletion && delivery && formData.status === 'completed') {
    setTimeout(() => {
      base44.functions.invoke('updatePatientsAfterRouteCompletion', {
        deliveryDate: formData.delivery_date,
        driverId: formData.driver_id
      }).catch((error) => {
        console.error('❌ [DeliveryForm] Patient update failed:', error);
      });
    }, 0);
  }

  if ((driverChanged || dateChanged) && delivery) {
    // Reoptimize OLD driver/date route (background, non-blocking)
    const oldDriverId = delivery.driver_id;
    const oldDate = delivery.delivery_date;
    if (oldDriverId && oldDate) {
      setTimeout(async () => {
        try {
          const { performRouteOptimization } = await import('@/components/utils/routeOptimizationCoordinator');
          await performRouteOptimization({ driverId: oldDriverId, deliveryDate: oldDate, bypassDriverStatus: true, source: 'driver_changed_old' });
          const dels = await base44.entities.Delivery.filter({ driver_id: oldDriverId, delivery_date: oldDate }).catch(() => []);
          const ids = (dels || []).filter(d => d?.id && !['completed','failed','cancelled','returned','pending','Staged'].includes(d?.status)).sort((a,b) => (Number(a.stop_order)||0)-(Number(b.stop_order)||0)).map(d => d.id);
          if (ids.length > 0) await base44.functions.invoke('purgeAndRegeneratePolylines', { driverId: oldDriverId, deliveryDate: oldDate, orderedDeliveryIds: ids, bypassDriverStatus: true });
        } catch (_) {}
      }, 500);
    }

    // Reoptimize NEW driver/date route (background, non-blocking)
    const newDriverId = formData.driver_id;
    const newDate = formData.delivery_date;
    if (newDriverId && newDate && (newDriverId !== oldDriverId || newDate !== oldDate)) {
      setTimeout(async () => {
        try {
          const { performRouteOptimization } = await import('@/components/utils/routeOptimizationCoordinator');
          await performRouteOptimization({ driverId: newDriverId, deliveryDate: newDate, bypassDriverStatus: true, source: 'driver_changed_new' });
          const dels = await base44.entities.Delivery.filter({ driver_id: newDriverId, delivery_date: newDate }).catch(() => []);
          const ids = (dels || []).filter(d => d?.id && !['completed','failed','cancelled','returned','pending','Staged'].includes(d?.status)).sort((a,b) => (Number(a.stop_order)||0)-(Number(b.stop_order)||0)).map(d => d.id);
          if (ids.length > 0) await base44.functions.invoke('purgeAndRegeneratePolylines', { driverId: newDriverId, deliveryDate: newDate, orderedDeliveryIds: ids, bypassDriverStatus: true });
        } catch (_) {}
      }, 1000);
    }
  }

  if (isPickupMode && delivery && (driverChanged || dateChanged)) {
    const previousPickupKey = delivery.stop_id || delivery.puid || delivery.id;
    const transferredPendingDeliveries = allDeliveries.filter((d) =>
      d &&
      d.id !== delivery.id &&
      d.patient_id &&
      d.status === 'pending' &&
      d.puid === previousPickupKey
    );

    if (transferredPendingDeliveries.length > 0) {
      await Promise.all(
        transferredPendingDeliveries.map((relatedDelivery) =>
          updateDeliveryLocal(relatedDelivery.id, {
            driver_id: formData.driver_id || '',
            driver_name: formData.driver_name || '',
            delivery_date: formData.delivery_date,
            ampm_deliveries: formData.ampm_deliveries || relatedDelivery.ampm_deliveries || null
          }).catch((error) => console.error(`Failed to transfer ${relatedDelivery.patient_name}:`, error))
        )
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  if (isPickupMode && delivery && formData.status === 'completed' && formData.store_id && formData.ampm_deliveries) {
    const relatedDeliveries = allDeliveries.filter((d) =>
      d &&
      d.id !== delivery.id &&
      d.delivery_date === formData.delivery_date &&
      d.store_id === formData.store_id &&
      d.ampm_deliveries === formData.ampm_deliveries &&
      d.status === 'pending' &&
      d.patient_id
    );

    if (relatedDeliveries.length > 0) {
      const updatePromises = relatedDeliveries.map((relatedDelivery) =>
        updateDeliveryLocal(relatedDelivery.id, { status: 'in_transit' })
          .catch((error) => console.error(`Failed to update ${relatedDelivery.patient_name}:`, error))
      );
      await Promise.all(updatePromises);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  if (travelModeChanged && !driverChanged && !dateChanged && !timeWindowChanged && !statusChangedToCompletion && !actualDeliveryTimeChanged) {
    setTimeout(() => {
      import('../utils/deliveryFormActionHelpers')
        .then(({ resumeDeliveryFormManagers }) => resumeDeliveryFormManagers())
        .catch((error) => {
          console.warn('⚠️ [DeliveryForm] Failed to resume managers:', error);
        });
    }, 0);
    return;
  }

  setTimeout(() => {
    import('../utils/deliveryFormActionHelpers')
      .then(({ resumeDeliveryFormManagers }) => resumeDeliveryFormManagers())
      .catch((error) => {
        console.warn('⚠️ [DeliveryForm] Failed to resume managers:', error);
      });
  }, 0);
}