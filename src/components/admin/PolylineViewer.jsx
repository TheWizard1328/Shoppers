import React, { useState, useEffect, useMemo, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { MapContainer, Polyline, Marker, Popup, useMap, useMapEvents } from 'react-leaflet';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, MapPin, Trash2, RefreshCw, Filter, ChevronDown, Layers, Save, Eraser, Undo2 } from 'lucide-react';
import { format } from 'date-fns';
import { getDriverDisplayName } from '../utils/driverUtils';
import { getActiveHereApiKey } from '@/functions/getActiveHereApiKey';
import { saveCrumbPolylineToDelivery } from '@/functions/saveCrumbPolylineToDelivery';
import { isAppOwner } from '../utils/userRoles';
import { useUser } from '../utils/UserContext';
import { CachedTileLayer } from '../utils/hereTileCache';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { toast } from 'sonner';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

// Fix default marker icon
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

// ── Haversine distance calculator ────────────────────────────────────────────
const haversineKm = (lat1, lon1, lat2, lon2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const calcPolylineDistanceKm = (points) => {
  if (!points || points.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineKm(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
  }
  return total;
};

// ── Polyline encoder (Google encoding) ──────────────────────────────────────
const encodePolyline = (points) => {
  const encodeValue = (val) => {
    let v = Math.round(val * 1e5);
    v = v < 0 ? ~(v << 1) : v << 1;
    let result = '';
    while (v >= 0x20) { result += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    result += String.fromCharCode(v + 63);
    return result;
  };
  let prevLat = 0, prevLng = 0, encoded = '';
  for (const [lat, lng] of points) {
    encoded += encodeValue(lat - prevLat) + encodeValue(lng - prevLng);
    prevLat = lat; prevLng = lng;
  }
  return encoded;
};

// ── Polyline decoder (Google encoding) ──────────────────────────────────────
const decodePolyline = (encoded) => {
  if (!encoded) return [];
  const poly = [];
  let index = 0, len = encoded.length, lat = 0, lng = 0;
  while (index < len) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += ((result & 1) ? ~(result >> 1) : (result >> 1));
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += ((result & 1) ? ~(result >> 1) : (result >> 1));
    poly.push([lat / 1e5, lng / 1e5]);
  }
  return poly;
};

// ── HERE tile layer helpers ─────────────────────────────────────────────────
// Tile caching handled by <CachedTileLayer> from hereTileCache.js
const buildHereLightTileUrl = (k) => `https://maps.hereapi.com/v3/base/mc/{z}/{x}/{y}/png?style=explore.day&size=512&apiKey=${k}`;
const buildHereDarkTileUrl  = (k) => `https://maps.hereapi.com/v3/base/mc/{z}/{x}/{y}/png?style=explore.night&size=512&apiKey=${k}`;

// ── Marker icons ────────────────────────────────────────────────────────────
const createNumberedIcon = (color, label) => L.divIcon({
  className: '',
  html: `<div style="width:28px;height:28px;border-radius:9999px;background:${color};border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.28);display:flex;align-items:center;justify-content:center;color:white;font-size:11px;font-weight:700">${label}</div>`,
  iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -14]
});
const getMarkerIcon = (color, label) => createNumberedIcon(color, label ?? '');

// ── Map auto-fit ────────────────────────────────────────────────────────────
// Only fits bounds when the set of selected/focused item IDs changes — not on every point edit.
const MapUpdater = ({ allPoints, fitKey }) => {
  const map = useMap();
  useEffect(() => {
    const valid = (allPoints || []).filter(p => Array.isArray(p) && p.length === 2 && isFinite(p[0]) && isFinite(p[1]));
    if (valid.length > 0) map.fitBounds(L.latLngBounds(valid), { padding: [50, 50] });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]); // intentionally only re-fit when selection changes, not on point edits
  return null;
};

// ── Point-to-segment geometry helper ────────────────────────────────────────
// Returns the index AFTER which the new point should be inserted (0-based)
const findClosestSegmentIndex = (points, lat, lng) => {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, ay] = [points[i][0], points[i][1]];
    const [bx, by] = [points[i + 1][0], points[i + 1][1]];
    const [px, py] = [lat, lng];
    const abx = bx - ax, aby = by - ay;
    const len2 = abx * abx + aby * aby;
    let t = len2 > 0 ? ((px - ax) * abx + (py - ay) * aby) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * abx, cy = ay + t * aby;
    const dx = px - cx, dy = py - cy;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) { bestDist = dist; bestIdx = i; }
  }
  return bestIdx;
};

