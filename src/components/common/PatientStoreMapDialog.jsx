import React, { useEffect, useState } from 'react';
import { MapContainer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CachedTileLayer } from '@/components/utils/hereTileCache';
import { getHereApiKey, getOrFetchHereApiKey } from '@/components/utils/hereApiKeyStore';

/**
 * Patient / store / driver map dialog (owner spec Nov 6 2026).
 *
 * "A square map in the middle of the screen similar to the type of map we use
 * for the route editor that shows the patient's location and the store
 * location, plus the driver's current location when opened on a driver's
 * primary device. Fully zoomed in to show all visible markers and centred."
 *
 * Same HERE raster tiles as the route editor / PatientGPSMap, square dialog,
 * one fitBounds across every marker that actually has coordinates.
 */

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

const buildTileUrl = (apiKey) =>
  `https://maps.hereapi.com/v3/base/mc/{z}/{x}/{y}/png?style=explore.day&size=512&apiKey=${apiKey}`;

const createCircleIcon = (color, size = 20, label = '') => {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size + 8}" height="${size + 8}" viewBox="0 0 ${size + 8} ${size + 8}">
      <circle cx="${(size + 8) / 2}" cy="${(size + 8) / 2}" r="${size / 2}" fill="${color}" stroke="white" stroke-width="2.5"/>
      ${label ? `<text x="${(size + 8) / 2}" y="${(size + 8) / 2 + 4}" text-anchor="middle" font-size="11" font-weight="bold" fill="white">${label}</text>` : ''}
    </svg>`;
  return L.divIcon({
    html: svg,
    className: '',
    iconSize: [size + 8, size + 8],
    iconAnchor: [(size + 8) / 2, (size + 8) / 2],
    popupAnchor: [0, -(size + 8) / 2],
  });
};

const PATIENT_ICON = createCircleIcon('#16a34a', 22, 'P');
const STORE_ICON = createCircleIcon('#2563eb', 22, 'S');
const DRIVER_ICON = createCircleIcon('#f97316', 20, 'D');

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function FitBoundsEffect({ points }) {
  const map = useMap();
  useEffect(() => {
    const pts = (points || []).filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
    if (pts.length === 0) return;
    try {
      if (pts.length === 1) {
        map.setView(pts[0], 16, { animate: false });
        return;
      }
      const bounds = L.latLngBounds(pts);
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 17, animate: false });
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, JSON.stringify(points || [])]);
  return null;
}

export default function PatientStoreMapDialog({ open, onClose, patient, store, driverLocation = null }) {
  const [hereApiKey, setHereApiKey] = useState(() => getHereApiKey() || null);

  useEffect(() => {
    if (!open || hereApiKey) return;
    getOrFetchHereApiKey().then((key) => { if (key) setHereApiKey(key); }).catch(() => {});
  }, [open, hereApiKey]);

  const patientLat = num(patient?.latitude);
  const patientLng = num(patient?.longitude);
  const storeLat = num(store?.latitude);
  const storeLng = num(store?.longitude);
  const driverLat = num(driverLocation?.latitude);
  const driverLng = num(driverLocation?.longitude);

  const points = [];
  if (patientLat !== null && patientLng !== null) points.push([patientLat, patientLng]);
  if (storeLat !== null && storeLng !== null) points.push([storeLat, storeLng]);
  if (driverLat !== null && driverLng !== null) points.push([driverLat, driverLng]);

  const center = points[0] || [53.5461, -113.4938];

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose?.(); }}>
      <DialogContent className="p-0 overflow-hidden w-[92vw] max-w-[620px] rounded-xl">
        <DialogHeader className="px-3 pt-3 pb-1">
          <DialogTitle className="text-sm font-semibold text-body">
            {patient?.full_name || patient?.patient_name || 'Patient'} · {store?.name || 'Store'}
          </DialogTitle>
        </DialogHeader>
        <div className="relative w-full" style={{ height: 'min(78vw, 520px)' }}>
          {points.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-soft px-6 text-center">
              No coordinates saved yet. Add an address with a Google match, or refresh the distance after the GPS is set.
            </div>
          ) : (
            <MapContainer
              center={center}
              zoom={15}
              style={{ height: '100%', width: '100%' }}
              zoomControl={true}
              attributionControl={false}
            >
              {hereApiKey && (
                <CachedTileLayer
                  key="patient-store-map-base"
                  attribution='&copy; <a href="https://www.here.com/">HERE</a>'
                  url={buildTileUrl(hereApiKey)}
                  tileSize={512}
                  zoomOffset={-1}
                  keepBuffer={0}
                />
              )}
              <FitBoundsEffect points={points} />

              {storeLat !== null && storeLng !== null && (
                <Marker position={[storeLat, storeLng]} icon={STORE_ICON}>
                  <Popup autoPan={false}>
                    <div className="text-xs">
                      <div className="font-bold text-blue-700 mb-0.5">Store</div>
                      <div>{store?.name || 'Assigned store'}</div>
                      {store?.address && <div className="text-slate-500">{store.address}</div>}
                    </div>
                  </Popup>
                </Marker>
              )}

              {patientLat !== null && patientLng !== null && (
                <Marker position={[patientLat, patientLng]} icon={PATIENT_ICON}>
                  <Popup autoPan={false}>
                    <div className="text-xs">
                      <div className="font-bold text-emerald-700 mb-0.5">Patient</div>
                      <div>{patient?.full_name || patient?.patient_name || 'Selected patient'}</div>
                      {patient?.address && <div className="text-slate-500">{patient.address}</div>}
                    </div>
                  </Popup>
                </Marker>
              )}

              {driverLat !== null && driverLng !== null && (
                <Marker position={[driverLat, driverLng]} icon={DRIVER_ICON}>
                  <Popup autoPan={false}>
                    <div className="text-xs">
                      <div className="font-bold text-orange-600 mb-0.5">Driver</div>
                      <div>{driverLocation?.name || 'Current device'}</div>
                    </div>
                  </Popup>
                </Marker>
              )}
            </MapContainer>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
