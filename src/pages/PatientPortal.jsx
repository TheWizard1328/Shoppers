import React, { useState, useEffect, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Menu, X, Package, MapPin, Clock, Truck, CheckCircle, RefreshCw, HeartPulse } from 'lucide-react';
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

const storeIcon = L.divIcon({
  html: `<div style="background:#1e293b;color:white;width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.3);font-size:18px;">🏥</div>`,
  className: '',
  iconSize: [36, 36],
  iconAnchor: [18, 18],
});

const patientIcon = L.divIcon({
  html: `<div style="background:#2563eb;color:white;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.3);font-size:18px;border:3px solid white;">📦</div>`,
  className: '',
  iconSize: [36, 36],
  iconAnchor: [18, 18],
});

const driverIcon = L.divIcon({
  html: `<div style="background:#16a34a;color:white;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.3);font-size:18px;border:3px solid white;">🚚</div>`,
  className: '',
  iconSize: [36, 36],
  iconAnchor: [18, 18],
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
  completed: { label: 'Delivered', color: 'text-green-700 bg-green-50 border-green-200', Icon: CheckCircle },
  failed: { label: 'Attempted', color: 'text-red-700 bg-red-50 border-red-200', Icon: X },
  cancelled: { label: 'Cancelled', color: 'text-slate-600 bg-slate-50 border-slate-200', Icon: X },
  in_transit: { label: 'In Transit', color: 'text-blue-700 bg-blue-50 border-blue-200', Icon: Truck },
  en_route: { label: 'En Route', color: 'text-blue-700 bg-blue-50 border-blue-200', Icon: Truck },
  pending: { label: 'Scheduled', color: 'text-amber-700 bg-amber-50 border-amber-200', Icon: Clock },
};

export default function PatientPortal() {
  const patient = PatientSessionManager.getPatient();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [deliveries, setDeliveries] = useState([]);
  const [stores, setStores] = useState([]);
  const [todayDelivery, setTodayDelivery] = useState(null);
  const [driverLocation, setDriverLocation] = useState(null);
  const [loading, setLoading] = useState(true);
  const driverPollRef = useRef(null);

  // ── Load all patient deliveries + stores ──────────────────────────
  useEffect(() => {
    if (!patient?.id) return;
    loadData();
  }, [patient?.id]);

  const loadData = async () => {
    setLoading(true);
    try {
      // All deliveries for this patient
      const allDeliveries = await base44.entities.Delivery.filter(
        { patient_id: patient.id },
        '-delivery_date',
        200
      );
      setDeliveries(allDeliveries);

      // Today's active delivery (if any)
      const activeToday = allDeliveries.find(
        (d) => d.delivery_date === TODAY && !['cancelled', 'failed'].includes(d.status)
      );
      setTodayDelivery(activeToday || null);

      // Trigger 1-hour expiration if today's delivery is already completed
      if (activeToday?.status === 'completed') {
        PatientSessionManager.startExpirationTimer();
      }

      // Unique store IDs from deliveries
      const storeIds = [...new Set(allDeliveries.map((d) => d.store_id).filter(Boolean))];
      if (storeIds.length > 0) {
        const allStores = await base44.entities.Store.filter({});
        setStores(allStores.filter((s) => storeIds.includes(s.id)));
      }
    } catch (err) {
      console.error('PatientPortal load error:', err);
    } finally {
      setLoading(false);
    }
  };

  // ── Poll driver location when there's an active en-route delivery ─
  useEffect(() => {
    const isActive = todayDelivery && ['in_transit', 'en_route'].includes(todayDelivery.status);
    if (!isActive) {
      setDriverLocation(null);
      if (driverPollRef.current) clearInterval(driverPollRef.current);
      return;
    }

    const fetchDriverLocation = async () => {
      try {
        const appUsers = await base44.entities.AppUser.filter({ user_id: todayDelivery.driver_id });
        const driver = appUsers?.[0];
        if (driver?.current_latitude && driver?.current_longitude) {
          setDriverLocation({ lat: driver.current_latitude, lng: driver.current_longitude, name: driver.user_name });
        }
      } catch (_) {}
    };

    fetchDriverLocation();
    driverPollRef.current = setInterval(fetchDriverLocation, 20_000);
    return () => clearInterval(driverPollRef.current);
  }, [todayDelivery?.id, todayDelivery?.status]);

  // ── Real-time subscribe to today's delivery updates ────────────────
  useEffect(() => {
    if (!todayDelivery?.id) return;
    const unsubscribe = base44.entities.Delivery.subscribe((event) => {
      if (event.data?.id === todayDelivery.id) {
        setTodayDelivery((prev) => ({ ...prev, ...event.data }));
        // Start expiration timer on completion
        if (event.data?.status === 'completed') {
          PatientSessionManager.startExpirationTimer();
        }
      }
    });
    return unsubscribe;
  }, [todayDelivery?.id]);

  // ── Map markers ───────────────────────────────────────────────────
  const storeMap = {};
  stores.forEach((s) => { storeMap[s.id] = s; });

  const activeStore = todayDelivery ? storeMap[todayDelivery.store_id] : null;

  const mapPositions = [
    activeStore?.latitude && activeStore?.longitude ? [activeStore.latitude, activeStore.longitude] : null,
    patient?.latitude && patient?.longitude ? [patient.latitude, patient.longitude] : null,
    driverLocation ? [driverLocation.lat, driverLocation.lng] : null,
  ].filter(Boolean);

  const defaultCenter = patient?.latitude && patient?.longitude
    ? [patient.latitude, patient.longitude]
    : [53.5461, -113.4938]; // Edmonton fallback

  // Today's status display
  const statusConfig = todayDelivery ? STATUS_CONFIG[todayDelivery.status] || STATUS_CONFIG.pending : null;

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
          <div className="ml-auto">
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
                  <Truck className="w-3.5 h-3.5" />
                  Driver is on the way — map updates every 20 seconds
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