// ── Map click handler for adding points ─────────────────────────────────────
const MapClickHandler = ({ isActive, onAddPoint }) => {
  useMapEvents({
    click: (e) => {
      if (!isActive) return;
      onAddPoint(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
};

// ── View mode tab labels ────────────────────────────────────────────────────
const VIEW_MODES = [
  { id: 'polylines',   label: 'Delivery Polylines' },
  { id: 'breadcrumbs', label: 'GPS Breadcrumbs' },
  { id: 'combined',    label: 'Combined Overlay' },
];

// ═══════════════════════════════════════════════════════════════════════════
export default function PolylineViewer({ users = [] }) {
  const { currentUser } = useUser();
  const [viewMode, setViewMode]         = useState('polylines');
  const [dataSource, setDataSource]     = useState('online');
  const [isLoading, setIsLoading]       = useState(true);

  // raw data
  const [deliveries, setDeliveries]     = useState([]);   // for polylines
  const [breadcrumbs, setBreadcrumbs]   = useState([]);   // DeliveryBreadcrumbs entity
  const [allAppUsers, setAllAppUsers]   = useState([]);   // all AppUsers incl. inactive

  // selection / map
  const [selectedIds, setSelectedIds]   = useState(new Set());
  const [focusedItem, setFocusedItem]   = useState(null); // single-click focus

  // filters
  const [driverFilter, setDriverFilter] = useState('all');
  const [dateFrom, setDateFrom]         = useState('');
  const [dateTo, setDateTo]             = useState('');

  // HERE api key
  const [hereApiKey, setHereApiKey]     = useState(null);
  const [tileKey, setTileKey]           = useState(0);

  // ops
  const [isDeleting, setIsDeleting]     = useState(false);
  const [opProgress, setOpProgress]     = useState({ total: 0, processed: 0, label: '' });

  // mobile sheet
  const [sheetOpen, setSheetOpen]       = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(40);

  // ── Crumb cleaning state ──────────────────────────────────────────────────
  const [isCleaningMode, setIsCleaningMode]       = useState(false);
  const [cleanedPoints, setCleanedPoints]         = useState([]); // current editable point list
  const [undoStack, setUndoStack]                 = useState([]); // up to 5 previous states
  const [isSavingCrumb, setIsSavingCrumb]         = useState(false);
  const draggingRef = useRef(false); // true while a marker drag is in progress

  // Track the item currently being cleaned so we can auto-save on focus change
  const pendingCleanRef = useRef(null); // { item, cleanedPoints }
  const cleanedPointsRef = useRef([]);
  useEffect(() => { cleanedPointsRef.current = cleanedPoints; }, [cleanedPoints]);

  const listRef = useRef(null);

  // ── Mobile detection ──────────────────────────────────────────────────────
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const h = () => setIsMobile(mq.matches);
    h();
    mq.addEventListener ? mq.addEventListener('change', h) : mq.addListener(h);
    return () => mq.removeEventListener ? mq.removeEventListener('change', h) : mq.removeListener(h);
  }, []);

  // ── HERE API key ──────────────────────────────────────────────────────────
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

  useEffect(() => { if (hereApiKey) setTileKey(k => k + 1); }, [hereApiKey]);

  const tileLayerUrl = useMemo(() => {
    if (!hereApiKey) return null;
    const dark = document.documentElement.classList.contains('dark-theme') ||
      (document.documentElement.classList.contains('auto-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
    return dark ? buildHereDarkTileUrl(hereApiKey) : buildHereLightTileUrl(hereApiKey);
  }, [hereApiKey]);

  // ── Data loading ──────────────────────────────────────────────────────────
  const loadData = async () => {
    setIsLoading(true);
    setSelectedIds(new Set());
    setFocusedItem(null);
    try {
      if (dataSource === 'online') {
        // Always load both so combined overlay works without re-fetching
        const [dels, crumbs] = await Promise.all([
          base44.entities.Delivery.list('-delivery_date', 500),
          base44.entities.DeliveryBreadcrumbs.list('-delivery_date', 500),
        ]);
        setDeliveries(dels || []);
        setBreadcrumbs(crumbs || []);
      } else {
        const { offlineDB } = await import('../utils/offlineDatabase');
        const [dels, crumbs] = await Promise.all([
          offlineDB.getAll(offlineDB.STORES.DELIVERIES),
          offlineDB.getAll(offlineDB.STORES.DELIVERY_BREADCRUMBS).catch(() => []),
        ]);
        setDeliveries(dels || []);
        setBreadcrumbs(crumbs || []);
      }
    } catch (e) {
      console.error('[PolylineViewer] load error', e);
      setDeliveries([]);
      setBreadcrumbs([]);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { loadData(); }, [dataSource]);

  // ── Load all AppUsers (incl. inactive) for name resolution ────────────────
  useEffect(() => {
    base44.entities.AppUser.list().then(res => setAllAppUsers(res || [])).catch(() => {});
  }, []);

  // ── Driver helper ─────────────────────────────────────────────────────────
  const getDriverName = (id) => {
    if (!id) return 'Unknown';
    // Check passed users prop first, then fall back to allAppUsers (includes inactive)
    const u = users.find(u => u?.id === id || u?.user_id === id)
           || allAppUsers.find(u => u?.user_id === id || u?.id === id);
    return u ? (u.user_name || u.full_name || getDriverDisplayName(u)) : id.substring(0, 8) + '…';
  };

  // ── Filtered lists ────────────────────────────────────────────────────────
  const sortItems = (items) => {
    return [...items].sort((a, b) => {
      const nameA = getDriverName(a.driver_id);
      const nameB = getDriverName(b.driver_id);
      if (nameA !== nameB) return nameA.localeCompare(nameB);
      const dateCompare = (b.delivery_date || '').localeCompare(a.delivery_date || '');
      if (dateCompare !== 0) return dateCompare;
      return (a.stop_order ?? 0) - (b.stop_order ?? 0);
    });
  };

  const today = new Date().toISOString().split('T')[0];

  const matchesDateRange = (itemDate) => {
    if (!dateFrom && !dateTo) return true;
    if (dateFrom && !dateTo) return itemDate >= dateFrom && itemDate <= today;
    if (!dateFrom && dateTo) return itemDate <= dateTo;
    return itemDate >= dateFrom && itemDate <= dateTo;
  };

  const filteredPolylines = useMemo(() => {
    return sortItems(deliveries
      .filter(d => d?.encoded_polyline && d.encoded_polyline.length > 0)
      .filter(d => driverFilter === 'all' || d.driver_id === driverFilter)
      .filter(d => !d.delivery_date || matchesDateRange(d.delivery_date))
    );
  }, [deliveries, driverFilter, dateFrom, dateTo, users]);

  const filteredBreadcrumbs = useMemo(() => {
    return sortItems(breadcrumbs
      .filter(b => b?.encoded_polyline && b.encoded_polyline.length > 0)
      .filter(b => driverFilter === 'all' || b.driver_id === driverFilter)
      .filter(b => !b.delivery_date || matchesDateRange(b.delivery_date))
    );
  }, [breadcrumbs, driverFilter, dateFrom, dateTo, users]);

  // For combined view, use both
  const activeItems = viewMode === 'polylines' ? filteredPolylines
    : viewMode === 'breadcrumbs' ? filteredBreadcrumbs
    : sortItems([...filteredPolylines, ...filteredBreadcrumbs]);

  const availableDrivers = useMemo(() => {
    const ids = [...new Set(activeItems.map(i => i.driver_id).filter(Boolean))];
    return ids
      .map(id => {
        const u = users.find(u => u?.id === id);
        return { id, name: getDriverName(id), sort_order: u?.sort_order ?? Infinity };
      })
      .sort((a, b) => a.sort_order - b.sort_order);
  }, [activeItems, users]);

  // Reset lazy load on filter change
  useEffect(() => { setVisibleCount(40); }, [viewMode, filteredPolylines.length, filteredBreadcrumbs.length, dateFrom, dateTo]);

  // ── Selection helpers ─────────────────────────────────────────────────────
  const isAllSelected  = activeItems.length > 0 && selectedIds.size === activeItems.length;
  const isSomeSelected = selectedIds.size > 0 && selectedIds.size < activeItems.length;

  const handleSelectAll = (checked) => {
    setSelectedIds(checked ? new Set(activeItems.map(i => i.id)) : new Set());
  };

  const handleSelectFewCrumbs = (checked) => {
    if (!checked) {
      // Deselect only the few-crumbs items
      const fewCrumbIds = new Set(
        activeItems.filter(i => breadcrumbs.some(b => b.id === i.id) && (i.point_count ?? 0) < 5).map(i => i.id)
      );
      setSelectedIds(prev => new Set([...prev].filter(id => !fewCrumbIds.has(id))));
    } else {
      const fewCrumbIds = activeItems
        .filter(i => breadcrumbs.some(b => b.id === i.id) && (i.point_count ?? 0) < 5)
        .map(i => i.id);
      setSelectedIds(prev => new Set([...prev, ...fewCrumbIds]));
    }
  };

  const fewCrumbItems = activeItems.filter(i => breadcrumbs.some(b => b.id === i.id) && (i.point_count ?? 0) < 5);
  const allFewCrumbsSelected = fewCrumbItems.length > 0 && fewCrumbItems.every(i => selectedIds.has(i.id));
  const handleSelect = (id, checked) => {
    setSelectedIds(prev => {
      const s = new Set(prev);
      checked ? s.add(id) : s.delete(id);
      return s;
    });
  };

  // ── Map segments to render ────────────────────────────────────────────────
  // If items are selected → show selected; else if focused → show focused; else nothing
  const COLORS = ['#2563eb', '#7c3aed', '#ea580c', '#0f766e', '#b91c1c', '#0369a1', '#15803d'];

  const mapSegments = useMemo(() => {
    const chosen = selectedIds.size > 0
      ? activeItems.filter(i => selectedIds.has(i.id))
      : focusedItem ? [focusedItem] : [];

    return chosen.map((item, idx) => {
      const isBreadcrumb = breadcrumbs.some(b => b.id === item.id);
      const isDeliveryPoly = deliveries.some(d => d.id === item.id);
      const coords = decodePolyline(item.encoded_polyline);
      return {
        id: item.id,
        color: isBreadcrumb ? '#f59e0b' : COLORS[idx % COLORS.length],
        coords,
        item,
        isBreadcrumb,
        isDeliveryPoly,
      };
    }).filter(s => s.coords.length > 0);
  }, [selectedIds, focusedItem, activeItems, breadcrumbs, deliveries]);

  // Only refit map when the focused item changes, not when points are erased during cleaning
  const allMapPoints = useMemo(() => mapSegments.flatMap(s =>
    isCleaningMode && focusedItem?.id === s.item.id && s.isBreadcrumb ? cleanedPoints : s.coords
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [mapSegments, isCleaningMode, focusedItem]); // intentionally omit cleanedPoints

  // ── Delete selected ───────────────────────────────────────────────────────
  const handleDeleteSelected = async () => {
    if (!selectedIds.size) return;
    if (!window.confirm(`Delete ${selectedIds.size} selected record(s)? This cannot be undone.`)) return;
    setIsDeleting(true);
    const ids = Array.from(selectedIds);
    setOpProgress({ total: ids.length, processed: 0, label: 'Deleting…' });

    // Separate breadcrumbs from delivery polylines upfront
    const bcIds = ids.filter(id => breadcrumbs.some(b => b.id === id));
    const deliveryIds = ids.filter(id => !breadcrumbs.some(b => b.id === id));

    const { offlineDB } = await import('../utils/offlineDatabase').catch(() => ({ offlineDB: null }));

    // Parallel batch processing: fire CHUNK requests concurrently, then move to next batch.
    const CHUNK = 20;
    const PAUSE = 300; // ms between batches

    let processed = 0;

    const isOffline = dataSource === 'offline';

    const deleteBcOnline = (id) =>
      !isOffline ? base44.entities.DeliveryBreadcrumbs.delete(id).catch(() => {}) : Promise.resolve();
    const deleteBcOffline = (id) =>
      offlineDB ? offlineDB.deleteRecord(offlineDB.STORES.DELIVERY_BREADCRUMBS, id) : Promise.resolve();

    // Process breadcrumb deletions — full parallel within each batch
    for (let i = 0; i < bcIds.length; i += CHUNK) {
      const chunk = bcIds.slice(i, i + CHUNK);
      await Promise.all(chunk.map(id => Promise.all([deleteBcOnline(id), deleteBcOffline(id)])));
      processed += chunk.length;
      setOpProgress(p => ({ ...p, processed }));
      if (i + CHUNK < bcIds.length) await new Promise(r => setTimeout(r, PAUSE));
    }

    const clearDeliveryOnline = (id) =>
      !isOffline ? base44.entities.Delivery.update(id, { encoded_polyline: null }).catch(() => {}) : Promise.resolve();
    const clearDeliveryOffline = async (id) => {
      if (!offlineDB) return;
      const existing = await offlineDB.getById(offlineDB.STORES.DELIVERIES, id).catch(() => null);
      if (existing) await offlineDB.save(offlineDB.STORES.DELIVERIES, { ...existing, encoded_polyline: null });
    };

    // Process delivery polyline clears — full parallel within each batch
    for (let i = 0; i < deliveryIds.length; i += CHUNK) {
      const chunk = deliveryIds.slice(i, i + CHUNK);
      await Promise.all(chunk.map(id => Promise.all([clearDeliveryOnline(id), clearDeliveryOffline(id)])));
      processed += chunk.length;
      setOpProgress(p => ({ ...p, processed }));
      if (i + CHUNK < deliveryIds.length) await new Promise(r => setTimeout(r, PAUSE));
    }

    setIsDeleting(false);
    setOpProgress({ total: 0, processed: 0, label: '' });
    setSelectedIds(new Set());
    setFocusedItem(null);
    // Brief pause before reload so the server has time to commit
    await new Promise(r => setTimeout(r, 800));
    await loadData();
  };

  // ── List scroll lazy loading ──────────────────────────────────────────────
  const handleListScroll = (e) => {
    const el = e?.currentTarget;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 100) {
      setVisibleCount(c => Math.min(c + 40, activeItems.length));
    }
  };

  // ── Auto-save pending cleaned crumb (call before changing focused item) ──
  const autoSavePendingClean = async () => {
    const pending = pendingCleanRef.current;
    if (!pending) return;
    const points = cleanedPointsRef.current;
    pendingCleanRef.current = null;
    const newPoly = encodePolyline(points);
    if (newPoly === pending.item.encoded_polyline) return; // no change
    try {
      // Update both offline DB and online
      const { offlineDB } = await import('../utils/offlineDatabase').catch(() => ({ offlineDB: null }));
      const [res] = await Promise.all([
        saveCrumbPolylineToDelivery({
          driverId: pending.item.driver_id,
          deliveryDate: pending.item.delivery_date,
          stopOrder: pending.item.stop_order,
          cleanedEncodedPolyline: newPoly,
        }),
        offlineDB
          ? offlineDB.getById(offlineDB.STORES.DELIVERY_BREADCRUMBS, pending.item.id)
              .then(existing => existing
                ? offlineDB.save(offlineDB.STORES.DELIVERY_BREADCRUMBS, { ...existing, encoded_polyline: newPoly, point_count: points.length })
                : Promise.resolve()
              ).catch(() => {})
          : Promise.resolve(),
      ]);
      if (res?.data?.success) {
        toast.success(`Stop #${pending.item.stop_order} auto-saved.`);
        // Update local breadcrumbs state so the list reflects new point count
        setBreadcrumbs(prev => prev.map(b =>
          b.id === pending.item.id ? { ...b, encoded_polyline: newPoly, point_count: points.length } : b
        ));
      }
    } catch (e) {
      toast.error(`Auto-save failed: ${e.message}`);
    }
  };

  // ── Crumb cleaning handlers ───────────────────────────────────────────────
  const handleToggleCleaningMode = (item) => {
    if (isCleaningMode && focusedItem?.id === item.id) {
      // Turn off — discard pending tracking (user explicitly toggled off)
      pendingCleanRef.current = null;
      setIsCleaningMode(false);
      setCleanedPoints([]);
      setUndoStack([]);
    } else {
      const pts = decodePolyline(item.encoded_polyline);
      setCleanedPoints(pts);
      cleanedPointsRef.current = pts;
      setUndoStack([]);
      setIsCleaningMode(true);
      setFocusedItem(item);
      pendingCleanRef.current = { item };
    }
  };

  const handleRemovePoint = (idx) => {
    setUndoStack(prev => [...prev.slice(-4), cleanedPoints]); // keep max 5
    setCleanedPoints(prev => prev.filter((_, i) => i !== idx));
  };

  const handleMovePoint = (idx, newLat, newLng) => {
    setUndoStack(prev => [...prev.slice(-4), cleanedPoints]); // keep max 5
    setCleanedPoints(prev => prev.map((pt, i) => i === idx ? [newLat, newLng] : pt));
  };

  const handleAddPoint = (lat, lng) => {
    if (cleanedPoints.length < 2) return;
    const insertAfter = findClosestSegmentIndex(cleanedPoints, lat, lng);
    setUndoStack(prev => [...prev.slice(-4), cleanedPoints]);
    setCleanedPoints(prev => {
      const next = [...prev];
      next.splice(insertAfter + 1, 0, [lat, lng]);
      return next;
    });
  };

  const handleUndo = () => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    setCleanedPoints(prev);
    setUndoStack(s => s.slice(0, -1));
  };

  const handleSaveCrumbToDelivery = async (item) => {
    setIsSavingCrumb(true);
    const points = isCleaningMode && focusedItem?.id === item.id ? cleanedPoints : decodePolyline(item.encoded_polyline);
    const polyToSave = isCleaningMode && focusedItem?.id === item.id ? encodePolyline(cleanedPoints) : item.encoded_polyline;
    try {
      const { offlineDB } = await import('../utils/offlineDatabase').catch(() => ({ offlineDB: null }));
      const [res] = await Promise.all([
        saveCrumbPolylineToDelivery({
          driverId: item.driver_id,
          deliveryDate: item.delivery_date,
          stopOrder: item.stop_order,
          cleanedEncodedPolyline: polyToSave,
        }),
        offlineDB
          ? offlineDB.getById(offlineDB.STORES.DELIVERY_BREADCRUMBS, item.id)
              .then(existing => existing
                ? offlineDB.save(offlineDB.STORES.DELIVERY_BREADCRUMBS, { ...existing, encoded_polyline: polyToSave, point_count: points.length })
                : Promise.resolve()
              ).catch(() => {})
          : Promise.resolve(),
      ]);
      if (res?.data?.success) {
        toast.success(`Stop #${item.stop_order} saved to delivery route & breadcrumb.`);
        pendingCleanRef.current = null;
        const updatedItem = { ...item, encoded_polyline: polyToSave, point_count: points.length, saved_to_route: true };
        setBreadcrumbs(prev => prev.map(b =>
          b.id === item.id ? updatedItem : b
        ));
        // Update focusedItem so the map immediately re-renders with the saved polyline
        setFocusedItem(updatedItem);
        setIsCleaningMode(false);
        setCleanedPoints([]);
        setUndoStack([]);
      } else {
        toast.error(`Save failed: ${res?.data?.error || 'Unknown error'}`);
      }
    } catch (e) {
      toast.error(`Save failed: ${e.message}`);
    } finally {
      setIsSavingCrumb(false);
    }
  };

  // ── List item renderer ────────────────────────────────────────────────────
  const renderListItem = (item, inSheet = false) => {
    const isBreadcrumb = breadcrumbs.some(b => b.id === item.id);
    const isFocused = focusedItem?.id === item.id;
    const isSelected = selectedIds.has(item.id);
    return (
      <div
        key={item.id}
        className={`p-3 border-b transition-colors cursor-pointer ${
          isFocused ? 'bg-blue-50 border-l-4 border-l-blue-500' : 'hover:bg-slate-50'
        }`}
      >
        <div className="flex items-start gap-2">
          <Checkbox
            checked={isSelected}
            onCheckedChange={checked => handleSelect(item.id, checked)}
            onClick={e => e.stopPropagation()}
            className="mt-1 flex-shrink-0"
          />
          <div className="flex-1 min-w-0">
            <div
              onClick={async () => {
                if (!isFocused && isCleaningMode && pendingCleanRef.current) {
                  await autoSavePendingClean();
                  setIsCleaningMode(false);
                  setCleanedPoints([]);
                  setUndoStack([]);
                } else if (isFocused && isCleaningMode && pendingCleanRef.current) {
                  // Deselecting — auto-save then clear
                  await autoSavePendingClean();
                  setIsCleaningMode(false);
                  setCleanedPoints([]);
                  setUndoStack([]);
                } else if (!isFocused) {
                  setIsCleaningMode(false);
                  setCleanedPoints([]);
                  setUndoStack([]);
                }
                setFocusedItem(isFocused ? null : item);
                if (inSheet) setSheetOpen(false);
              }}
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="font-medium text-sm truncate">{getDriverName(item.driver_id)}</span>
                <Badge variant={isBreadcrumb ? 'secondary' : 'outline'} className="text-xs flex-shrink-0 ml-auto">
                  {isBreadcrumb ? '🛤 BC' : '🗺 Poly'}
                </Badge>
                {isBreadcrumb && item.saved_to_route && (
                  <Badge className="text-xs flex-shrink-0 bg-green-100 text-green-700 border-0">✓ Saved</Badge>
                )}
              </div>
              <div className="text-xs text-slate-600 space-y-0.5">
                <div className="flex items-center justify-between gap-2">
                  <span>📅 {item.delivery_date ? format(new Date(item.delivery_date + 'T00:00:00'), 'MMM d, yyyy') : '—'}</span>
                  {isBreadcrumb && item.stop_order != null && <span className="text-slate-500">Stop #{item.stop_order} · {item.point_count || 0} pts</span>}
                  {!isBreadcrumb && item.stop_order != null && <span className="text-slate-500">Stop #{item.stop_order}</span>}
                </div>
                {!isBreadcrumb && (item.estimated_distance_km || item.estimated_duration_minutes) && (
                  <div className="flex items-center justify-between gap-2">
                    <span>🕒 {item.estimated_duration_minutes?.toFixed(0) || '?'} min</span>
                    <span className="text-slate-500">📏 {item.estimated_distance_km?.toFixed(2) || '?'} km</span>
                  </div>
                )}
                {isBreadcrumb && (() => {
                  const pts = decodePolyline(item.encoded_polyline);
                  const distKm = calcPolylineDistanceKm(pts);
                  const distStr = distKm >= 1 ? `${distKm.toFixed(2)} km` : `${(distKm * 1000).toFixed(0)} m`;
                  return (
                    <div className="flex items-center justify-between gap-1">
                      <span>{item.transport_mode ? `🚗 ${item.transport_mode}` : ''}</span>
                      <span className="text-slate-500">📏 {distStr}</span>
                      {isFocused && (
                        <div className="flex items-center gap-1 ml-1" onClick={e => e.stopPropagation()}>
                          {isCleaningMode && focusedItem?.id === item.id && (
                            <span className="text-xs text-orange-700 font-medium mr-1">
                              {cleanedPoints.length} pts
                            </span>
                          )}
                          {isCleaningMode && focusedItem?.id === item.id && undoStack.length > 0 && (
                            <button
                              title={`Undo last removal (${undoStack.length} steps)`}
                              onClick={e => { e.stopPropagation(); handleUndo(); }}
                              className="p-1 rounded hover:bg-slate-200 text-slate-600 transition-colors"
                            >
                              <Undo2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <button
                            title={isCleaningMode && focusedItem?.id === item.id ? 'Exit cleaning mode' : 'Clean crumb points'}
                            onClick={e => { e.stopPropagation(); handleToggleCleaningMode(item); }}
                            className={`p-1 rounded transition-colors ${isCleaningMode && focusedItem?.id === item.id ? 'bg-orange-200 text-orange-800' : 'hover:bg-orange-100 text-orange-600'}`}
                          >
                            <Eraser className="w-3.5 h-3.5" />
                          </button>
                          <button
                            title="Save crumb polyline to delivery"
                            onClick={e => { e.stopPropagation(); handleSaveCrumbToDelivery(item); }}
                            disabled={isSavingCrumb}
                            className="p-1 rounded hover:bg-green-100 text-green-700 disabled:opacity-50 transition-colors"
                          >
                            {isSavingCrumb ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // ── Controls bar (shared desktop + sheet) ─────────────────────────────────
  const renderControls = () => (
    <div className="space-y-3">
      {/* View mode */}
      <div className="flex gap-1 bg-slate-100 p-1 rounded-lg">
        {VIEW_MODES.map(m => (
          <Button
            key={m.id}
            variant={viewMode === m.id ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setViewMode(m.id)}
            className="flex-1 h-8 text-xs"
          >
            {m.id === 'combined' && <Layers className="w-3 h-3 mr-1" />}
            {m.label}
          </Button>
        ))}
      </div>
      {/* Data source */}
      <div className="flex gap-1 bg-slate-100 p-1 rounded-lg">
        <Button variant={dataSource === 'online' ? 'default' : 'ghost'} size="sm" onClick={() => setDataSource('online')} className="flex-1 h-8">Online</Button>
        <Button variant={dataSource === 'offline' ? 'default' : 'ghost'} size="sm" onClick={() => setDataSource('offline')} className="flex-1 h-8">Offline</Button>
      </div>
      {/* Driver filter */}
      <Select value={driverFilter} onValueChange={setDriverFilter}>
        <SelectTrigger className="w-full"><SelectValue placeholder="All Drivers" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Drivers</SelectItem>
          {availableDrivers.map(d => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
        </SelectContent>
      </Select>
      {/* Date range filter */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-slate-500 font-medium">From date</label>
        <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="w-full" />
        <label className="text-xs text-slate-500 font-medium">To date</label>
        <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="w-full" />
      </div>
      {(driverFilter !== 'all' || dateFrom || dateTo) && (
        <Button variant="outline" size="sm" className="w-full" onClick={() => { setDriverFilter('all'); setDateFrom(''); setDateTo(''); }}>Clear Filters</Button>
      )}
    </div>
  );

  // ═════════════════════════════════════════════════════════════════════════
  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="flex-shrink-0">
        <CardTitle className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <MapPin className="w-5 h-5" />
            <span>Route Viewer</span>
            <Badge variant="outline">{viewMode === 'combined' ? `${filteredPolylines.length}P + ${filteredBreadcrumbs.length}BC` : activeItems.length + ' records'}</Badge>
            {viewMode === 'combined' && <Badge className="bg-amber-100 text-amber-800 border-0">Combined Mode</Badge>}
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button variant="outline" size="sm" onClick={loadData} disabled={isLoading} className="gap-2">
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            {selectedIds.size > 0 && (
              <Button variant="destructive" size="sm" onClick={handleDeleteSelected} disabled={isDeleting} className="gap-2">
                <Trash2 className="w-4 h-4" />
                {isDeleting ? 'Deleting…' : `Delete (${selectedIds.size})`}
              </Button>
            )}
          </div>
        </CardTitle>
      </CardHeader>

      <CardContent className="flex-1 flex flex-col min-h-0 gap-3">
        {/* Progress */}
        {(isDeleting) && opProgress.total > 0 && (
          <div className="flex items-center gap-2 p-3 bg-slate-50 border rounded text-sm text-slate-700">
            <Loader2 className="w-4 h-4 animate-spin" />
            {opProgress.label} {opProgress.processed}/{opProgress.total}
          </div>
        )}

        {isLoading ? (
          <div className="flex-1 flex justify-center items-center">
            <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
            <span className="ml-3 text-slate-600">Loading route data…</span>
          </div>
        ) : (
          <div className="flex flex-col gap-3 flex-1 min-h-0">
            {/* Mobile controls */}
            <div className="flex gap-2 md:hidden">
              <Sheet open={controlsOpen} onOpenChange={setControlsOpen}>
                <SheetTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-2">
                    <Filter className="w-4 h-4" /> Controls
                  </Button>
                </SheetTrigger>
                <SheetContent side="bottom" className="h-[85vh] overflow-y-auto">
                  <SheetHeader><SheetTitle>Route Controls</SheetTitle></SheetHeader>
                  <div className="pt-4">{renderControls()}</div>
                </SheetContent>
              </Sheet>
              <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
                <SheetTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-2">
                    <ChevronDown className="w-4 h-4" /> Records ({activeItems.length})
                  </Button>
                </SheetTrigger>
                <SheetContent side="bottom" className="h-[80vh] p-0">
                  <SheetHeader className="p-4 pb-2 border-b">
                    <div className="flex items-center gap-3">
                      <Checkbox checked={isAllSelected} onCheckedChange={handleSelectAll} className={isSomeSelected ? 'data-[state=checked]:bg-slate-500' : ''} />
                      <SheetTitle>Records ({activeItems.length})</SheetTitle>
                    </div>
                  </SheetHeader>
                  <div className="h-[calc(80vh-73px)] overflow-y-auto">
                    {activeItems.slice(0, visibleCount).map(item => renderListItem(item, true))}
                  </div>
                </SheetContent>
              </Sheet>
            </div>

            {/* Desktop controls */}
            <div className="hidden md:flex gap-3 items-start flex-wrap">
              {/* View mode */}
              <div className="flex gap-1 bg-slate-100 p-1 rounded-lg">
                {VIEW_MODES.map(m => (
                  <Button key={m.id} variant={viewMode === m.id ? 'default' : 'ghost'} size="sm" onClick={() => setViewMode(m.id)} className="h-8 text-xs gap-1">
                    {m.id === 'combined' && <Layers className="w-3 h-3" />}
                    {m.label}
                  </Button>
                ))}
              </div>
              {/* Data source */}
              <div className="flex gap-1 bg-slate-100 p-1 rounded-lg">
                <Button variant={dataSource === 'online' ? 'default' : 'ghost'} size="sm" onClick={() => setDataSource('online')} className="h-8">Online</Button>
                <Button variant={dataSource === 'offline' ? 'default' : 'ghost'} size="sm" onClick={() => setDataSource('offline')} className="h-8">Offline</Button>
              </div>
              {/* Driver filter */}
              <Select value={driverFilter} onValueChange={setDriverFilter}>
                <SelectTrigger className="w-44"><SelectValue placeholder="All Drivers" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Drivers</SelectItem>
                  {availableDrivers.map(d => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                </SelectContent>
              </Select>
              {/* Date range filter */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-slate-500 whitespace-nowrap">From</span>
                <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="w-36" />
                <span className="text-xs text-slate-500 whitespace-nowrap">To</span>
                <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="w-36" />
              </div>
              {(driverFilter !== 'all' || dateFrom || dateTo) && (
                <Button variant="outline" size="sm" onClick={() => { setDriverFilter('all'); setDateFrom(''); setDateTo(''); }}>Clear Filters</Button>
              )}
            </div>

            {/* Main content: list + map */}
            <div className="flex flex-col md:flex-row gap-3 flex-1 min-h-0">
              {/* List — desktop only */}
              <div className="hidden md:flex md:w-72 xl:w-80 flex-col border rounded-lg overflow-hidden flex-shrink-0 min-h-0">
                <div className="bg-slate-100 px-3 py-2 border-b flex items-center gap-2 flex-shrink-0">
                  <Checkbox
                    checked={isAllSelected}
                    onCheckedChange={handleSelectAll}
                    className={isSomeSelected ? 'data-[state=checked]:bg-slate-500' : ''}
                  />
                  <span className="font-semibold text-sm text-slate-700 truncate">
                    {activeItems.length} record{activeItems.length !== 1 ? 's' : ''}
                    {viewMode === 'combined' && ` (${filteredPolylines.length}P + ${filteredBreadcrumbs.length}BC)`}
                  </span>
                  {isAppOwner(currentUser) && fewCrumbItems.length > 0 && (
                    <label className="ml-auto flex items-center gap-1.5 cursor-pointer flex-shrink-0">
                      <Checkbox
                        checked={allFewCrumbsSelected}
                        onCheckedChange={handleSelectFewCrumbs}
                        className="border-amber-400 data-[state=checked]:bg-amber-500 data-[state=checked]:border-amber-500"
                      />
                      <span className="text-xs text-amber-700 font-medium whitespace-nowrap">&lt; 5 crumbs ({fewCrumbItems.length})</span>
                    </label>
                  )}
                </div>
                <div className="flex-1 overflow-y-auto" onScroll={handleListScroll} ref={listRef}>
                  {activeItems.length === 0 ? (
                    <div className="p-6 text-center text-slate-400 text-sm">No records found</div>
                  ) : (
                    activeItems.slice(0, visibleCount).map(item => renderListItem(item))
                  )}
                  {visibleCount < activeItems.length && (
                    <div className="p-3 text-center text-xs text-slate-400">
                      Scroll for more ({activeItems.length - visibleCount} remaining)
                    </div>
                  )}
                </div>
              </div>

              {/* Map */}
              <div className="flex-1 border rounded-lg overflow-hidden min-h-[380px] md:min-h-0">
                {mapSegments.length > 0 ? (
                  <MapContainer
                    center={mapSegments[0]?.coords?.[0] || [53.5, -113.5]}
                    zoom={13}
                    style={{ height: '100%', width: '100%' }}
                    key={`map-${viewMode}-${mapSegments.map(s => s.id).join('-')}-${tileKey}`}
                  >
                    {tileLayerUrl && (
                      <CachedTileLayer
                        key={`here-${tileKey}`}
                        url={tileLayerUrl}
                        attribution='&copy; <a href="https://www.here.com/">HERE</a>'
                        tileSize={512}
                        zoomOffset={-1}
                        updateWhenZooming={false}
                        keepBuffer={1}
                      />
                    )}

                    {mapSegments.map((seg) => {
                      const isActiveCleaning = isCleaningMode && focusedItem?.id === seg.item.id && seg.isBreadcrumb;
                      const displayCoords = isActiveCleaning ? cleanedPoints : seg.coords;
                      const first = displayCoords[0];
                      const last  = displayCoords[displayCoords.length - 1];
                      // eslint-disable-next-line no-unused-vars
                      const MapSegment = ({ children, ...rest }) => children;
                      const destStop   = seg.item.stop_order ?? null;
                      const originStop = seg.isBreadcrumb && destStop != null ? destStop - 1 : destStop;
                      const startLabel = seg.isBreadcrumb ? (originStop != null ? originStop : '▶') : (destStop ?? '▶');
                      const endLabel   = seg.isBreadcrumb ? (destStop != null ? destStop : '■') : (destStop ?? '■');

                      // Draggable/clickable dot icon for cleaning mode
                      const makeDotIcon = (idx) => L.divIcon({
                        className: '',
                        html: `<div style="width:16px;height:16px;border-radius:9999px;background:#ef4444;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4);cursor:grab;display:flex;align-items:center;justify-content:center;color:white;font-size:8px;font-weight:700">${idx}</div>`,
                        iconSize: [16, 16], iconAnchor: [8, 8], popupAnchor: [0, -8]
                      });

                      return (
                        <MapSegment key={seg.id}>
                          <Polyline
                            positions={displayCoords}
                            color={isActiveCleaning ? '#ef4444' : seg.color}
                            weight={seg.isBreadcrumb ? 3 : 4}
                            opacity={seg.isBreadcrumb ? 0.75 : 0.85}
                            dashArray={seg.isBreadcrumb ? '6 4' : undefined}
                          />

                          {/* In cleaning mode: render all intermediate points as draggable/clickable red dots */}
                          {isActiveCleaning && cleanedPoints.slice(1, -1).map((pt, i) => (
                            <Marker
                              key={`clean-pt-${i}-${pt[0]}-${pt[1]}`}
                              position={pt}
                              icon={makeDotIcon(i + 1)}
                              zIndexOffset={2000}
                              draggable={true}
                              eventHandlers={{
                                dragstart: () => { draggingRef.current = true; },
                                dragend: (e) => {
                                  const { lat, lng } = e.target.getLatLng();
                                  handleMovePoint(i + 1, lat, lng);
                                  setTimeout(() => { draggingRef.current = false; }, 50);
                                },
                                click: () => { if (!draggingRef.current) handleRemovePoint(i + 1); },
                              }}
                            >
                              <Popup>
                                <strong>Point #{i + 1}</strong><br />
                                {pt[0].toFixed(6)}, {pt[1].toFixed(6)}<br />
                                <em style={{color:'#ef4444'}}>Click to remove · Drag to move</em><br />
                                <em style={{color:'#2563eb'}}>Click map to add a new point</em>
                              </Popup>
                            </Marker>
                          ))}

                          {first && (
                            <Marker
                              position={first}
                              icon={getMarkerIcon('#16a34a', startLabel)}
                              zIndexOffset={1400}
                              eventHandlers={isActiveCleaning && displayCoords.length > 2 ? { click: () => handleRemovePoint(0) } : {}}
                            >
                              <Popup>
                                <strong>{seg.isBreadcrumb ? 'Breadcrumb Start' : 'Route Start'}</strong><br />
                                Driver: {getDriverName(seg.item.driver_id)}<br />
                                {seg.isBreadcrumb
                                  ? <>Origin Stop: #{originStop}<br />Dest Stop: #{destStop}<br /></>
                                  : <>Stop: #{destStop}<br /></>
                                }
                                {seg.isBreadcrumb && <>Points: {isActiveCleaning ? cleanedPoints.length : seg.item.point_count}<br /></>}
                                {first[0].toFixed(6)}, {first[1].toFixed(6)}<br />
                                {isActiveCleaning && displayCoords.length > 2 && <em style={{color:'#ef4444'}}>Click to remove (next point becomes origin)</em>}
                              </Popup>
                            </Marker>
                          )}
                          {last && last !== first && (
                            <Marker
                              position={last}
                              icon={getMarkerIcon(seg.isBreadcrumb ? '#f59e0b' : '#dc2626', endLabel)}
                              zIndexOffset={1100}
                              eventHandlers={isActiveCleaning && displayCoords.length > 2 ? { click: () => handleRemovePoint(displayCoords.length - 1) } : {}}
                            >
                              <Popup>
                                <strong>{seg.isBreadcrumb ? 'Breadcrumb End' : 'Route End'}</strong><br />
                                {seg.isBreadcrumb && <>Stop: #{destStop}<br /></>}
                                {last[0].toFixed(6)}, {last[1].toFixed(6)}<br />
                                {isActiveCleaning && displayCoords.length > 2 && <em style={{color:'#ef4444'}}>Click to remove (previous point becomes destination)</em>}
                              </Popup>
                            </Marker>
                          )}
                        </MapSegment>
                      );
                    })}

                    <MapClickHandler
                      isActive={isCleaningMode}
                      onAddPoint={handleAddPoint}
                    />
                    <MapUpdater
                      allPoints={allMapPoints}
                      fitKey={mapSegments.map(s => s.id).join('-') + (focusedItem?.id || '')}
                    />
                  </MapContainer>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center bg-slate-50 text-slate-400 gap-2">
                    <MapPin className="w-10 h-10 opacity-30" />
                    <p className="text-sm">
                      {activeItems.length === 0
                        ? 'No route data found. Try switching data source or adjusting filters.'
                        : 'Click a record in the list, or check multiple records to compare on the map.'}
                    </p>
                    {viewMode === 'combined' && (
                      <p className="text-xs text-slate-500">
                        Combined mode shows Delivery Polylines (solid) + GPS Breadcrumbs (dashed)
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Legend */}
            {viewMode === 'combined' && (
              <div className="hidden md:flex items-center gap-4 text-xs text-slate-500 px-1">
                <div className="flex items-center gap-1.5">
                  <div className="w-8 h-1 bg-blue-600 rounded" />
                  <span>Delivery Polyline (HERE API)</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-8 h-0.5 border-t-2 border-dashed border-amber-500" />
                  <span>GPS Breadcrumb (actual path)</span>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}