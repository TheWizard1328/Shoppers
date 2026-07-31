import React, { useMemo, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";
import { offlineDB } from "@/components/utils/offlineDatabase";
import { smartRefreshManager } from "@/components/utils/smartRefreshManager";
import { loadBreadcrumbsForDriver } from "@/components/utils/breadcrumbsManager";
import { getOrFetchHereApiKey } from "@/components/utils/hereApiKeyStore";
import { Loader2, RotateCcw } from "lucide-react";

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Resolve the destination coords for a delivery record. */
function resolveStopCoords(delivery, patientMap, storeMap) {
  if (!delivery) return null;

  // Cycling markers carry their own GPS fields
  if (delivery.is_cycling_marker) {
    const lat = Number(delivery.cycling_latitude);
    const lng = Number(delivery.cycling_longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0)
      return { latitude: lat, longitude: lng };
    return null;
  }

  // Patient stop
  if (delivery.patient_id) {
    const patient = patientMap.get(delivery.patient_id);
    if (patient?.latitude != null && patient?.longitude != null)
      return { latitude: Number(patient.latitude), longitude: Number(patient.longitude) };
    return null;
  }

  // Pickup / store stop
  const store = storeMap.get(delivery.store_id);
  if (store?.latitude != null && store?.longitude != null)
    return { latitude: Number(store.latitude), longitude: Number(store.longitude) };

  return null;
}

/** Small delay so the browser can paint between API calls. */
const tick = (ms = 250) => new Promise(r => setTimeout(r, ms));

// ─── component ────────────────────────────────────────────────────────────────

export default function ResetPolylinesButton({
  selectedDriverIds = [],
  selectedDate,
  selectedPolylineOption = 'polylines',
  mode = "inline",
  disabled = false,
  className = "",
  appUsers = [],
  onBreadcrumbsReloaded,
}) {
  const [isResetting, setIsResetting] = useState(false);

  const driverIds = useMemo(() => {
    return Array.from(new Set((selectedDriverIds || []).filter(Boolean).filter(id => id !== "all")));
  }, [selectedDriverIds]);

  // ── MODE B: Breadcrumb slicing ────────────────────────────────────────────
  const runBreadcrumbMode = async (driverId) => {
    // 1. Pull fresh records so consolidateBreadcrumbs sees the latest master timeline
    const onlineBreadcrumbs = await base44.entities.DeliveryBreadcrumbs.filter({
      driver_id: driverId,
      delivery_date: selectedDate,
    });
    if (Array.isArray(onlineBreadcrumbs) && onlineBreadcrumbs.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERY_BREADCRUMBS, onlineBreadcrumbs);
    }

    // 2. Re-slice all stops from the master trail (does NOT touch delivery polylines)
    const response = await base44.functions.invoke('consolidateBreadcrumbs', {
      driver_id: driverId,
      delivery_date: selectedDate,
    });
    const result = response?.data || response || {};
    if (!result.success && !result.skipped) {
      throw new Error(result.error || 'Breadcrumb resegmentation failed');
    }

    // 3. Sync fresh slices back to offline DB
    const freshSegments = await base44.entities.DeliveryBreadcrumbs.filter({
      driver_id: driverId,
      delivery_date: selectedDate,
    });
    if (Array.isArray(freshSegments) && freshSegments.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERY_BREADCRUMBS, freshSegments);
    }

    // 4. Reload breadcrumbs into map state (UI-only, no DB write)
    try {
      const reloaded = await loadBreadcrumbsForDriver(driverId, selectedDate, appUsers);
      onBreadcrumbsReloaded?.(driverId, reloaded);
    } catch (_) {}

    return result;
  };

  // ── MODE A: Pure polyline regeneration (three passes) ────────────────────
  const runPolylineMode = async (driverId) => {
    // ── Fetch all data needed for coordinate resolution ──────────────────────
    const [rawDeliveries, driverAppUsers] = await Promise.all([
      base44.entities.Delivery.filter(
        { driver_id: driverId, delivery_date: selectedDate },
        'stop_order',
        5000
      ),
      base44.entities.AppUser.filter({ user_id: driverId }, '-updated_date', 1),
    ]);

    const deliveries = (rawDeliveries || []).filter(Boolean);
    if (deliveries.length === 0) {
      throw new Error('No route stops found for this driver and date');
    }

    // Gather all patient_ids and store_ids we need
    const patientIds = [...new Set(deliveries.map(d => d.patient_id).filter(Boolean))];
    const storeIds = [...new Set(deliveries.map(d => d.store_id).filter(Boolean))];

    const [patients, stores] = await Promise.all([
      patientIds.length > 0
        ? base44.entities.Patient.filter({ id: { $in: patientIds } }, undefined, 5000).catch(() => [])
        : Promise.resolve([]),
      storeIds.length > 0
        ? base44.entities.Store.filter({ id: { $in: storeIds } }, undefined, 500).catch(() => [])
        : Promise.resolve([]),
    ]);

    const patientMap = new Map((patients || []).filter(Boolean).map(p => [p.id, p]));
    const storeMap = new Map((stores || []).filter(Boolean).map(s => [s.id, s]));
    const driverAppUser = driverAppUsers?.[0] || null;

    // Home position as route origin for pass 1
    const homePosition = (() => {
      const lat = Number(driverAppUser?.home_latitude);
      const lon = Number(driverAppUser?.home_longitude);
      if (Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0 && lon !== 0)
        return { latitude: lat, longitude: lon };
      return null;
    })();

    // Get HERE API key
    let hereApiKey = null;
    try { hereApiKey = await getOrFetchHereApiKey(); } catch (_) {}

    // Sort deliveries by stop_order (already fetched sorted, but be explicit)
    const sorted = [...deliveries].sort((a, b) =>
      (Number(a.stop_order) || 0) - (Number(b.stop_order) || 0)
    );

    // Collect updates — we'll batch-write at the end of each pass
    const pendingUpdates = new Map(); // deliveryId → partial update object

    const mergeUpdate = (id, fields) => {
      pendingUpdates.set(id, { ...(pendingUpdates.get(id) || {}), ...fields });
    };

    // ── PASS 1: Driving baseline ────────────────────────────────────────────
    // All stops treated as 'driving'. Origin = home (if set) or first stop.
    console.log(`[ResetPolylinesButton] PASS 1 — driving baseline, ${sorted.length} stops`);

    let prevCoords = homePosition || resolveStopCoords(sorted[0], patientMap, storeMap);

    for (let i = 0; i < sorted.length; i++) {
      const delivery = sorted[i];
      const toCoords = resolveStopCoords(delivery, patientMap, storeMap);
      if (!toCoords || !prevCoords) {
        prevCoords = toCoords || prevCoords;
        continue;
      }

      if (hereApiKey) {
        try {
          const encoded = await base44.functions.invoke('getHereDirections', {
            origin: { lat: prevCoords.latitude, lng: prevCoords.longitude },
            destination: { lat: toCoords.latitude, lng: toCoords.longitude },
            caller: 'reset_polylines_pass1_driving',
          });
          const polyline = encoded?.data?.sections?.[0]?.encoded_polyline
            || encoded?.data?.encoded_polyline
            || null;
          const distKm = encoded?.data?.sections?.[0]?.estimated_distance_km
            ?? encoded?.data?.estimated_distance_km
            ?? null;
          const durMin = encoded?.data?.sections?.[0]?.estimated_duration_minutes
            ?? encoded?.data?.estimated_duration_minutes
            ?? null;

          if (polyline) {
            mergeUpdate(delivery.id, {
              encoded_polyline: polyline,
              transport_mode: 'driving',
              ...(distKm != null ? { estimated_distance_km: distKm } : {}),
              ...(durMin != null ? { estimated_duration_minutes: durMin } : {}),
            });
          }
        } catch (err) {
          console.warn(`[ResetPolylinesButton] Pass 1 HERE call failed for stop ${i + 1}:`, err?.message || err);
        }
        await tick(150);
      }

      prevCoords = toCoords;
    }

    // ── PASS 2: Cycling loop patching ──────────────────────────────────────
    // Find cycling Start/End marker pairs, re-polyline the loop with cycling mode.
    const cyclingMarkers = sorted.filter(d => d.is_cycling_marker);

    if (cyclingMarkers.length >= 2) {
      console.log(`[ResetPolylinesButton] PASS 2 — cycling loop patching, ${cyclingMarkers.length} markers`);

      // Pair markers: Start → End
      const startMarkers = cyclingMarkers.filter(m =>
        (m.delivery_notes || '').toLowerCase().includes('start')
      );
      const endMarkers = cyclingMarkers.filter(m =>
        (m.delivery_notes || '').toLowerCase().includes('end')
      );

      for (const startMarker of startMarkers) {
        // Find the matching End marker that comes after this Start in stop_order
        const matchingEnd = endMarkers.find(e =>
          Number(e.stop_order) > Number(startMarker.stop_order)
        );
        if (!matchingEnd) continue;

        // Collect all stops between Start and End (inclusive) by stop_order
        const loopStops = sorted.filter(d =>
          Number(d.stop_order) >= Number(startMarker.stop_order) &&
          Number(d.stop_order) <= Number(matchingEnd.stop_order)
        );

        if (loopStops.length < 2) continue;
        console.log(`[ResetPolylinesButton] Pass 2 — cycling loop: ${loopStops.length} stops`);

        // Re-polyline each leg in the loop with 'cycling' mode
        for (let i = 1; i < loopStops.length; i++) {
          const fromStop = loopStops[i - 1];
          const toStop = loopStops[i];
          const fromCoords = resolveStopCoords(fromStop, patientMap, storeMap);
          const toCoords = resolveStopCoords(toStop, patientMap, storeMap);

          if (!fromCoords || !toCoords) continue;

          if (hereApiKey) {
            try {
              const encoded = await base44.functions.invoke('getHereDirections', {
                origin: { lat: fromCoords.latitude, lng: fromCoords.longitude },
                destination: { lat: toCoords.latitude, lng: toCoords.longitude },
                transport_mode: 'cycling',
                caller: 'reset_polylines_pass2_cycling',
              });
              const polyline = encoded?.data?.sections?.[0]?.encoded_polyline
                || encoded?.data?.encoded_polyline
                || null;
              if (polyline) {
                mergeUpdate(toStop.id, {
                  encoded_polyline: polyline,
                  transport_mode: 'cycling',
                });
              }
            } catch (err) {
              console.warn(`[ResetPolylinesButton] Pass 2 cycling call failed:`, err?.message || err);
            }
            await tick(150);
          }
        }
      }
    } else {
      console.log(`[ResetPolylinesButton] PASS 2 — no cycling markers found, skipping`);
    }

    // ── PASS 3: Breadcrumb override ─────────────────────────────────────────
    // For any DeliveryBreadcrumbs record where saved_to_route is falsy,
    // overwrite the delivery's encoded_polyline with the actual breadcrumb path
    // and mark saved_to_route = true on the breadcrumb record.
    console.log(`[ResetPolylinesButton] PASS 3 — breadcrumb override`);

    let breadcrumbSegments = [];
    try {
      // Try offline DB first for speed
      const offlineSegs = await offlineDB.getByCompoundIndex(
        offlineDB.STORES.DELIVERY_BREADCRUMBS,
        'date_driver',
        [selectedDate, driverId]
      );
      breadcrumbSegments = offlineSegs || [];
    } catch (_) {
      // Fallback to API
      try {
        breadcrumbSegments = await base44.entities.DeliveryBreadcrumbs.filter({
          driver_id: driverId,
          delivery_date: selectedDate,
        });
      } catch (_2) {}
    }

    // Filter to only unsaved, non-master-timeline segments that have a polyline
    const masterStopOrder = -1;
    const pendingBreadcrumbs = (breadcrumbSegments || []).filter(seg =>
      seg &&
      seg.encoded_polyline &&
      seg.stop_order !== masterStopOrder &&
      !seg.saved_to_route
    );

    console.log(`[ResetPolylinesButton] Pass 3 — ${pendingBreadcrumbs.length} unsaved breadcrumb segments to apply`);

    const breadcrumbsToSeal = [];

    for (const seg of pendingBreadcrumbs) {
      // Match by stop_order to find the corresponding delivery
      const matchingDelivery = sorted.find(d =>
        Number(d.stop_order) === Number(seg.stop_order)
      );
      if (!matchingDelivery) continue;

      mergeUpdate(matchingDelivery.id, {
        encoded_polyline: seg.encoded_polyline,
        ...(seg.transport_mode ? { transport_mode: seg.transport_mode } : {}),
      });

      breadcrumbsToSeal.push(seg);
    }

    // ── WRITE BATCH: push all delivery updates ────────────────────────────
    const updateEntries = Array.from(pendingUpdates.entries());
    console.log(`[ResetPolylinesButton] Writing ${updateEntries.length} delivery updates`);

    if (updateEntries.length > 0) {
      // Write in chunks of 10 to avoid hammering the API
      const CHUNK = 10;
      for (let i = 0; i < updateEntries.length; i += CHUNK) {
        const chunk = updateEntries.slice(i, i + CHUNK);
        await Promise.all(
          chunk.map(([id, data]) => base44.entities.Delivery.update(id, data).catch(err => {
            console.warn(`[ResetPolylinesButton] Delivery update failed for ${id}:`, err?.message || err);
          }))
        );
        await tick(100);
      }
    }

    // ── PASS 3 epilogue: seal breadcrumb records ──────────────────────────
    if (breadcrumbsToSeal.length > 0) {
      console.log(`[ResetPolylinesButton] Sealing ${breadcrumbsToSeal.length} breadcrumb segments (saved_to_route=true)`);
      await Promise.all(
        breadcrumbsToSeal.map(seg =>
          base44.entities.DeliveryBreadcrumbs.update(seg.id, { saved_to_route: true }).catch(() => {})
        )
      );
      // Mirror seals to offline DB
      const sealedSegments = breadcrumbsToSeal.map(s => ({ ...s, saved_to_route: true }));
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERY_BREADCRUMBS, sealedSegments).catch(() => {});
    }

    // ── Sync fresh deliveries to offline DB and dispatch UI update ────────
    const freshDeliveries = await base44.entities.Delivery.filter(
      { driver_id: driverId, delivery_date: selectedDate },
      'stop_order',
      5000
    ).catch(() => []);

    if ((freshDeliveries || []).length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);
    }

    window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
      detail: {
        driverId,
        deliveryDate: selectedDate,
        triggeredBy: 'resetPolylines_complete',
        freshDeliveries: freshDeliveries || undefined,
        deliveries: freshDeliveries || undefined,
        fullReplacement: false,
        immediate: true,
        preserveLocalState: false,
      }
    }));

    return {
      deliveriesUpdated: updateEntries.length,
      breadcrumbsSealed: breadcrumbsToSeal.length,
    };
  };

  // ── Main handler ──────────────────────────────────────────────────────────
  const handleReset = async () => {
    if (isResetting || disabled || driverIds.length === 0 || !selectedDate) return;

    setIsResetting(true);
    smartRefreshManager.pause();
    window.dispatchEvent(new CustomEvent('polylineGenerationStarted', { detail: { isRegenerate: true } }));

    const isBreadcrumbMode = selectedPolylineOption === 'breadcrumbs';
    const breadcrumbResults = [];

    try {
      for (const driverId of driverIds) {
        try {
          if (isBreadcrumbMode) {
            // ── Mode B: Breadcrumb slicing only ─────────────────────────
            const result = await runBreadcrumbMode(driverId);
            breadcrumbResults.push({
              driverId,
              stopsSliced: Number(result?.stops_sliced || 0),
              stopsSkipped: Number(result?.stops_skipped || 0),
              skipped: !!result?.skipped,
              skipReason: result?.reason || null,
            });
          } else {
            // ── Mode A: Three-pass polyline regeneration ─────────────────
            const result = await runPolylineMode(driverId);
            console.log(`[ResetPolylinesButton] Mode A complete for ${driverId}:`, result);
          }
        } catch (err) {
          console.warn(`[ResetPolylinesButton] Failed for driver ${driverId}:`, err?.message || err);
          toast({
            title: 'Polyline regeneration failed',
            description: err?.message || 'An error occurred.',
            variant: 'destructive',
          });
        }

        // Brief pause between drivers
        if (driverIds.length > 1) await tick(500);
      }

      if (isBreadcrumbMode) {
        const totalSliced = breadcrumbResults.reduce((s, r) => s + r.stopsSliced, 0);
        const totalSkipped = breadcrumbResults.reduce((s, r) => s + r.stopsSkipped, 0);
        const allSkipped = breadcrumbResults.every(r => r.skipped);
        toast({
          title: allSkipped ? 'No master timeline found' : 'Breadcrumb resegmentation complete',
          description: allSkipped
            ? 'No master GPS timeline record exists for this driver/date.'
            : `${totalSliced} stop${totalSliced === 1 ? '' : 's'} resegmented • ${totalSkipped} skipped`,
        });
      } else {
        toast({
          title: 'Polylines regenerated',
          description: `Route polylines updated for ${driverIds.length} driver${driverIds.length === 1 ? '' : 's'}.`,
        });
      }
    } finally {
      smartRefreshManager.restart();
      setIsResetting(false);
      window.dispatchEvent(new CustomEvent('routeOptimizationComplete', { detail: { source: 'reset_polylines' } }));
    }
  };

  if (mode === "fab") {
    return (
      <Button
        onClick={handleReset}
        disabled={disabled || isResetting || driverIds.length === 0}
        title="Reset and update all polylines"
        className={`inline-flex items-center justify-center h-10 w-10 rounded-lg shadow-2xl p-0 transition-all duration-200 bg-slate-700 hover:bg-slate-800 ${className}`}
        style={{ pointerEvents: "auto", touchAction: "manipulation" }}
      >
        {isResetting
          ? <Loader2 className="w-5 h-5 text-white animate-spin" />
          : <RotateCcw className="w-5 h-5 text-white" />}
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={handleReset}
      disabled={disabled || isResetting || driverIds.length === 0}
      className={`h-8 gap-2 ${className}`}
      style={{ background: "var(--bg-white)", borderColor: "var(--border-slate-300)", color: "var(--text-slate-900)" }}
      title="Refresh polylines"
    >
      {isResetting
        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
        : <RotateCcw className="w-3.5 h-3.5" />}
    </Button>
  );
}