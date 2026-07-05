import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Menu, X, Package, MapPin, Clock, Truck, CheckCircle, RefreshCw, HeartPulse, Wifi } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { PatientSessionManager } from '@/components/patient-portal/PatientSessionManager';
import PatientPortalGuard from '@/components/patient-portal/PatientPortalGuard';
import PatientSidebar from '@/components/patient-portal/PatientSidebar';
import { format } from 'date-fns';

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

const driverIcon = L.divIcon({
  html: `<div style="background:#16a34a;color:white;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.3);font-size:18px;border:3px solid white;">🚚</div>`,
  className: '',
  iconSize: [36, 36],
  iconAnchor: [18, 36],
});

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

const STATUS_CONFIG = {
  completed: { label: 'Delivered',  color: 'text-green-700 bg-green-50 border-green-200',  Icon: CheckCircle },
  failed:    { label: 'Attempted',  color: 'text-red-700 bg-red-50 border-red-200',         Icon: X },
  cancelled: { label: 'Cancelled',  color: 'text-slate-600 bg-slate-50 border-slate-200',   Icon: X },
  in_transit:{ label: 'In Transit', color: 'text-blue-700 bg-blue-50 border-blue-200',      Icon: Truck },
  en_route:  { label: 'En Route',   color: 'text-blue-700 bg-blue-50 border-blue-200',      Icon: Truck },
  pending:   { label: 'Scheduled',  color: 'text-amber-700 bg-amber-50 border-amber-200',   Icon: Clock },
};

export default function PatientPortal() {
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
            setDriverLocation({ lat: driver.current_latitude, lng: driver.current_longitude, name: driver.user_name });
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
          setDriverLocation({
            lat: updated.current_latitude,
            lng: updated.current_longitude,
            name: updated.user_name,
          });
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
  const statusConfig  = todayDelivery ? STATUS_CONFIG[todayDelivery.status] || STATUS_CONFIG.pending : null;

  // Store marker: green bg when pickup is done (driver has left the store = in_transit/en_route/completed)
  const pickupDone = todayDelivery ? ['in_transit', 'en_route', 'completed'].includes(todayDelivery.status) : false;
  const storeIcon = makeStoreIcon(pickupDone);

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
    <div className="flex h-screen bg-slate-100 overflow-hidden">
      <PatientPortalGuard />

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
        <div className="bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-3 flex-shrink-0 z-10">
          <button
            onClick={() => setSidebarOpen(true)}
            className="md:hidden w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center"
          >
            <Menu className="w-5 h-5 text-slate-600" />
          </button>
          <div className="flex items-center gap-2">
            <HeartPulse className="w-5 h-5 text-slate-700 hidden md:block" />
            <div>
              <h1 className="text-sm font-bold text-slate-900">My Deliveries</h1>
              <p className="text-xs text-slate-400">{format(new Date(), 'EEEE, MMMM d')}</p>
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
              className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center hover:bg-slate-200 transition-colors"
              title="Refresh"
            >
              <RefreshCw className="w-4 h-4 text-slate-500" />
            </button>
          </div>
        </div>

        {/* Today's Status Card */}
        <div className="px-4 pt-4 pb-2 flex-shrink-0">
          {loading ? (
            <div className="bg-white rounded-xl border border-slate-200 p-4 animate-pulse">
              <div className="h-4 bg-slate-100 rounded w-1/3 mb-2" />
              <div className="h-6 bg-slate-100 rounded w-2/3" />
            </div>
          ) : todayDelivery ? (
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Today's Delivery</p>
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1">
                  <p className="text-sm font-semibold text-slate-800">
                    {storeMap[todayDelivery.store_id]?.name || 'Pharmacy'}
                  </p>
                  {todayDelivery.delivery_time_start && (
                    <p className="text-xs text-slate-500 mt-0.5">
                      Window: {todayDelivery.delivery_time_start}
                      {todayDelivery.delivery_time_end ? ` – ${todayDelivery.delivery_time_end}` : ''}
                    </p>
                  )}
                  {todayDelivery.status === 'completed' && todayDelivery.actual_delivery_time ? (
                    <p className="text-xs text-emerald-600 font-medium mt-1">
                      Delivered: {todayDelivery.actual_delivery_time.substring(11, 16)}
                    </p>
                  ) : todayDelivery.delivery_time_eta && !['completed', 'failed', 'cancelled'].includes(todayDelivery.status) ? (
                    <p className="text-xs text-blue-600 font-medium mt-1">
                      ETA: {todayDelivery.delivery_time_eta}
                    </p>
                  ) : null}
                </div>
                {statusConfig && (
                  <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-semibold ${statusConfig.color}`}>
                    <statusConfig.Icon className="w-3 h-3" />
                    {statusConfig.label}
                  </span>
                )}
              </div>
              {showLiveTracking && driverLocation && (
                <div className="mt-2 pt-2 border-t border-slate-100 flex items-center gap-2 text-xs text-green-700">
                  <Wifi className="w-3.5 h-3.5" />
                  Driver location updating live
                </div>
              )}
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center flex-shrink-0">
                <Package className="w-5 h-5 text-slate-400" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-700">No delivery scheduled today</p>
                <p className="text-xs text-slate-400">Check your delivery history in the sidebar.</p>
              </div>
            </div>
          )}
        </div>

        {/* Map */}
        <div className="flex-1 px-4 pb-4 overflow-hidden relative">
          {showLiveTracking && driverLocation && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-[1000] pointer-events-none">
              <div className={`text-xs font-medium px-3 py-1 rounded-full shadow border ${trackingMode ? 'bg-green-50 text-green-700 border-green-200' : 'bg-white text-slate-500 border-slate-200'}`}>
                {trackingMode ? '📍 Tracking driver' : 'Double-tap map to track driver'}
              </div>
            </div>
          )}
          <div className="h-full rounded-xl overflow-hidden border border-slate-200 shadow-sm">
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

              {/* Static polyline — all legs except first stop and current leg — always visible */}
              {staticPolylineCoords.length > 1 && (
                <Polyline
                  positions={staticPolylineCoords}
                  pathOptions={{ color: '#2563eb', weight: 4, opacity: 0.65, dashArray: '8, 6' }}
                />
              )}

              {/* First stop leg — hidden when off duty or before 9:30 AM */}
              {showLiveTracking && firstLegCoords.length > 1 && (
                <Polyline
                  positions={firstLegCoords}
                  pathOptions={{ color: '#2563eb', weight: 4, opacity: 0.65, dashArray: '8, 6' }}
                />
              )}

              {/* Current leg (isNextDelivery stop) — hidden when off duty or before 9:30 AM */}
              {showLiveTracking && currentLegCoords.length > 1 && (
                <Polyline
                  positions={currentLegCoords}
                  pathOptions={{ color: '#16a34a', weight: 4, opacity: 0.75, dashArray: '8, 6' }}
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

              {/* Driver marker — only when live tracking is enabled */}
              {showLiveTracking && driverLocation && (
                <Marker position={[driverLocation.lat, driverLocation.lng]} icon={driverIcon}>
                  <Popup><strong>Your Driver</strong><br />{driverLocation.name || 'On the way!'}</Popup>
                </Marker>
              )}
            </MapContainer>
          </div>
        </div>
      </div>
    </div>
  );
}