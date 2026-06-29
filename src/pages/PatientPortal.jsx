import React, { useState, useEffect, useRef, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
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

function MapBoundsFitter({ positions }) {
  const map = useMap();
  useEffect(() => {
    if (positions.length === 0) return;
    if (positions.length === 1) {
      map.setView(positions[0], 14);
      return;
    }
    const bounds = L.latLngBounds(positions);
    map.fitBounds(bounds, { padding: [60, 60] });
  }, [positions.map(p => p.join(',')).join('|')]);
  return null;
}

const TODAY = format(new Date(), 'yyyy-MM-dd');

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
  const [stores, setStores]                 = useState([]);
  const [todayDelivery, setTodayDelivery]   = useState(null);
  const [driverLocation, setDriverLocation] = useState(null);
  const [loading, setLoading]               = useState(true);
  const [liveConnected, setLiveConnected]   = useState(false);
  const [stopsBeforePatient, setStopsBeforePatient] = useState(null);

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
          if (driver?.current_latitude && driver?.current_longitude) {
            setDriverLocation({ lat: driver.current_latitude, lng: driver.current_longitude, name: driver.user_name });
          }
        } catch (_) {}
      }

      const storeIds = [...new Set([
        ...allDeliveries.map((d) => d.store_id).filter(Boolean),
        patient?.store_id,
      ].filter(Boolean))];
      const allStores = await base44.entities.Store.filter({});
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
          if (idx >= 0) {
            routeDeliveriesRef.current = existing.map((d) => d.id === updated.id ? { ...d, ...updated } : d);
          } else {
            routeDeliveriesRef.current = [...existing, updated];
          }
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

  // ── Clear driver location when delivery is no longer active ───────
  useEffect(() => {
    const isActive = todayDelivery && ['in_transit', 'en_route'].includes(todayDelivery.status);
    if (!isActive) setDriverLocation(null);
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

  const mapPositions = [
    activeStore?.latitude  && activeStore?.longitude  ? [activeStore.latitude, activeStore.longitude]   : null,
    patient?.latitude      && patient?.longitude      ? [patient.latitude, patient.longitude]           : null,
    driverLocation                                    ? [driverLocation.lat, driverLocation.lng]        : null,
  ].filter(Boolean);

  const defaultCenter = patient?.latitude && patient?.longitude
    ? [patient.latitude, patient.longitude]
    : [53.5461, -113.4938]; // Edmonton fallback

  return (
    <div className="flex h-screen bg-slate-100 overflow-hidden">
      <PatientPortalGuard />

      {/* Sidebar */}
      <PatientSidebar
        patient={patient}
        deliveries={deliveries}
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
                  {todayDelivery.delivery_time_eta && !['completed', 'failed', 'cancelled'].includes(todayDelivery.status) && (
                    <p className="text-xs text-blue-600 font-medium mt-1">
                      ETA: {todayDelivery.delivery_time_eta}
                    </p>
                  )}
                </div>
                {statusConfig && (
                  <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-semibold ${statusConfig.color}`}>
                    <statusConfig.Icon className="w-3 h-3" />
                    {statusConfig.label}
                  </span>
                )}
              </div>
              {driverLocation && (
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
        <div className="flex-1 px-4 pb-4 overflow-hidden">
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

              {mapPositions.length > 0 && <MapBoundsFitter positions={mapPositions} />}

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

              {/* Driver marker */}
              {driverLocation && (
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