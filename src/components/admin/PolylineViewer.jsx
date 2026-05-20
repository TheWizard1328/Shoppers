import React, { useState, useEffect, useMemo, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { MapContainer, TileLayer, Polyline, Marker, Popup, useMap } from 'react-leaflet';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, MapPin, Trash2, RefreshCw, Filter, ChevronDown, Layers } from 'lucide-react';
import { format } from 'date-fns';
import { getDriverDisplayName } from '../utils/driverUtils';
import { getActiveHereApiKey } from '@/functions/getActiveHereApiKey';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

// Fix default marker icon
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

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
const IntegerZoomTileLayer = L.TileLayer.extend({
  _getZoomForUrl() { return Math.round(L.TileLayer.prototype._getZoomForUrl.call(this)); }
});
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
const MapUpdater = ({ allPoints }) => {
  const map = useMap();
  useEffect(() => {
    const valid = (allPoints || []).filter(p => Array.isArray(p) && p.length === 2 && isFinite(p[0]) && isFinite(p[1]));
    if (valid.length > 0) map.fitBounds(L.latLngBounds(valid), { padding: [50, 50] });
  }, [allPoints, map]);
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
  const [viewMode, setViewMode]         = useState('polylines');
  const [dataSource, setDataSource]     = useState('online');
  const [isLoading, setIsLoading]       = useState(true);

  // raw data
  const [deliveries, setDeliveries]     = useState([]);   // for polylines
  const [breadcrumbs, setBreadcrumbs]   = useState([]);   // DeliveryBreadcrumbs entity

  // selection / map
  const [selectedIds, setSelectedIds]   = useState(new Set());
  const [focusedItem, setFocusedItem]   = useState(null); // single-click focus

  // filters
  const [driverFilter, setDriverFilter] = useState('all');
  const [dateFilter, setDateFilter]     = useState('');

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

  // ── Driver helper ─────────────────────────────────────────────────────────
  const getDriverName = (id) => {
    const u = users.find(u => u?.id === id);
    return u ? getDriverDisplayName(u) : id?.substring(0, 8) + '…' || 'Unknown';
  };

  // ── Filtered lists ────────────────────────────────────────────────────────
  const filteredPolylines = useMemo(() => {
    return deliveries
      .filter(d => d?.encoded_polyline && d.encoded_polyline.length > 0)
      .filter(d => driverFilter === 'all' || d.driver_id === driverFilter)
      .filter(d => !dateFilter || d.delivery_date === dateFilter)
      .sort((a, b) => (b.delivery_date || '').localeCompare(a.delivery_date || ''));
  }, [deliveries, driverFilter, dateFilter]);

  const filteredBreadcrumbs = useMemo(() => {
    return breadcrumbs
      .filter(b => b?.encoded_polyline && b.encoded_polyline.length > 0)
      .filter(b => driverFilter === 'all' || b.driver_id === driverFilter)
      .filter(b => !dateFilter || b.delivery_date === dateFilter)
      .sort((a, b) => (b.delivery_date || '').localeCompare(a.delivery_date || ''));
  }, [breadcrumbs, driverFilter, dateFilter]);

  // For combined view, use both
  const activeItems = viewMode === 'polylines' ? filteredPolylines
    : viewMode === 'breadcrumbs' ? filteredBreadcrumbs
    : [...filteredPolylines, ...filteredBreadcrumbs];

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
  useEffect(() => { setVisibleCount(40); }, [viewMode, filteredPolylines.length, filteredBreadcrumbs.length]);

  // ── Selection helpers ─────────────────────────────────────────────────────
  const isAllSelected  = activeItems.length > 0 && selectedIds.size === activeItems.length;
  const isSomeSelected = selectedIds.size > 0 && selectedIds.size < activeItems.length;

  const handleSelectAll = (checked) => {
    setSelectedIds(checked ? new Set(activeItems.map(i => i.id)) : new Set());
  };
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
      const isPolyline = 'stop_order' in item && !('driver_id' in breadcrumbs.find(b => b.id === item.id) ?? {});
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

  const allMapPoints = useMemo(() => mapSegments.flatMap(s => s.coords), [mapSegments]);

  // ── Delete selected ───────────────────────────────────────────────────────
  const handleDeleteSelected = async () => {
    if (!selectedIds.size) return;
    if (!window.confirm(`Delete ${selectedIds.size} selected record(s)? This cannot be undone.`)) return;
    setIsDeleting(true);
    const ids = Array.from(selectedIds);
    setOpProgress({ total: ids.length, processed: 0, label: 'Deleting…' });
    const CHUNK = 25;
    const { offlineDB } = await import('../utils/offlineDatabase').catch(() => ({ offlineDB: null }));
    for (let i = 0; i < ids.length; i += CHUNK) {
      await Promise.all(ids.slice(i, i + CHUNK).map(async id => {
        // Is it a delivery polyline or a breadcrumb?
        const isBC = breadcrumbs.some(b => b.id === id);
        if (isBC) {
          try { await base44.entities.DeliveryBreadcrumbs.delete(id); } catch (_) {}
        } else {
          // Clear encoded_polyline on the delivery
          try { await base44.entities.Delivery.update(id, { encoded_polyline: null }); } catch (_) {}
        }
      }));
      setOpProgress(p => ({ ...p, processed: Math.min(i + CHUNK, ids.length) }));
      await new Promise(r => setTimeout(r, 100));
    }
    setIsDeleting(false);
    setOpProgress({ total: 0, processed: 0, label: '' });
    setSelectedIds(new Set());
    setFocusedItem(null);
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
          <div
            className="flex-1 min-w-0"
            onClick={() => {
              setFocusedItem(isFocused ? null : item);
              if (inSheet) setSheetOpen(false);
            }}
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="font-medium text-sm truncate">{getDriverName(item.driver_id)}</span>
              <Badge variant={isBreadcrumb ? 'secondary' : 'outline'} className="text-xs flex-shrink-0">
                {isBreadcrumb ? '🛤 BC' : '🗺 Poly'}
              </Badge>
            </div>
            <div className="text-xs text-slate-600 space-y-0.5">
              <div>📅 {item.delivery_date ? format(new Date(item.delivery_date + 'T00:00:00'), 'MMM d, yyyy') : '—'}</div>
              {isBreadcrumb && <div>📍 Stop #{item.stop_order} · {item.point_count || 0} pts</div>}
              {!isBreadcrumb && item.stop_order != null && <div>🔢 Stop #{item.stop_order}</div>}
              {!isBreadcrumb && (item.estimated_distance_km || item.estimated_duration_minutes) && (
                <div>🕒 {item.estimated_duration_minutes?.toFixed(0) || '?'} min · 📏 {item.estimated_distance_km?.toFixed(2) || '?'} km</div>
              )}
              {isBreadcrumb && item.transport_mode && <div>🚗 {item.transport_mode}</div>}
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
      {/* Date filter */}
      <Input type="date" value={dateFilter} onChange={e => setDateFilter(e.target.value)} className="w-full" />
      {(driverFilter !== 'all' || dateFilter) && (
        <Button variant="outline" size="sm" className="w-full" onClick={() => { setDriverFilter('all'); setDateFilter(''); }}>Clear Filters</Button>
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
          <>
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
              {/* Date filter */}
              <Input type="date" value={dateFilter} onChange={e => setDateFilter(e.target.value)} className="w-44" />
              {(driverFilter !== 'all' || dateFilter) && (
                <Button variant="outline" size="sm" onClick={() => { setDriverFilter('all'); setDateFilter(''); }}>Clear Filters</Button>
              )}
            </div>

            {/* Main content: list + map */}
            <div className="flex flex-col md:flex-row gap-3 flex-1 min-h-0">
              {/* List — desktop only */}
              <div className="hidden md:flex md:w-72 xl:w-80 flex-col border rounded-lg overflow-hidden flex-shrink-0">
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
                      <TileLayer
                        key={`here-${tileKey}-${tileLayerUrl}`}
                        ref={layer => {
                          if (layer && !(layer instanceof IntegerZoomTileLayer)) {
                            Object.setPrototypeOf(layer, IntegerZoomTileLayer.prototype);
                          }
                        }}
                        url={tileLayerUrl}
                        attribution='&copy; <a href="https://www.here.com/">HERE</a>'
                        tileSize={512}
                        zoomOffset={-1}
                        updateWhenZooming={false}
                        keepBuffer={2}
                      />
                    )}

                    {mapSegments.map((seg) => {
                      const first = seg.coords[0];
                      const last  = seg.coords[seg.coords.length - 1];
                      return (
                        <React.Fragment key={seg.id}>
                          <Polyline
                            positions={seg.coords}
                            color={seg.color}
                            weight={seg.isBreadcrumb ? 3 : 4}
                            opacity={seg.isBreadcrumb ? 0.75 : 0.85}
                            dashArray={seg.isBreadcrumb ? '6 4' : undefined}
                          />
                          {first && (
                            <Marker position={first} icon={getMarkerIcon('#16a34a', seg.item.stop_order ?? '▶')} zIndexOffset={1400}>
                              <Popup>
                                <strong>{seg.isBreadcrumb ? 'Breadcrumb Start' : 'Route Start'}</strong><br />
                                Driver: {getDriverName(seg.item.driver_id)}<br />
                                Stop: #{seg.item.stop_order}<br />
                                {seg.isBreadcrumb && <>Points: {seg.item.point_count}<br /></>}
                                {first[0].toFixed(6)}, {first[1].toFixed(6)}
                              </Popup>
                            </Marker>
                          )}
                          {last && last !== first && (
                            <Marker position={last} icon={getMarkerIcon(seg.isBreadcrumb ? '#f59e0b' : '#dc2626', seg.item.stop_order ?? '■')} zIndexOffset={1100}>
                              <Popup>
                                <strong>{seg.isBreadcrumb ? 'Breadcrumb End' : 'Route End'}</strong><br />
                                {last[0].toFixed(6)}, {last[1].toFixed(6)}
                              </Popup>
                            </Marker>
                          )}
                        </React.Fragment>
                      );
                    })}

                    <MapUpdater allPoints={allMapPoints} />
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
          </>
        )}
      </CardContent>
    </Card>
  );
}