import React, { useMemo, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";
import { offlineDB } from "@/components/utils/offlineDatabase";
import { smartRefreshManager } from "@/components/utils/smartRefreshManager";
import { loadBreadcrumbsForDriver } from "@/components/utils/breadcrumbsManager";
import { getOrFetchHereApiKey } from "@/components/utils/hereApiKeyStore";
import { getInterStoreLocationSync, getInterStoreLocationByEntityId, isInterStoreDelivery } from "@/components/utils/interStoreDisplayName";
import { Loader2, RotateCcw } from "lucide-react";

// ─── HERE Flexible Polyline decode ──────────────────────────────────────────
const HERE_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const HERE_DECODER = HERE_ALPHA.split('').reduce((acc, c, i) => { acc[c] = i; return acc; }, {});

function decodeHereFlexiblePolyline(encoded) {
  if (!encoded || typeof encoded !== 'string') return [];
  const values = [];
  let current = 0, shift = 0;
  for (const char of encoded) {
    const value = HERE_DECODER[char];
    if (value == null) return [];
    current |= (value & 0x1f) << shift;
    if (value & 0x20) { shift += 5; continue; }
    values.push(current); current = 0; shift = 0;
  }
  if (shift > 0 || values.length < 2 || values[0] !== 1) return [];
  const header = values[1];
  const precision = header & 15;
  const thirdDimension = (header >> 4) & 7;
  const factor = 10 ** precision;
  const dimension = thirdDimension ? 3 : 2;
  const toSigned = (v) => ((v & 1) ? ~(v >> 1) : (v >> 1));
  let lat = 0, lon = 0;
  const coords = [];
  for (let i = 2; i < values.length; i += dimension) {
    lat += toSigned(values[i]); lon += toSigned(values[i + 1]);
    coords.push([lat / factor, lon / factor]);
  }
  return coords;
}

function encodeGooglePolyline(points) {
  const encodeSigned = (v) => {
    let s = v << 1; if (v < 0) s = ~s;
    let out = '';
    while (s >= 0x20) { out += String.fromCharCode((0x20 | (s & 0x1f)) + 63); s >>= 5; }
    return out + String.fromCharCode(s + 63);
  };
  let lastLat = 0, lastLng = 0, encoded = '';
  for (const [lat, lng] of points) {
    const latE5 = Math.round(lat * 1e5), lngE5 = Math.round(lng * 1e5);
    encoded += encodeSigned(latE5 - lastLat) + encodeSigned(lngE5 - lastLng);
    lastLat = latE5; lastLng = lngE5;
  }
  return encoded;
}

/**
 * Single multi-waypoint HERE Router v8 call.
 * Returns an array of { encoded_polyline, estimated_distance_km, estimated_duration_minutes }
 * — one entry per leg (N points → N-1 legs).
 */
async function callHereMultiStop(points, transportMode, hereApiKey) {
  const valid = (points || []).filter(p => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
  if (valid.length < 2) return [];

  const hereMode = transportMode === 'cycling' ? 'bicycle'
    : transportMode === 'pedestrian' ? 'pedestrian' : 'car';

  const params = new URLSearchParams();
  params.set('apiKey', hereApiKey);
  params.set('transportMode', hereMode);
  params.set('origin', `${valid[0].lat},${valid[0].lon}`);
  params.set('destination', `${valid[valid.length - 1].lat},${valid[valid.length - 1].lon}`);
  params.set('return', 'polyline,summary');
  valid.slice(1, -1).forEach(p => params.append('via', `${p.lat},${p.lon}`));

  const resp = await fetch(`https://router.hereapi.com/v8/routes?${params.toString()}`, {
    signal: AbortSignal.timeout(20000), headers: { accept: 'application/json' }
  });
  const data = await resp.json().catch(() => null);
  const sections = data?.routes?.[0]?.sections || [];

  // Log the API call
  base44.entities.GoogleAPILog.create({
    timestamp: new Date().toISOString(),
    api_type: 'Directions (HERE)',
    purpose: `ResetPolylines — ${valid.length - 1} leg(s), mode=${hereMode}`,
    function_name: 'ResetPolylinesButton',
    metadata: { provider: 'HERE', source: 'reset_polylines', call_count: 1 },
  }).catch(() => {});

  return valid.slice(0, -1).map((fromPt, i) => {
    const sec = sections[i] || {};
    let polyline = null;
    if (typeof sec.polyline === 'string') {
      const coords = decodeHereFlexiblePolyline(sec.polyline);
      if (coords.length > 1) polyline = encodeGooglePolyline(coords);
    }
    if (!polyline && typeof sec.encoded_polyline === 'string') polyline = sec.encoded_polyline;
    if (!polyline) {
      const toPt = valid[i + 1];
      polyline = encodeGooglePolyline([[fromPt.lat, fromPt.lon], [toPt.lat, toPt.lon]]);
    }
    const summary = sec.summary || {};
    return {
      encoded_polyline: polyline,
      estimated_distance_km: summary.length ? Number((summary.length / 1000).toFixed(3)) : null,
      estimated_duration_minutes: summary.duration ? Math.ceil(summary.duration / 60) : null,
    };
  });
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Resolve the destination coords for a delivery record. */
async function resolveStopCoords(delivery, patientMap, storeMap) {
  if (!delivery) return null;

  // Cycling markers carry their own GPS fields
  if (delivery.is_cycling_marker) {
    const lat = Number(delivery.cycling_latitude);
    const lng = Number(delivery.cycling_longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0)
      return { latitude: lat, longitude: lng };
    return null;
  }

  // InterStore stops (ISP/ISD) — resolve from InterStoreLocation cache.
  // ISP -> _interstore_source_id (pickup FROM source); ISD -> _interstore_dest_id (dropoff AT dest).
  if (!delivery.patient_id && isInterStoreDelivery(delivery.delivery_id)) {
    const _did = String(delivery.delivery_id || "").toUpperCase();
    const isISD = _did.startsWith("ISD-");
    const interstoreId = isISD
      ? (delivery._interstore_dest_id || delivery._interstore_source_id)
      : (delivery._interstore_source_id || delivery._interstore_dest_id);
    if (interstoreId) {
      // 1. Try phone-based cache lookup via delivery_id
      const loc = getInterStoreLocationSync(delivery.delivery_id);
      if (loc) {
        const lat = Number(loc.store_latitude);
        const lng = Number(loc.store_longitude);
        if (Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0))
          return { latitude: lat, longitude: lng };
      }
      // 2. Fallback: look up InterStoreLocation by entity ID
      try {
        const locById = await getInterStoreLocationByEntityId(interstoreId);
        if (locById) {
          const lat = Number(locById.store_latitude);
          const lng = Number(locById.store_longitude);
          if (Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0))
            return { latitude: lat, longitude: lng };
        }
      } catch { /* non-fatal */ }
    }
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

    // ── PASS 1: Driving baseline — SINGLE multi-waypoint HERE call ──────────
    // Build ordered point list: home (if set) + all stops in stop_order.
    // One API call covers every leg. Cycling legs will be overwritten in Pass 2.
    console.log(`[ResetPolylinesButton] PASS 1 — driving baseline, ${sorted.length} stops (1 API call)`);

    if (hereApiKey) {
      // Build waypoint list: origin first, then each stop in order
      const originPoint = homePosition
        ? { lat: homePosition.latitude, lon: homePosition.longitude }
        : null;

      const stopPoints = (await Promise.all(sorted.map(async d => {
        const c = await resolveStopCoords(d, patientMap, storeMap);
        return c ? { lat: c.latitude, lon: c.longitude, deliveryId: d.id } : null;
      }))).filter(Boolean);

      // Prepend origin if we have it; we need at least 2 points to route
      const allPoints = originPoint ? [originPoint, ...stopPoints] : stopPoints;

      if (allPoints.length >= 2) {
        try {
          const sections = await callHereMultiStop(allPoints, 'driving', hereApiKey);
          // sections[i] covers the leg arriving at allPoints[i+1]
          // allPoints[0] is origin (home), so sections[i] → stopPoints[i]
          const offset = originPoint ? 0 : 1; // when no origin, sections[i] → stopPoints[i+1]
          sections.forEach((sec, i) => {
            const targetIdx = originPoint ? i : i + 1;
            const sp = stopPoints[targetIdx];
            if (!sp || !sec?.encoded_polyline) return;
            mergeUpdate(sp.deliveryId, {
              encoded_polyline: sec.encoded_polyline,
              transport_mode: 'driving',
              ...(sec.estimated_distance_km != null ? { estimated_distance_km: sec.estimated_distance_km } : {}),
              ...(sec.estimated_duration_minutes != null ? { estimated_duration_minutes: sec.estimated_duration_minutes } : {}),
            });
          });
        } catch (err) {
          console.warn(`[ResetPolylinesButton] Pass 1 multi-stop HERE call failed:`, err?.message || err);
        }
      }
    }

    // ── PASS 2: Cycling loop patching — ONE call per cycling loop ────────────
    // Find Start/End marker pairs and re-polyline each loop in a single HERE call (bicycle mode).
    const cyclingMarkers = sorted.filter(d => d.is_cycling_marker);

    if (cyclingMarkers.length >= 2 && hereApiKey) {
      const startMarkers = cyclingMarkers.filter(m =>
        (m.delivery_notes || '').toLowerCase().includes('start')
      );
      const endMarkers = cyclingMarkers.filter(m =>
        (m.delivery_notes || '').toLowerCase().includes('end')
      );

      console.log(`[ResetPolylinesButton] PASS 2 — ${startMarkers.length} cycling loop(s), 1 API call each`);

      // Process each loop independently — each is ONE multi-waypoint cycling call
      for (const startMarker of startMarkers) {
        const matchingEnd = endMarkers.find(e =>
          Number(e.stop_order) > Number(startMarker.stop_order)
        );
        if (!matchingEnd) continue;

        const loopStops = sorted.filter(d =>
          Number(d.stop_order) >= Number(startMarker.stop_order) &&
          Number(d.stop_order) <= Number(matchingEnd.stop_order)
        );
        if (loopStops.length < 2) continue;

        console.log(`[ResetPolylinesButton] Pass 2 — cycling loop: ${loopStops.length} stops → 1 HERE call`);

        // Build waypoints for this loop: stop[0] → stop[1] → ... → stop[N-1]
        const loopPoints = (await Promise.all(loopStops.map(async d => {
          const c = await resolveStopCoords(d, patientMap, storeMap);
          return c ? { lat: c.latitude, lon: c.longitude, deliveryId: d.id } : null;
        }))).filter(Boolean);

        if (loopPoints.length < 2) continue;

        try {
          const sections = await callHereMultiStop(loopPoints, 'cycling', hereApiKey);
          // sections[i] covers the leg arriving at loopPoints[i+1]
          sections.forEach((sec, i) => {
            const targetPt = loopPoints[i + 1];
            if (!targetPt || !sec?.encoded_polyline) return;
            mergeUpdate(targetPt.deliveryId, {
              encoded_polyline: sec.encoded_polyline,
              transport_mode: 'cycling',
            });
          });
        } catch (err) {
          console.warn(`[ResetPolylinesButton] Pass 2 cycling loop call failed:`, err?.message || err);
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

    // Filter to only saved_to_route=true, non-master-timeline segments that have a polyline.
    // These are breadcrumbs already confirmed as the authoritative path for a stop —
    // they override the driving baseline polyline written in Pass 1.
    const masterStopOrder = -1;
    const pendingBreadcrumbs = (breadcrumbSegments || []).filter(seg =>
      seg &&
      seg.encoded_polyline &&
      seg.stop_order !== masterStopOrder &&
      seg.saved_to_route === true
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

    // No sealing needed — Pass 3 only reads already-sealed (saved_to_route=true) records.

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