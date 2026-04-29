/**
 * Handles targeted polyline updates when a delivery is completed
 * Only updates:
 * 1. The finished leg polyline for the completed delivery
 * 2. The Type 1 polyline for the new next delivery (if exists)
 *
 * This avoids unnecessary regeneration of all polylines when stop orders haven't changed
 */

import { base44 } from "@/api/base44Client";
import { getFinishedLegEncodedPolyline } from '../common/stopCardActionHelpers';

export async function updateCompletionPolylines({
  completedDelivery,
  nextDelivery,
  driverId,
  deliveryDate,
  allDeliveries,
  patients,
  stores,
  breadcrumbPayload
}) {
  try {
    const updates = [];

    if (completedDelivery) {
      try {
        const finishedPolyline = await getFinishedLegEncodedPolyline({
          delivery: completedDelivery,
          allDeliveries,
          driver: null,
          patient: patients?.find((p) => p?.id === completedDelivery.patient_id),
          store: stores?.find((s) => s?.id === completedDelivery.store_id),
          patients,
          stores,
          finishedStatuses: ['completed', 'failed', 'cancelled'],
          breadcrumbPayload
        });

        if (finishedPolyline && completedDelivery?.id) {
          const completedPatient = patients?.find((p) => p?.id === completedDelivery.patient_id);
          const completedStore = stores?.find((s) => s?.id === completedDelivery.store_id);
          const completedCoords = completedDelivery?.patient_id
            ? { lat: Number(completedPatient?.latitude), lon: Number(completedPatient?.longitude) }
            : { lat: Number(completedStore?.latitude), lon: Number(completedStore?.longitude) };
          updates.push(
            base44.entities.Delivery.update(completedDelivery.id, {
              finished_leg_encoded_polyline: finishedPolyline,
              finished_leg_transport_mode: completedDelivery?.finished_leg_transport_mode || 'driving',
              segment_dest_lat: Number.isFinite(completedCoords.lat) ? Number(completedCoords.lat.toFixed(5)) : completedDelivery?.segment_dest_lat,
              segment_dest_lon: Number.isFinite(completedCoords.lon) ? Number(completedCoords.lon.toFixed(5)) : completedDelivery?.segment_dest_lon,
              PolylineUpdated: true
            })
          );
        }
      } catch (err) {
        console.warn('⚠️ [updateCompletionPolylines] Failed to generate finished leg polyline:', err.message);
      }
    }

    if (nextDelivery) {
      try {
        await base44.functions.invoke('regenerateType1Polyline', {
          driverId,
          deliveryDate,
          routeChangeSource: 'stop_completion'
        });
      } catch (err) {
        console.warn('⚠️ [updateCompletionPolylines] Failed to regenerate next stop polyline:', err.message);
      }
    }

    if (updates.length > 0) {
      await Promise.allSettled(updates);
      console.log(`✅ [updateCompletionPolylines] Updated ${updates.length} polyline(s) for driver ${driverId}`);
    }
  } catch (err) {
    console.error('❌ [updateCompletionPolylines] Error:', err);
  }
}