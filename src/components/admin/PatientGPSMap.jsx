import React, { useState, useEffect, useRef } from 'react';
import { MapContainer, Marker, Popup, Circle, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { CachedTileLayer } from '../utils/hereTileCache';
import { getHereApiKey, getOrFetchHereApiKey } from '../utils/hereApiKeyStore';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

const buildTileUrl = (apiKey) =>
  `https://maps.hereapi.com/v3/base/mc/{z}/{x}/{y}/png?style=explore.day&size=512&apiKey=${apiKey}`;

// Creates a colored circle icon
const createCircleIcon = (color, size = 18, label = '') => {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size + 8}" height="${size + 8}" viewBox="0 0 ${size + 8} ${size + 8}">
      <circle cx="${(size + 8) / 2}" cy="${(size + 8) / 2}" r="${size / 2}" fill="${color}" stroke="white" stroke-width="2.5"/>
      ${label ? `<text x="${(size + 8) / 2}" y="${(size + 8) / 2 + 4}" text-anchor="middle" font-size="10" font-weight="bold" fill="white">${label}</text>` : ''}
    </svg>`;
  return L.divIcon({
    html: svg,
    className: '',
    iconSize: [size + 8, size + 8],
    iconAnchor: [(size + 8) / 2, (size + 8) / 2],
    popupAnchor: [0, -(size + 8) / 2],
  });
};

const DIRECT_ICON = createCircleIcon('#2563eb', 22, '★');
const OLD_ICON = createCircleIcon('#94a3b8', 18);
const MATCH_ICON = createCircleIcon('#16a34a', 18);
const MATCH_INACTIVE_ICON = createCircleIcon('#dc2626', 14);

function FitBoundsEffect({ points }) {
  const map = useMap();
  const fittedRef = useRef(false);

  useEffect(() => {
    if (!points || points.length === 0) return;
    fittedRef.current = false;
  }, [points]);

  useEffect(() => {
    if (!points || points.length === 0 || fittedRef.current) return;
    try {
      const bounds = L.latLngBounds(points.filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng)));
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16, animate: true });
        fittedRef.current = true;
      }
    } catch {}
  }, [map, points]);

  return null;
}

export default function PatientGPSMap({ log, matchingPatients = [] }) {
  const [hereApiKey, setHereApiKey] = useState(() => getHereApiKey() || null);

  useEffect(() => {
    if (hereApiKey) return;
    getOrFetchHereApiKey().then((key) => { if (key) setHereApiKey(key); }).catch(() => {});
  }, []);

  const hasNew = Number.isFinite(log?.new_latitude) && Number.isFinite(log?.new_longitude);
  const hasOld = Number.isFinite(log?.old_latitude) && Number.isFinite(log?.old_longitude);

  const allPoints = [];
  if (hasOld) allPoints.push([log.old_latitude, log.old_longitude]);
  if (hasNew) allPoints.push([log.new_latitude, log.new_longitude]);
  matchingPatients.forEach((p) => {
    if (Number.isFinite(p.latitude) && Number.isFinite(p.longitude)) {
      allPoints.push([p.latitude, p.longitude]);
    }
  });

  const center = hasNew
    ? [log.new_latitude, log.new_longitude]
    : allPoints.length > 0
    ? allPoints[0]
    : [53.5461, -113.4938];

  if (!log) {
    return (
      <div className="h-full flex items-center justify-center text-slate-400 text-sm">
        <div className="text-center">
          <div className="text-3xl mb-2">🗺️</div>
          <div>Select a patient card to view on map</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full relative">
      <MapContainer
        center={center}
        zoom={14}
        style={{ height: '100%', width: '100%' }}
        zoomControl={true}
      >
        {hereApiKey && (
          <CachedTileLayer
            key="gps-map-base"
            attribution='&copy; <a href="https://www.here.com/">HERE</a>'
            url={buildTileUrl(hereApiKey)}
            tileSize={512}
            zoomOffset={-1}
            keepBuffer={0}
          />
        )}

        <FitBoundsEffect points={allPoints} />

        {/* Old position (grey) */}
        {hasOld && (
          <Marker position={[log.old_latitude, log.old_longitude]} icon={OLD_ICON}>
            <Popup autoPan={false} closeButton={false} className="custom-popup">
              <div className="text-xs">
                <div className="font-bold text-slate-500 mb-0.5">Old Position</div>
                <div className="text-slate-600">{log.patient_name}</div>
                <div className="text-slate-400 font-mono">{log.old_latitude?.toFixed(5)}, {log.old_longitude?.toFixed(5)}</div>
              </div>
            </Popup>
          </Marker>
        )}

        {/* Arrow line from old to new */}
        {hasOld && hasNew && (
          <Circle
            center={[log.old_latitude, log.old_longitude]}
            radius={3}
            pathOptions={{ color: '#94a3b8', fillColor: '#94a3b8', fillOpacity: 0.3, weight: 1, dashArray: '4 4' }}
          />
        )}

        {/* New / direct change position (blue star) */}
        {hasNew && (
          <Marker position={[log.new_latitude, log.new_longitude]} icon={DIRECT_ICON} zIndexOffset={2000}>
            <Popup autoPan={false} closeButton={false} className="custom-popup">
              <div className="text-xs">
                <div className="font-bold text-blue-700 mb-0.5">★ Direct Change</div>
                <div className="text-slate-700 font-medium">{log.patient_name}</div>
                {log.patient_address && <div className="text-slate-500">{log.patient_address}</div>}
                <div className="text-slate-400 font-mono mt-0.5">{log.new_latitude?.toFixed(5)}, {log.new_longitude?.toFixed(5)}</div>
              </div>
            </Popup>
          </Marker>
        )}

        {/* Matching patients at same address */}
        {matchingPatients.map((p) => {
          if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) return null;
          const isActive = p.status !== 'inactive';
          const icon = isActive ? MATCH_ICON : MATCH_INACTIVE_ICON;
          return (
            <Marker key={p.id} position={[p.latitude, p.longitude]} icon={icon} zIndexOffset={1000}>
              <Popup autoPan={false} closeButton={false} className="custom-popup">
                <div className="text-xs">
                  <div className={`font-bold mb-0.5 ${isActive ? 'text-green-700' : 'text-red-600'}`}>
                    {isActive ? 'Active' : 'Inactive'} — Same Address
                  </div>
                  <div className="text-slate-700 font-medium">{p.full_name}</div>
                  {p.unit_number && <div className="text-slate-500">Unit: {p.unit_number}</div>}
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>

      {/* Legend */}
      <div className="absolute bottom-3 left-3 z-[1000] bg-white/90 rounded-lg shadow px-3 py-2 text-xs space-y-1 border border-slate-200">
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-4 rounded-full bg-blue-600 border-2 border-white shadow-sm flex items-center justify-center text-white text-[8px] font-bold">★</div>
          <span className="text-slate-700">Direct Change</span>
        </div>
        {hasOld && (
          <div className="flex items-center gap-1.5">
            <div className="w-4 h-4 rounded-full bg-slate-400 border-2 border-white shadow-sm" />
            <span className="text-slate-700">Old Position</span>
          </div>
        )}
        {matchingPatients.length > 0 && (
          <div className="flex items-center gap-1.5">
            <div className="w-4 h-4 rounded-full bg-green-600 border-2 border-white shadow-sm" />
            <span className="text-slate-700">Same Address ({matchingPatients.length})</span>
          </div>
        )}
      </div>
    </div>
  );
}