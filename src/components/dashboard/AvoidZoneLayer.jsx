/**
 * AvoidZoneLayer — on-map UI for the "blocked alley" system (owner rule, Oct 2 2026).
 *
 * Tap the barrier button on the map, then tap the alley you hate. That spot is
 * saved as a shared RouteAvoidZone (all users, all devices) and every CYCLING
 * route steers around it from then on (see routeAvoidZones.js + routePolylineGenerator).
 * Tap the orange circle later to expand/shrink its radius or delete it.
 *
 * Self-contained: mounts inside <MapContainer>, uses a portal into the map
 * container for its button so no layout surgery in DeliveryMap.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Circle, Popup, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import { base44 } from '@/api/base44Client';
import { clearAvoidZoneCache, fetchAvoidZones } from '../utils/routeAvoidZones';

const ZONE_TOGGLE_EVENT = 'rxdeliver:avoid-zone:toggle';
const DEFAULT_RADIUS = 60;
const MIN_RADIUS = 20;
const MAX_RADIUS = 300;

export function toggleAvoidZonePlacement() {
  window.dispatchEvent(new CustomEvent(ZONE_TOGGLE_EVENT));
}

const circleStyle = {
  color: '#f97316',
  weight: 2,
  dashArray: '6 4',
  fillColor: '#f97316',
  fillOpacity: 0.12,
};

export default function AvoidZoneLayer({ currentUser = null }) {
  const map = useMap();
  const placingRef = useRef(false);
  const [placing, setPlacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [zones, setZones] = useState([]);
  const [container, setContainer] = useState(null);

  const loadZones = useCallback(async () => {
    try {
      const fresh = await fetchAvoidZones({ force: true });
      setZones(Array.isArray(fresh) ? fresh : []);
    } catch { /* zones stay optional */ }
  }, []);

  useEffect(() => { loadZones(); }, [loadZones]);
  useEffect(() => { setContainer(map?.getContainer?.() || null); }, [map]);

  // Placement mode: toggled by the barrier button (event-based so the button
  // itself can live anywhere). One tap on the map creates the zone.
  useEffect(() => {
    const onToggle = () => {
      placingRef.current = !placingRef.current;
      setPlacing(placingRef.current);
      const el = map.getContainer?.();
      if (el) el.style.cursor = placingRef.current ? 'crosshair' : '';
    };
    window.addEventListener(ZONE_TOGGLE_EVENT, onToggle);
    return () => {
      window.removeEventListener(ZONE_TOGGLE_EVENT, onToggle);
      const el = map.getContainer?.();
      if (el && el.style.cursor === 'crosshair') el.style.cursor = '';
    };
  }, [map]);

  useMapEvents({
    click(e) {
      if (!placingRef.current) return;
      placingRef.current = false;
      setPlacing(false);
      const el = map.getContainer?.();
      if (el) el.style.cursor = '';
      const { lat, lng } = e.latlng || {};
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      setBusy(true);
      base44.entities.RouteAvoidZone.create({
        label: 'Blocked alley',
        center_lat: lat,
        center_lng: lng,
        radius_meters: DEFAULT_RADIUS,
        created_by_name: currentUser?.full_name || currentUser?.name || 'User',
      })
        .then(() => clearAvoidZoneCache())
        .then(loadZones)
        .catch((err) => console.warn('[AvoidZoneLayer] failed to create zone:', err?.message || err))
        .finally(() => setBusy(false));
    },
  });

  const adjustRadius = async (zone, delta) => {
    const next = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, (Number(zone.radius_meters) || DEFAULT_RADIUS) + delta));
    setBusy(true);
    try {
      await base44.entities.RouteAvoidZone.update(zone.id, { radius_meters: next });
      clearAvoidZoneCache();
      await loadZones();
    } catch (err) {
      console.warn('[AvoidZoneLayer] failed to resize zone:', err?.message || err);
    } finally {
      setBusy(false);
    }
  };

  const deleteZone = async (zone) => {
    setBusy(true);
    try {
      await base44.entities.RouteAvoidZone.delete(zone.id);
      clearAvoidZoneCache();
      await loadZones();
    } catch (err) {
      console.warn('[AvoidZoneLayer] failed to delete zone:', err?.message || err);
    } finally {
      setBusy(false);
    }
  };

  const radiusOf = (z) => Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, Number(z?.radius_meters) || DEFAULT_RADIUS));

  return (
    <>
      {zones.map((z) => (
        <Circle
          key={z.id}
          center={[Number(z.center_lat), Number(z.center_lng)]}
          radius={radiusOf(z)}
          pathOptions={circleStyle}
          eventHandlers={{ click: () => {} }}
        >
          <Tooltip direction="top" offset={[0, -6]}>
            {z.label || 'Blocked alley'}
            {z.created_by_name ? ` (by ${z.created_by_name})` : ''}
          </Tooltip>
          <Popup>
            <div style={{ minWidth: 170, fontSize: 13 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>{z.label || 'Blocked alley'}</div>
              <div style={{ color: '#64748b', marginBottom: 8 }}>
                Cycling routes avoid this area ({radiusOf(z)} m)
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  disabled={busy || radiusOf(z) <= MIN_RADIUS}
                  onClick={() => adjustRadius(z, -20)}
                  style={{ padding: '4px 8px', border: '1px solid #cbd5e1', borderRadius: 6, background: '#f8fafc', cursor: 'pointer' }}
                >
                  −20 m
                </button>
                <button
                  type="button"
                  disabled={busy || radiusOf(z) >= MAX_RADIUS}
                  onClick={() => adjustRadius(z, 20)}
                  style={{ padding: '4px 8px', border: '1px solid #cbd5e1', borderRadius: 6, background: '#f8fafc', cursor: 'pointer' }}
                >
                  +20 m
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => deleteZone(z)}
                  style={{ padding: '4px 8px', border: '1px solid #f87171', borderRadius: 6, background: '#fef2f2', color: '#b91c1c', cursor: 'pointer' }}
                >
                  Remove
                </button>
              </div>
            </div>
          </Popup>
        </Circle>
      ))}

      {container && createPortal(
        <button
          type="button"
          title={placing ? 'Tap the alley to block (tap button to cancel)' : 'Block an alley for cycling routes'}
          disabled={busy}
          onClick={() => toggleAvoidZonePlacement()}
          style={{
            position: 'absolute',
            left: 8,
            top: '50%',
            transform: 'translateY(-50%)',
            zIndex: 800,
            width: 38,
            height: 38,
            borderRadius: 9,
            border: placing ? '2px solid #ea580c' : '1px solid rgba(148,163,184,0.6)',
            background: placing ? '#ffedd5' : 'rgba(255,255,255,0.92)',
            fontSize: 18,
            lineHeight: 1,
            cursor: 'pointer',
            boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          🚧
        </button>,
        container
      )}
    </>
  );
}
