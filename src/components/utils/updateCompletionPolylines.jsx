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
          updates.push(
            base44.entities.Delivery.update(completedDelivery.id, {
              finished_leg_encoded_polyline: finishedPolyline,
              finished_leg_transport_mode: completedDelivery?.finished_leg_transport_mode || 'driving',
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
        const originPatient = completedDelivery?.patient_id
          ? patients?.find((p) => p?.id === completedDelivery.patient_id)
          : null;
        const originStore = !originPatient
          ? stores?.find((s) => s?.id === completedDelivery.store_id)
          : null;

        const originLat = originPatient?.latitude || originStore?.latitude;
        const originLon = originPatient?.longitude || originStore?.longitude;

        const destLat = nextDelivery?.patient_id
          ? patients?.find((p) => p?.id === nextDelivery.patient_id)?.latitude
          : stores?.find((s) => s?.id === nextDelivery.store_id)?.latitude;

        const destLon = nextDelivery?.patient_id
          ? patients?.find((p) => p?.id === nextDelivery.patient_id)?.longitude
          : stores?.find((s) => s?.id === nextDelivery.store_id)?.longitude;

        const hasValidOrigin = Number.isFinite(Number(originLat)) && Number.isFinite(Number(originLon));
        const hasValidDest = Number.isFinite(Number(destLat)) && Number.isFinite(Number(destLon));

        if (hasValidOrigin && hasValidDest) {
          const response = await base44.functions.invoke('getHereDirections', {
            origin: { lat: Number(originLat), lon: Number(originLon) },
            destination: { lat: Number(destLat), lon: Number(destLon) }
          });

          if (response?.data?.polyline) {
            updates.push(
              base44.entities.DriverRoutePolyline.filter({
                driver_id: driverId,
                delivery_date: deliveryDate
              }).then((existing) => {
                if (existing && existing.length > 0) {
                  return base44.entities.DriverRoutePolyline.update(existing[0].id, {
                    encoded_polyline: response.data.polyline,
                    segment_origin_lat: originLat,
                    segment_origin_lon: originLon,
                    segment_dest_lat: destLat,
                    segment_dest_lon: destLon,
                    estimated_distance_km: response.data.distance_km,
                    estimated_duration_minutes: response.data.duration_minutes,
                    last_generated_at: new Date().toISOString()
                  });
                }

                return base44.entities.DriverRoutePolyline.create({
                  driver_id: driverId,
                  delivery_date: deliveryDate,
                  encoded_polyline: response.data.polyline,
                  segment_origin_lat: originLat,
                  segment_origin_lon: originLon,
                  segment_dest_lat: destLat,
                  segment_dest_lon: destLon,
                  estimated_distance_km: response.data.distance_km,
                  estimated_duration_minutes: response.data.duration_minutes,
                  last_generated_at: new Date().toISOString()
                });
              })
            );
          }
        }
      } catch (err) {
        console.warn('⚠️ [updateCompletionPolylines] Failed to generate Type 1 polyline:', err.message);
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