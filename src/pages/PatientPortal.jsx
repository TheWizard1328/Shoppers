import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import PWAInstallPrompt from '@/components/common/PWAInstallPrompt';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Menu, X, Package, MapPin, Clock, Truck, CheckCircle, RefreshCw, HeartPulse, Wifi } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { PatientSessionManager } from '@/components/patient-portal/PatientSessionManager';
import PatientPortalGuard from '@/components/patient-portal/PatientPortalGuard';
import PatientSidebar from '@/components/patient-portal/PatientSidebar';
import { format } from 'date-fns';
import { createLiveMarkerInterpolator } from '@/components/utils/liveMarkerInterpolator';

// Fix default Leaflet icon paths
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const HOUSE_SVG = (strokeColor) =>
  `<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='${strokeColor}' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><path d='M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'/><polyline points='9 22 9 12 15 12 15 22'/></svg>`;

function makeStoreIcon(pickupDone) {
  const bg = pickupDone ? '#16a34a' : 'white';
  const border = pickupDone ? '#15803d' : '#e2e8f0';
  return L.divIcon({
    html: `<div style="background:${bg};width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.3);border:2px solid ${border};overflow:hidden;"><img src="https://media.base44.com/images/public/68570f3cd01bfa2d2408a9d6/189b7cc2c_ShoppersLogo.ico" style="width:30px;height:30px;object-fit:contain;" /></div>`,
    className: '',
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  });
}

function makePatientIcon(deliveryStatus, isNextDelivery, stopsBeforeCount) {
  let bg = '#2563eb';
  let iconColor = 'white';
  if (deliveryStatus === 'completed') { bg = '#16a34a'; }
  else if (deliveryStatus === 'failed') { bg = '#dc2626'; }
  else if (isNextDelivery) { bg = '#ca8a04'; iconColor = '#fef08a'; }

  // Cluster badge: show stops-before count only when delivery is not yet done and count > 0
  const showBadge = stopsBeforeCount != null && stopsBeforeCount > 0 && !['completed', 'failed', 'cancelled'].includes(deliveryStatus);
  const badge = showBadge
    ? `<div style="position:absolute;top:-6px;right:-6px;background:#ef4444;color:white;border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4);z-index:10;">${stopsBeforeCount}</div>`
    : '';

  return L.divIcon({
    html: `<div style="position:relative;width:36px;height:36px;"><div style="background:${bg};color:white;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.3);border:3px solid white;">${HOUSE_SVG(iconColor)}</div>${badge}</div>`,
    className: '',
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });
}

// Balloon-knob tail (owner request, Sep 29 2026): a small triangle at the
// bottom of the circle points the TIP at the driver's exact GPS spot on the
// road. The icon anchor is the tip (bottom-center of the tail), so the circle
// body rides visibly ABOVE the driving line instead of straddling it — making
// it obvious which point along the road the driver actually is.
// v2 (owner request, Sep 29 2026): the tail is drawn as an EXTENSION of the
// white ring border — an SVG triangle with a 3px white stroke and green fill,
// tucked 5px up behind the circle so the ring visually flows down into the
// tail (speech-balloon knob) instead of a detached green wedge.
const DRIVER_MARKER_HTML = (inner) => `<div style="position:relative;width:36px;height:46px;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.3));">
  <div style="background:#16a34a;color:white;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;border:3px solid white;box-sizing:border-box;">${inner}</div>
  <svg style="position:absolute;left:0;top:31px;overflow:visible;" width="36" height="15" viewBox="0 0 36 15">
    <path d="M13 0 L18 15 L23 0 Z" fill="#16a34a" stroke="#ffffff" stroke-width="3" stroke-linejoin="round"/>
  </svg>
</div>`;

const driverIcon = L.divIcon({
  html: DRIVER_MARKER_HTML('🚚'),
  className: '',
  iconSize: [36, 46],
  iconAnchor: [18, 46],
});

