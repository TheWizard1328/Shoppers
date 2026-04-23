import { format } from 'date-fns';
import { base44 } from '@/api/base44Client';
import { getDriverDisplayName } from '../utils/driverUtils';
import { sendDeliveryMessage } from '../utils/deliveryMessaging';
import { reorderStops } from '../utils/stopReorderer';

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
  t,
  allDeliveries,
  isPickupMode,
  updateDeliveryLocal,
  dateChanged
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
      const driverDeliveries = allDeliveries.filter((d) => d && d.driver_id === formData.driver_id && d.delivery_date === formData.delivery_date);
      const completedDeliveries = driverDeliveries.filter((d) => ['completed', 'failed', 'cancelled'].includes(d.id === delivery.id ? formData.status : d.status));
      completedDeliveries.sort((a, b) => {
        const timeA = a.id === delivery.id && t ? new Date(t).getTime() : a.actual_delivery_time ? new Date(a.actual_delivery_time).getTime() : 0;
        const timeB = b.id === delivery.id && t ? new Date(t).getTime() : b.actual_delivery_time ? new Date(b.actual_delivery_time).getTime() : 0;
        return timeA - timeB;
      });

      let stopOrder = 1;
      await Promise.all(completedDeliveries.map((d) => {
        const newStopOrder = stopOrder++;
        return d.stop_order !== newStopOrder ? base44.entities.Delivery.update(d.id, { stop_order: newStopOrder }) : Promise.resolve();
      }));

      const completionStatuses = ['completed', 'failed', 'cancelled', 'returned'];
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
      } else {
        try {
          const driverAppUsers = await base44.entities.AppUser.filter({ user_id: formData.driver_id });
          const driverAppUser = driverAppUsers?.[0];
          if (driverAppUser?.home_latitude != null && driverAppUser?.home_longitude != null) {
            const lastStopLat = selectedPatient?.latitude ?? selectedPatient?.lat;
            const lastStopLon = selectedPatient?.longitude ?? selectedPatient?.lon;
            if (lastStopLat != null && lastStopLon != null) {
              await base44.functions.invoke('regenerateType1Polyline', {
                driverId: formData.driver_id,
                deliveryDate: formData.delivery_date,
                currentLocation: {
                  lat: Number(lastStopLat),
                  lon: Number(lastStopLon)
                },
                isPrimaryDevice: true,
                force: true,
                routeChangeSource: 'route_completion_home'
              });
            }
          }
        } catch (error) {
          console.warn('[DeliveryForm] Final stop home polyline skipped:', error?.message);
        }
      }
    } catch (error) {
      console.error('❌ [DeliveryForm] Resort failed:', error);
    }
  }

  if (delivery && formData.driver_id && formData.delivery_date && !isPickupMode && (driverChanged || dateChanged || timeWindowChanged || statusChangedToCompletion || actualDeliveryTimeChanged)) {
    try {
      setTimeout(() => {
        const isCompletionStatus = ['completed', 'failed', 'cancelled'].includes(formData.status);
        const shouldRunEtaOnly = statusChangedToCompletion && isCompletionStatus && delivery.isNextDelivery === true;
        const shouldRunFullOptimization = !shouldRunEtaOnly;

        reorderStops(formData.driver_id, formData.delivery_date, allDeliveries, null, {
          optimizeRemainingStops: shouldRunEtaOnly || shouldRunFullOptimization,
          etaOnly: shouldRunEtaOnly
        })
          .then((result) => {
            if (shouldRunEtaOnly) {
              console.log('✅ [DeliveryForm] Next-stop completion processed with ETA-only refresh');
              return;
            }
            console.log('✅ [DeliveryForm] Stop reordering complete (bg)', result);
          })
          .catch((error) => console.error('❌ [DeliveryForm] Stop reordering failed (bg):', error));
      }, 0);
    } catch (error) {
      console.error('❌ [DeliveryForm] Stop reordering failed:', error);
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

  setTimeout(() => {
    import('../utils/deliveryFormActionHelpers')
      .then(({ resumeDeliveryFormManagers }) => resumeDeliveryFormManagers())
      .catch((error) => {
        console.warn('⚠️ [DeliveryForm] Failed to resume managers:', error);
      });
  }, 0);
}