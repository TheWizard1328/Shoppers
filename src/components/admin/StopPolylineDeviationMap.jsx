/**
 * StopPolylineDeviationMap — App Owner debug tool inside the Route Management
 * "Stop Details" panel (owner request Oct 30 2026).
 *
 * Shows ONLY the selected stop's stored leg polyline (Delivery.encoded_polyline)
 * on a zoomable/pannable map, marks every deviation waypoint
 * (Delivery.deviation_waypoints), and lets the owner:
 *   • delete a point (click marker, or the row's trash button),
 *   • add a point (arm "Add point", then click the map),
 *   • redraw the route so the stored polylines update from the new data.
 *
 * Writes go through entityMutations.updateDelivery (single write gateway, so
 * realtime broadcasts and IDB stay consistent) and the redraw goes through the
 * client route optimizer with forceRegenerate, exactly like the manual FAB.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { MapContainer, Polyline, CircleMarker, Tooltip, useMapEvents } from 'react-leaflet';
import { getActiveHereApiKey } from '@/functions/getActiveHereApiKey';
import { CachedTileLayer } from '../utils/hereTileCache';

// Tiles: the app shell blocks the public OSM tile hosts, so use the same HERE
// basemap every other map uses (owner report Oct 30 2026: blank map).
const buildHereLightTileUrl = (k) => `https://maps.hereapi.com/v3/base/mc/{z}/{x}/{y}/png?style=explore.day&size=512&apiKey=${k}`;
const buildHereDarkTileUrl = (k) => `https://maps.hereapi.com/v3/base/mc/{z}/{x}/{y}/png?style=explore.night&size=512&apiKey=${k}`;
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Map as MapIcon, Plus, Trash2, RefreshCw, Crosshair, Loader2, Code2,
} from 'lucide-react';
import { toast } from 'sonner';
import { base44 } from '@/api/base44Client';
import 'leaflet/dist/leaflet.css';

const MAX_WAYPOINTS = 3; // schema: max 3 chronological via points per leg

// Google-encoded polyline decoder (1e5 precision — the app's route standard).
const decodePolyline = (encoded) => {
  if (!encoded || typeof encoded !== 'string') return [];
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  try {
    while (index < encoded.length) {
      let result = 0;
      let shift = 0;
      let byte;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const dlat = result & 1 ? ~(result >> 1) : result >> 1;
      lat += dlat;
      result = 0;
      shift = 0;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const dlng = result & 1 ? ~(result >> 1) : result >> 1;
      lng += dlng;
      points.push([lat / 1e5, lng / 1e5]);
    }
  } catch (_) {
    return [];
  }
  return points.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
};

const readWaypoints = (delivery) =>
  Array.isArray(delivery?.deviation_waypoints)
    ? delivery.deviation_waypoints
        .filter((w) => Number.isFinite(Number(w?.lat)) && Number.isFinite(Number(w?.lng)))
        .map((w) => ({ lat: Number(w.lat), lng: Number(w.lng), timestamp: w.timestamp || null }))
    : [];

// Fits the map to the leg + its waypoints whenever they change.
function FitToData({ positions }) {
  const map = useMapEvents({});
  // The panel animates in, so the container often has no size at first paint —
  // Leaflet then keeps a 0x0 canvas and paints no tiles at all. Force a size
  // read on mount, after the open animation, and whenever the data settles.
  useEffect(() => {
    const settle = [80, 320, 700].map((ms) => setTimeout(() => {
      try { map.invalidateSize(); } catch (_) {}
    }, ms));
    return () => settle.forEach(clearTimeout);
  }, [map]);
  useEffect(() => {
    if (!positions.length) return;
    try {
      map.invalidateSize();
      map.fitBounds(positions, { padding: [24, 24], maxZoom: 16 });
    } catch (_) {}
  }, [positions.map((p) => p.join(',')).join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function MapClickCatcher({ active, onPick }) {
  useMapEvents({
    click(e) {
      if (!active) return;
      onPick({ lat: Number(e.latlng.lat.toFixed(6)), lng: Number(e.latlng.lng.toFixed(6)) });
    },
  });
  return null;
}

export default function StopPolylineDeviationMap({ delivery, onChanged }) {
  const [waypoints, setWaypoints] = useState(() => readWaypoints(delivery));
  const [encoded, setEncoded] = useState(delivery?.encoded_polyline || '');
  const [addMode, setAddMode] = useState(false);
  const [busy, setBusy] = useState(false);
  // HERE basemap key — same resolution as the other maps (settings override,
  // refreshed when settings change; tiles only render once a key exists).
  const [hereApiKey, setHereApiKey] = useState(null);
  const [tileKey, setTileKey] = useState(0);
  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const res = await getActiveHereApiKey({}).catch(() => null);
      if (mounted && res?.data?.apiKey) setHereApiKey(res.data.apiKey);
    };
    load();
    window.addEventListener('appSettingsUpdated', load);
    return () => { mounted = false; window.removeEventListener('appSettingsUpdated', load); };
  }, []);
  useEffect(() => { if (hereApiKey) setTileKey((k) => k + 1); }, [hereApiKey]);
  const tileLayerUrl = useMemo(() => {
    if (!hereApiKey) return null;
    let dark = false;
    try {
      dark = document.documentElement.classList.contains('dark-theme') ||
        (document.documentElement.classList.contains('auto-theme') &&
          window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (_) { dark = false; }
    return dark ? buildHereDarkTileUrl(hereApiKey) : buildHereLightTileUrl(hereApiKey);
  }, [hereApiKey]);
  const [selectedIdx, setSelectedIdx] = useState(null);
  const [showRaw, setShowRaw] = useState(false);

  // Panel switches stop → adopt that stop's data.
  useEffect(() => {
    setWaypoints(readWaypoints(delivery));
    setEncoded(delivery?.encoded_polyline || '');
    setAddMode(false);
    setSelectedIdx(null);
  }, [delivery?.id, delivery?.encoded_polyline]);

  const path = useMemo(() => decodePolyline(encoded), [encoded]);

  const allPositions = useMemo(() => {
    const pts = [...path, ...waypoints.map((w) => [w.lat, w.lng])];
    return pts.length ? pts : [[53.5461, -113.4938]];
  }, [path, waypoints]);

  const start = path[0] || null;
  const end = path[path.length - 1] || null;

  // Refresh this stop's stored data after a write / redraw.
  const refreshStop = useCallback(async () => {
    try {
      const fresh = (await base44.entities.Delivery.filter({ id: delivery.id }, '-updated_date', 1))?.[0];
      if (fresh) {
        setWaypoints(readWaypoints(fresh));
        setEncoded(fresh.encoded_polyline || '');
        onChanged?.(fresh);
      }
    } catch (err) {
      console.warn('[StopPolylineDeviationMap] refresh failed:', err?.message);
    }
  }, [delivery?.id, onChanged]);

  const redrawRoute = useCallback(async () => {
    const { performRouteOptimization } = await import('@/components/utils/routeOptimizationCoordinator');
    const mirror = Array.isArray(window.__appDeliveries) ? window.__appDeliveries : [];
    let deliveries = mirror.filter(
      (d) => d?.driver_id === delivery.driver_id && d?.delivery_date === delivery.delivery_date
    );
    if (deliveries.length === 0) {
      deliveries = (await base44.entities.Delivery.filter({
        driver_id: delivery.driver_id,
        delivery_date: delivery.delivery_date,
      })) || [];
    }
    return performRouteOptimization({
      driverId: delivery.driver_id,
      deliveryDate: delivery.delivery_date,
      deliveries,
      source: 'admin_polyline_deviation_edit',
      preserveExistingOrder: true,
      forceRegenerate: true,
      bypassDriverStatus: true,
    });
  }, [delivery?.id, delivery?.driver_id, delivery?.delivery_date]);

  const persist = useCallback(
    async (nextWaypoints, { redraw = true, label = 'Saved' } = {}) => {
      setBusy(true);
      try {
        const { updateDelivery } = await import('@/components/utils/entityMutations');
        await updateDelivery(delivery.id, { deviation_waypoints: nextWaypoints }, { skipSmartRefresh: true });
        setWaypoints(nextWaypoints);
        if (redraw) {
          const res = await redrawRoute();
          await refreshStop();
          if (res && res.success === false) toast.warning(`${label} — polyline redraw failed (${res.error || res.skipped || 'unknown'})`);
          else toast.success(`${label} — polyline redrawn`);
        } else {
          await refreshStop();
          toast.success(label);
        }
      } catch (err) {
        console.error('[StopPolylineDeviationMap] save failed:', err);
        toast.error(`Could not save: ${err?.message || 'unknown error'}`);
      } finally {
        setBusy(false);
        setAddMode(false);
        setSelectedIdx(null);
      }
    },
    [delivery?.id, redrawRoute, refreshStop]
  );

  const addPoint = (pt) => {
    if (waypoints.length >= MAX_WAYPOINTS) {
      toast.error(`This leg already has ${MAX_WAYPOINTS} deviation points — delete one first`);
      setAddMode(false);
      return;
    }
    const next = [...waypoints, { lat: pt.lat, lng: pt.lng, timestamp: new Date().toISOString() }];
    persist(next, { label: 'Deviation point added' });
  };

  const removePoint = (idx) => {
    const next = waypoints.filter((_, i) => i !== idx);
    persist(next, { label: 'Deviation point deleted' });
  };

  return (
    <div className="rounded-xl border bg-surface border-surface p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs font-semibold flex items-center gap-1.5 text-body-2">
          <MapIcon className="w-3.5 h-3.5" />
          Polyline &amp; Deviation Points
          <Badge className="text-[9px] bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/40">
            App Owner Only
          </Badge>
        </p>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px] gap-1"
            onClick={() => setShowRaw((v) => !v)}
            title="Show the raw encoded polyline"
          >
            <Code2 className="w-3 h-3" /> Encoded
          </Button>
          <Button
            size="sm"
            variant={addMode ? 'default' : 'outline'}
            className="h-7 px-2 text-[11px] gap-1"
            disabled={busy || waypoints.length >= MAX_WAYPOINTS}
            onClick={() => setAddMode((v) => !v)}
            title="Arm, then click the map to add a deviation point"
          >
            <Plus className="w-3 h-3" /> {addMode ? 'Click map…' : 'Add point'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px] gap-1"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const res = await redrawRoute();
                await refreshStop();
                if (res && res.success === false) toast.warning(`Redraw failed (${res.error || res.skipped || 'unknown'})`);
                else toast.success('Polyline redrawn');
              } catch (err) {
                toast.error(`Redraw failed: ${err?.message || 'unknown'}`);
              } finally {
                setBusy(false);
              }
            }}
            title="Regenerate this route's polylines from the current deviation data"
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Redraw
          </Button>
        </div>
      </div>

      <div className="relative rounded-lg overflow-hidden border border-surface" style={{ height: 240 }}>
        <MapContainer
          center={allPositions[0]}
          zoom={14}
          style={{ height: '100%', width: '100%' }}
          scrollWheelZoom
          dragging
          doubleClickZoom
        >
          {tileLayerUrl && (
            <CachedTileLayer
              key={`stop-dev-${tileKey}`}
              url={tileLayerUrl}
              attribution='&copy; <a href="https://www.here.com/">HERE</a>'
              tileSize={512}
              zoomOffset={-1}
              keepBuffer={0}
            />
          )}
          <FitToData positions={allPositions} />
          <MapClickCatcher active={addMode} onPick={addPoint} />

          {path.length > 1 && (
            <Polyline positions={path} pathOptions={{ color: '#3b82f6', weight: 5, opacity: 0.9 }} />
          )}
          {start && (
            <CircleMarker center={start} radius={6} pathOptions={{ color: '#fff', weight: 2, fillColor: '#22c55e', fillOpacity: 1 }}>
              <Tooltip>Leg start</Tooltip>
            </CircleMarker>
          )}
          {end && (
            <CircleMarker center={end} radius={6} pathOptions={{ color: '#fff', weight: 2, fillColor: '#ef4444', fillOpacity: 1 }}>
              <Tooltip>Stop</Tooltip>
            </CircleMarker>
          )}
          {waypoints.map((w, i) => (
            <CircleMarker
              key={`${w.lat},${w.lng},${i}`}
              center={[w.lat, w.lng]}
              radius={selectedIdx === i ? 10 : 7}
              pathOptions={{
                color: '#fff',
                weight: 2,
                fillColor: selectedIdx === i ? '#f97316' : '#fb923c',
                fillOpacity: 1,
              }}
              eventHandlers={{ click: () => setSelectedIdx(i) }}
            >
              <Tooltip>
                Deviation {i + 1}
                {w.timestamp ? ` · ${new Date(w.timestamp).toLocaleString()}` : ''}
              </Tooltip>
            </CircleMarker>
          ))}
        </MapContainer>
        {addMode && (
          <div className="absolute top-2 left-2 z-[500] rounded bg-orange-500 px-2 py-1 text-[11px] font-medium text-white shadow">
            Click the map to drop a deviation point
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 text-[11px] text-soft flex-wrap">
        <span className="inline-flex items-center gap-1"><Crosshair className="w-3 h-3" /> {path.length} polyline points</span>
        <span>·</span>
        <span>{waypoints.length}/{MAX_WAYPOINTS} deviation points</span>
        {!encoded && <span className="text-amber-600 dark:text-amber-400">· no stored polyline for this leg</span>}
      </div>

      {showRaw && (
        <div className="rounded border border-surface bg-slate-950/90 p-2 max-h-24 overflow-auto">
          <p className="text-[10px] font-mono break-all text-slate-300">{encoded || '—'}</p>
        </div>
      )}

      {waypoints.length > 0 && (
        <div className="space-y-1">
          {waypoints.map((w, i) => (
            <div
              key={`${w.lat},${w.lng},${i}`}
              className={`flex items-center justify-between gap-2 rounded px-2 py-1 text-[11px] ${selectedIdx === i ? 'ring-1 ring-orange-400' : ''}`}
              style={{ background: 'var(--bg-slate-50)' }}
              onClick={() => setSelectedIdx(i)}
            >
              <span className="font-mono text-body-2">
                {i + 1}. {w.lat.toFixed(5)}, {w.lng.toFixed(5)}
              </span>
              <span className="text-soft shrink-0">
                {w.timestamp ? new Date(w.timestamp).toLocaleTimeString() : '—'}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0 text-red-500 hover:text-red-600"
                disabled={busy}
                onClick={(e) => { e.stopPropagation(); removePoint(i); }}
                title="Delete this deviation point and redraw"
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