// Cycling-mode driver icon: bicycle with a rider wearing a backpack.
const CYCLIST_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="5.5" cy="17.5" r="3.2"/>
  <circle cx="18.5" cy="17.5" r="3.2"/>
  <path d="M5.5 17.5 L12 17.5"/>
  <path d="M12 17.5 L9 10.5"/>
  <path d="M9 10.5 L5.5 17.5"/>
  <path d="M9 10.5 L16 10"/>
  <path d="M12 17.5 L16 10 L18.5 17.5"/>
  <path d="M8 10.1 L10 10.1"/>
  <path d="M15.4 10 L16.6 9.2"/>
  <path d="M9 10 L12.4 13.4 L12 17.3"/>
  <path d="M13.8 6.6 L9 10"/>
  <path d="M13.8 6.6 L16.2 9.6"/>
  <circle cx="15" cy="5.1" r="1.6" fill="#ffffff" stroke="none"/>
  <g transform="translate(9.4,5.4) rotate(-35)">
    <rect x="-2.1" y="-3.2" width="4.2" height="6.4" rx="1.4" fill="#ffffff" stroke="none"/>
    <path d="M-1.2 1.4 H1.2" stroke="#16a34a" stroke-width="0.8" opacity="0.5"/>
  </g>
</svg>`;

const cyclingDriverIcon = L.divIcon({
  html: DRIVER_MARKER_HTML(CYCLIST_SVG),
  className: '',
  iconSize: [36, 46],
  iconAnchor: [18, 46],
});

// Smoothly animated driver marker — mirrors the shared-location glide used for
// driver dots on dispatcher devices (LiveDriverLocationInterpolator trail mode).
// The declarative position is seeded ONCE; every 15s AppUser fix is handed to
// the interpolator and the rAF loop moves the marker imperatively via
// setLatLng so Leaflet never tears down/rebuilds its DOM on each update.
function AnimatedDriverMarker({ driverLocation, legCoords, icon, children }) {
  const markerRef = useRef(null);
  const interpRef = useRef(null);
  const initialPosRef = useRef(null);
  const rafRef = useRef(0);
  const lastPaintRef = useRef(0);

  if (!interpRef.current) interpRef.current = createLiveMarkerInterpolator({ mode: 'trail' });

  // Seed the stable React position once — later movement is imperative only
  if (!initialPosRef.current && driverLocation) {
    initialPosRef.current = [Number(driverLocation.lat), Number(driverLocation.lng)];
  }

  // Feed each new 15s fix to the interpolator, along with the current-leg
  // road geometry so the glide follows the route instead of cutting corners.
  useEffect(() => {
    if (!driverLocation) return;
    const la = Number(driverLocation.lat);
    const lng = Number(driverLocation.lng);
    if (!Number.isFinite(la) || !Number.isFinite(lng)) return;
    if (!initialPosRef.current) initialPosRef.current = [la, lng];
    interpRef.current.setPath(Array.isArray(legCoords) && legCoords.length > 1 ? legCoords : null);
    interpRef.current.onFix(la, lng, Date.now());
  }, [driverLocation?.lat, driverLocation?.lng, legCoords]);

  // rAF glide loop (~20fps) — same paint cadence as the dashboard trail dots
  useEffect(() => {
    const loop = () => {
      rafRef.current = window.requestAnimationFrame(loop);
      const now = Date.now();
      if (now - lastPaintRef.current < 50) return;
      lastPaintRef.current = now;
      const marker = markerRef.current;
      if (!marker?.setLatLng) return;
      const p = interpRef.current.getDisplayPosition(now);
      if (p) marker.setLatLng([p.latitude, p.longitude]);
    };
    rafRef.current = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(rafRef.current);
  }, []);

  if (!driverLocation) return null;
  return (
    <Marker ref={markerRef} position={initialPosRef.current} icon={icon}>
      {children}
    </Marker>
  );
}

// Fits the map to patient + store on load (once both are available).
// If the driver is live, fits driver + patient instead.
function MapBoundsFitter({ patientLatLng, storeLatLng, driverLatLng, showDriver }) {
  const map = useMap();
  const fittedRef = useRef(false);

  useEffect(() => {
    // Already fitted — don't re-run
    if (fittedRef.current) return;

    // Must have patient location
    if (!patientLatLng) return;

    if (showDriver && driverLatLng) {
      // Driver is live: fit driver + patient
      fittedRef.current = true;
      map.fitBounds(L.latLngBounds([driverLatLng, patientLatLng]), { padding: [70, 70], animate: true });
    } else if (storeLatLng) {
      // Normal case: fit store + patient (wait until store is loaded)
      fittedRef.current = true;
      map.fitBounds(L.latLngBounds([storeLatLng, patientLatLng]), { padding: [70, 70], animate: true });
    }
    // If neither condition met yet, effect will re-run when deps change
  }, [
    patientLatLng ? patientLatLng.join(',') : null,
    storeLatLng ? storeLatLng.join(',') : null,
    driverLatLng ? driverLatLng.join(',') : null,
    showDriver,
  ]);

  return null;
}

// Tracks driver+patient, handles double-tap to reset tracking
function DriverTracker({ driverLocation, patientLatLng, trackingMode, onDoubleTap, onUserInteract }) {
  const map = useMap();

  // Auto-pan when driver moves and tracking is active
  useEffect(() => {
    if (!trackingMode || !driverLocation || !patientLatLng) return;
    const positions = [
      [driverLocation.lat, driverLocation.lng],
      patientLatLng,
    ];
    map.fitBounds(L.latLngBounds(positions), { padding: [60, 60], animate: true });
  }, [driverLocation?.lat, driverLocation?.lng, trackingMode]);

  // Listen for double-tap to re-enable tracking mode
  useEffect(() => {
    const handleDblClick = () => onDoubleTap();
    map.on('dblclick', handleDblClick);
    // Any user drag/zoom disables tracking
    const handleInteract = () => onUserInteract();
    map.on('dragstart', handleInteract);
    map.on('zoomstart', handleInteract);
    return () => {
      map.off('dblclick', handleDblClick);
      map.off('dragstart', handleInteract);
      map.off('zoomstart', handleInteract);
    };
  }, [map, onDoubleTap, onUserInteract]);

  return null;
}

const TODAY = format(new Date(), 'yyyy-MM-dd');

// Decode Google-encoded polyline to [[lat, lng], ...]
function decodePolyline(encoded) {
  if (!encoded || typeof encoded !== 'string') return [];
  let index = 0, lat = 0, lng = 0;
  const coords = [];
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lat / 1e5, lng / 1e5]);
  }
  return coords;
}

export default function PatientPortal({ embedded = false } = {}) {
  const patient = PatientSessionManager.getPatient();
  const [sidebarOpen, setSidebarOpen]       = useState(false);
  const [deliveries, setDeliveries]         = useState([]);
  const [pickupStops, setPickupStops]       = useState([]);
  const [stores, setStores]                 = useState([]);
  const [todayDelivery, setTodayDelivery]   = useState(null);
  const [driverLocation, setDriverLocation] = useState(null);
  const [loading, setLoading]               = useState(true);
  const [liveConnected, setLiveConnected]   = useState(false);
  const [stopsBeforePatient, setStopsBeforePatient] = useState(null);
  const [routeDeliveries, setRouteDeliveries] = useState([]);
  // trackingMode: when true the map auto-pans to keep driver+patient in view
  const [trackingMode, setTrackingMode] = useState(false);
  const [driverStatus, setDriverStatus] = useState(null);

  // Keep a ref to the current todayDelivery so subscriptions can read it without
  // going stale in closures.
  const todayDeliveryRef = useRef(null);
  todayDeliveryRef.current = todayDelivery;

  // Holds the full driver route snapshot for live badge recalculation
  const routeDeliveriesRef = useRef([]);

  // ── Initial data load ─────────────────────────────────────────────
  const loadData = useCallback(async () => {
    if (!patient?.id) return;
    setLoading(true);
    try {
      const allDeliveries = await base44.entities.Delivery.filter(
        { patient_id: patient.id },
        '-delivery_date',
        200
      );
      setDeliveries(allDeliveries);

      // Fetch pickup stops so sidebar can show "Picked up at" times.
      // PUIDs are unique per date per pickup, so querying puid + delivery_date gives exactly
      // the one pickup stop record for that route day — works for all historical dates.
      const puidDatePairs = [
        ...new Map(
          allDeliveries
            .filter((d) => d.puid && d.delivery_date)
            .map((d) => [`${d.puid}|${d.delivery_date}`, { puid: d.puid, delivery_date: d.delivery_date }])
        ).values(),
      ];
      if (puidDatePairs.length > 0) {
        try {
          const results = await Promise.all(
            puidDatePairs.map(({ puid, delivery_date }) =>
              base44.entities.Delivery.filter({ puid, delivery_date }, '-delivery_date', 10)
                .catch(() => [])
            )
          );
          // The pickup stop is the record with no patient_id and no interstore source
          const allPickups = results.flat().filter((d) => !d.patient_id && !d._interstore_source_id);
          setPickupStops(allPickups);
        } catch (_) {}
      }

      const activeToday = allDeliveries.find(
        (d) => d.delivery_date === TODAY && !['cancelled', 'failed'].includes(d.status)
      ) || null;
      setTodayDelivery(activeToday);

      if (activeToday?.status === 'completed') {
        PatientSessionManager.startExpirationTimer();
      }

      // Count stops before patient on the driver's route (and seed the live ref)
      if (activeToday?.driver_id && activeToday?.stop_order != null) {
        try {
          const routeDeliveries = await base44.entities.Delivery.filter({
            driver_id: activeToday.driver_id,
            delivery_date: TODAY,
          });
          routeDeliveriesRef.current = routeDeliveries;
          setRouteDeliveries(routeDeliveries);
          const countBefore = routeDeliveries.filter((d) =>
            d.id !== activeToday.id &&
            Number(d.stop_order) < Number(activeToday.stop_order) &&
            !['completed', 'failed', 'cancelled'].includes(d.status)
          ).length;
          setStopsBeforePatient(countBefore);
        } catch (_) {
          setStopsBeforePatient(null);
        }
      } else {
        routeDeliveriesRef.current = [];
        setStopsBeforePatient(null);
      }

      // Seed driver location from initial load (no poll — WS takes over after this)
      if (activeToday?.driver_id && ['in_transit', 'en_route'].includes(activeToday.status)) {
        try {
          const appUsers = await base44.entities.AppUser.filter({ user_id: activeToday.driver_id });
          const driver = appUsers?.[0];
          if (driver?.driver_status) setDriverStatus(driver.driver_status);
          if (driver?.current_latitude && driver?.current_longitude) {
            setDriverLocation({ lat: driver.current_latitude, lng: driver.current_longitude, name: driver.user_name, cycling: driver.preferred_travel_mode === 'cycling' });
          }
        } catch (_) {}
      }

      const storeIds = [...new Set([
        ...allDeliveries.map((d) => d.store_id).filter(Boolean),
        patient?.store_id,
        activeToday?.store_id,
      ].filter(Boolean))];
      const allStores = await base44.entities.Store.filter({});
      // Keep all stores that match any delivery store OR the patient's home store
      setStores(allStores.filter((s) => storeIds.includes(s.id)));
    } catch (err) {
      console.error('PatientPortal load error:', err);
    } finally {
      setLoading(false);
    }
  }, [patient?.id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Keep a ref to the current todayDelivery's driver_id and stop_order for use in WS closures
  const todayDeliveryRouteRef = useRef(null);
  todayDeliveryRouteRef.current = todayDelivery
    ? { driver_id: todayDelivery.driver_id, stop_order: todayDelivery.stop_order, id: todayDelivery.id }
    : null;

  // Helper: recount stops before patient from a given route deliveries array
  const recountStopsBefore = useCallback((routeDeliveries, patientDelivery) => {
    if (!patientDelivery?.stop_order == null) return;
    const count = routeDeliveries.filter((d) =>
      d.id !== patientDelivery.id &&
      Number(d.stop_order) < Number(patientDelivery.stop_order) &&
      !['completed', 'failed', 'cancelled'].includes(d.status)
    ).length;
    setStopsBeforePatient(count);
  }, []);

  // ── WebSocket: Delivery subscription ─────────────────────────────
  // Listens for any Delivery change. Filters to this patient's records for
  // todayDelivery/deliveries state, AND tracks all route stops for the badge count.
  useEffect(() => {
    if (!patient?.id) return;

    let unsub;
    try {
      unsub = base44.entities.Delivery.subscribe((event) => {
        const updated = event?.data;
        if (!updated?.id) return;

        setLiveConnected(true);

        // --- Update route deliveries ref for badge recalculation ---
        const route = todayDeliveryRouteRef.current;
        if (
          route &&
          updated.driver_id === route.driver_id &&
          updated.delivery_date === TODAY
        ) {
          // Patch or add this delivery into our local route snapshot
          const existing = routeDeliveriesRef.current;
          const idx = existing.findIndex((d) => d.id === updated.id);
          const next = idx >= 0
            ? existing.map((d) => d.id === updated.id ? { ...d, ...updated } : d)
            : [...existing, updated];
          routeDeliveriesRef.current = next;
          setRouteDeliveries([...next]);
          // Recount badge using the patient's own delivery as reference
          recountStopsBefore(routeDeliveriesRef.current, route);
        }

        // --- Update this patient's own deliveries ---
        if (updated.patient_id !== patient.id) return;

        // Patch deliveries list
        setDeliveries((prev) => {
          const exists = prev.some((d) => d.id === updated.id);
          if (exists) return prev.map((d) => d.id === updated.id ? { ...d, ...updated } : d);
          return [updated, ...prev];
        });

        // Keep todayDelivery in sync
        setTodayDelivery((prev) => {
          if (prev?.id === updated.id) {
            const next = { ...prev, ...updated };
            if (updated.status === 'completed') PatientSessionManager.startExpirationTimer();
            return next;
          }
          // Promote a newly-scheduled today delivery
          if (updated.delivery_date === TODAY && !['cancelled', 'failed'].includes(updated.status) && !prev) {
            return updated;
          }
          return prev;
        });
      });
    } catch (err) {
      console.warn('PatientPortal: Delivery WS subscription failed', err);
    }

    return () => { try { unsub?.(); } catch (_) {} };
  }, [patient?.id, recountStopsBefore]);

  // ── WebSocket: AppUser subscription (driver location) ────────────
  // Listens for any AppUser change. When the record matches the driver assigned
  // to today's active delivery, updates the map marker immediately — no polling.
  useEffect(() => {
    if (!patient?.id) return;

    let unsub;
    try {
      unsub = base44.entities.AppUser.subscribe((event) => {
        const updated = event?.data;
        if (!updated?.id) return;

        setLiveConnected(true);

        const today = todayDeliveryRef.current;
        const isActive = today && ['in_transit', 'en_route'].includes(today.status);
        if (!isActive) return;

        // Match by user_id (the AppUser.user_id field holds the auth user id,
        // which matches delivery.driver_id)
        if (updated.user_id !== today.driver_id) return;

        if (updated.driver_status) setDriverStatus(updated.driver_status);

        if (updated.current_latitude && updated.current_longitude) {
          setDriverLocation((prev) => ({
            lat: updated.current_latitude,
            lng: updated.current_longitude,
            name: updated.user_name,
            cycling: updated.preferred_travel_mode != null
              ? updated.preferred_travel_mode === 'cycling'
              : (prev?.cycling ?? false),
          }));
        }
      });
    } catch (err) {
      console.warn('PatientPortal: AppUser WS subscription failed', err);
    }

    return () => { try { unsub?.(); } catch (_) {} };
  }, [patient?.id]);

  // ── Clear driver location + tracking when delivery is no longer active ───────
  useEffect(() => {
    const isActive = todayDelivery && ['in_transit', 'en_route'].includes(todayDelivery.status);
    if (!isActive) {
      setDriverLocation(null);
      setTrackingMode(false);
    } else {
      // Auto-enable tracking when driver becomes active
      setTrackingMode(true);
    }
  }, [todayDelivery?.status]);

  // ── Map markers ───────────────────────────────────────────────────
  const storeMap = {};
  stores.forEach((s) => { storeMap[s.id] = s; });

  const activeStore   = todayDelivery ? storeMap[todayDelivery.store_id] : (patient?.store_id ? storeMap[patient.store_id] : null);

  // Store marker: green bg when pickup is done (driver has left the store = in_transit/en_route/completed)
  const pickupDone = todayDelivery ? ['in_transit', 'en_route', 'completed'].includes(todayDelivery.status) : false;
  const storeIcon = makeStoreIcon(pickupDone);

  // Cycling mode: AppUser preferred_travel_mode flag on the driver location,
  // or any active stop on today's route carrying a cycling transport_mode.
  const driverIsCycling = useMemo(() => {
    if (driverLocation?.cycling === true) return true;
    return routeDeliveries.some((d) =>
      !['completed', 'failed', 'cancelled'].includes(d.status) && d.transport_mode === 'cycling');
  }, [driverLocation?.cycling, routeDeliveries]);
  const driverMapIcon = useMemo(() => (driverIsCycling ? cyclingDriverIcon : driverIcon), [driverIsCycling]);

  // Patient marker: colour based on delivery status / isNextDelivery, badge = stops before
  const patientIcon = makePatientIcon(todayDelivery?.status, todayDelivery?.isNextDelivery, stopsBeforePatient);

  // Helper: merge decoded polyline segments, deduplicating shared endpoints
  const mergePolylineSegments = (stops) => {
    const merged = [];
    for (const stop of stops) {
      const decoded = decodePolyline(stop.encoded_polyline);
      if (decoded.length < 2) continue;
      if (merged.length > 0) {
        const [lastLat, lastLng] = merged[merged.length - 1];
        const [firstLat, firstLng] = decoded[0];
        if (Math.abs(lastLat - firstLat) < 1e-5 && Math.abs(lastLng - firstLng) < 1e-5) {
          merged.push(...decoded.slice(1));
        } else {
          merged.push(...decoded);
        }
      } else {
        merged.push(...decoded);
      }
    }
    return merged;
  };

  // Build route polylines split into:
  // 1. staticPolylineCoords — all legs EXCEPT the first stop's leg and the current leg (always visible)
  // 2. firstLegCoords — the leg from store → first stop (hidden when off duty / before 9:30)
  // 3. currentLegCoords — the leg leading to the driver's isNextDelivery stop (hidden when off duty / before 9:30)
  const { staticPolylineCoords, firstLegCoords, currentLegCoords } = useMemo(() => {
    if (!todayDelivery?.stop_order || routeDeliveries.length === 0) return { staticPolylineCoords: [], firstLegCoords: [], currentLegCoords: [] };
    const patientStopOrder = Number(todayDelivery.stop_order);
    const DONE_STATUSES = ['completed', 'failed', 'cancelled'];

    const relevantStops = routeDeliveries
      .filter((d) => d.encoded_polyline && Number(d.stop_order) <= patientStopOrder && !DONE_STATUSES.includes(d.status))
      .sort((a, b) => Number(a.stop_order) - Number(b.stop_order));

    if (relevantStops.length === 0) return { staticPolylineCoords: [], firstLegCoords: [], currentLegCoords: [] };

    const firstStop = relevantStops[0];
    const minStopOrder = Number(firstStop.stop_order);

    // Current leg = stop with isNextDelivery=true
    const currentLegStop = relevantStops.find((d) => d.isNextDelivery === true);

    // Static = everything except first stop leg and current leg
    const staticStops = relevantStops.filter((d) =>
      Number(d.stop_order) !== minStopOrder && d.isNextDelivery !== true
    );

    // First leg = first stop only (unless it's also the current leg, then it's covered there)
    const firstLegStop = firstStop.isNextDelivery ? null : firstStop;

    return {
      staticPolylineCoords: mergePolylineSegments(staticStops),
      firstLegCoords: firstLegStop ? decodePolyline(firstLegStop.encoded_polyline) : [],
      currentLegCoords: currentLegStop ? decodePolyline(currentLegStop.encoded_polyline) : [],
    };
  }, [routeDeliveries, todayDelivery?.stop_order, todayDelivery?.id]);

  const storeLatLng = activeStore?.latitude && activeStore?.longitude
    ? [activeStore.latitude, activeStore.longitude]
    : null;

  const defaultCenter = patient?.latitude && patient?.longitude
    ? [patient.latitude, patient.longitude]
    : [53.5461, -113.4938]; // Edmonton fallback

  const patientLatLng = patient?.latitude && patient?.longitude
    ? [patient.latitude, patient.longitude]
    : null;

  const handleDoubleTap = useCallback(() => setTrackingMode(true), []);
  const handleUserInteract = useCallback(() => setTrackingMode(false), []);

  // Live tracking is only visible after 9:30 AM and when driver is on_duty
  const isAfter930am = (() => {
    const now = new Date();
    return now.getHours() > 9 || (now.getHours() === 9 && now.getMinutes() >= 30);
  })();
  const showLiveTracking = isAfter930am && driverStatus === 'on_duty';

  return (
    <div className={`flex ${embedded ? 'h-full' : 'h-screen'} bg-slate-100 dark:bg-slate-800 overflow-hidden`}>
      <PatientPortalGuard />
      <PWAInstallPrompt storageKey="patient_pwa_install_dismissed" />

      {/* Sidebar */}
      <PatientSidebar
        patient={patient}
        deliveries={deliveries}
        pickupStops={pickupStops}
        stores={stores}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      {/* Main Content */}
      <div className="flex-1 flex flex-col md:ml-72 overflow-hidden">

        {/* Top Bar */}
        <div
          className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700 px-4 py-3 flex items-center gap-3 flex-shrink-0 z-10"
          style={{ paddingTop: embedded ? '0.75rem' : 'calc(0.75rem + var(--native-safe-top, env(safe-area-inset-top, 0px)))' }}
        >
          <button
            onClick={() => setSidebarOpen(true)}
            className="md:hidden w-9 h-9 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center"
          >
            <Menu className="w-5 h-5 text-slate-600 dark:text-slate-400" />
          </button>
          <div className="flex items-center gap-2">
            <HeartPulse className="w-5 h-5 text-slate-700 dark:text-slate-300 hidden md:block" />
            <div>
              <h1 className="text-sm font-bold text-slate-900 dark:text-slate-100">My Deliveries</h1>
              <p className="text-xs text-slate-400 dark:text-slate-400">{format(new Date(), 'EEEE, MMMM d')}</p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {/* Live connection indicator */}
            {liveConnected && (
              <div className="hidden sm:flex items-center gap-1.5 text-xs text-green-600 font-medium">
                <Wifi className="w-3.5 h-3.5" />
                <span>Live</span>
              </div>
            )}
            <button
              onClick={loadData}
              className="w-9 h-9 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center hover:bg-slate-200 transition-colors"
              title="Refresh"
              aria-label="Refresh"
            >
              <RefreshCw className="w-4 h-4 text-slate-500 dark:text-slate-400" />
            </button>
          </div>
        </div>

        {/* Map */}
        <div
          className="flex-1 px-4 pt-3 overflow-hidden relative"
          style={{ paddingBottom: embedded ? '1rem' : 'calc(1rem + var(--native-safe-bottom, env(safe-area-inset-bottom, 0px)))' }}
        >
          {showLiveTracking && driverLocation && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-[1000] pointer-events-none">
              <div className={`text-xs font-medium px-3 py-1 rounded-full shadow border ${trackingMode ? 'bg-green-50 dark:bg-green-950 text-green-700 border-green-200' : 'bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700'}`}>
                {trackingMode ? '📍 Tracking driver' : 'Double-tap map to track driver'}
              </div>
            </div>
          )}
          <div className="h-full rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700 shadow-sm">
            <MapContainer
              center={defaultCenter}
              zoom={13}
              style={{ height: '100%', width: '100%' }}
              zoomControl={false}
            >
              <TileLayer
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              />

              <MapBoundsFitter
                patientLatLng={patientLatLng}
                storeLatLng={storeLatLng}
                driverLatLng={driverLocation ? [driverLocation.lat, driverLocation.lng] : null}
                showDriver={showLiveTracking && !!driverLocation}
              />
              <DriverTracker
                driverLocation={showLiveTracking ? driverLocation : null}
                patientLatLng={patientLatLng}
                trackingMode={trackingMode}
                onDoubleTap={handleDoubleTap}
                onUserInteract={handleUserInteract}
              />

              {/* Remaining legs (between the driver and the patient) — solid green, always visible */}
              {staticPolylineCoords.length > 1 && (
                <Polyline
                  positions={staticPolylineCoords}
                  pathOptions={{ color: '#16a34a', weight: 4, opacity: 0.8 }}
                />
              )}

              {/* First stop leg (store → first stop) — solid green — hidden when off duty or before 9:30 AM */}
              {showLiveTracking && firstLegCoords.length > 1 && (
                <Polyline
                  positions={firstLegCoords}
                  pathOptions={{ color: '#16a34a', weight: 4, opacity: 0.8 }}
                />
              )}

              {/* Current leg (driver → isNextDelivery stop) — solid blue like the driver dashboard */}
              {showLiveTracking && currentLegCoords.length > 1 && (
                <Polyline
                  positions={currentLegCoords}
                  pathOptions={{ color: '#2563EB', weight: 5, opacity: 0.9 }}
                />
              )}

              {/* Store marker */}
              {activeStore?.latitude && activeStore?.longitude && (
                <Marker position={[activeStore.latitude, activeStore.longitude]} icon={storeIcon}>
                  <Popup><strong>{activeStore.name}</strong><br />{activeStore.address}</Popup>
                </Marker>
              )}

              {/* Patient location marker */}
              {patient?.latitude && patient?.longitude && (
                <Marker position={[patient.latitude, patient.longitude]} icon={patientIcon}>
                  <Popup><strong>Your Address</strong><br />{patient.address}</Popup>
                </Marker>
              )}

              {/* Driver marker — only when live tracking is enabled. Glides smoothly
                  between 15s location updates (same trail interpolation as the shared
                  driver dots on dispatcher maps) instead of teleporting. */}
              {showLiveTracking && driverLocation && (
                <AnimatedDriverMarker driverLocation={driverLocation} legCoords={currentLegCoords} icon={driverMapIcon}>
                  <Popup><strong>Your Driver</strong><br />{driverLocation.name || 'On the way!'}</Popup>
                </AnimatedDriverMarker>
              )}
            </MapContainer>
          </div>
        </div>
      </div>
    </div>
  );
}