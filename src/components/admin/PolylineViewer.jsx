import React, { useState, useEffect, useMemo, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { MapContainer, TileLayer, Polyline, Marker, Popup, useMap } from 'react-leaflet';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { queueEntityRequest } from '../utils/requestQueue';
import { Loader2, MapPin, Trash2, RefreshCw, Filter, ChevronDown } from 'lucide-react';
import { format } from 'date-fns';
import { getDriverDisplayName } from '../utils/driverUtils';
import { clearHereCacheForSegment } from '../utils/hereRouting';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
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

// Decode Google polyline string
const decodePolyline = (encoded) => {
  if (!encoded) return [];
  
  const poly = [];
  let index = 0, len = encoded.length;
  let lat = 0, lng = 0;

  while (index < len) {
    let b, shift = 0, result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lat += dlat;

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lng += dlng;

    poly.push([lat / 1e5, lng / 1e5]);
  }

  return poly;
};

const MapUpdater = ({ coordinates }) => {
  const map = useMap();
  
  useEffect(() => {
    if (coordinates && coordinates.length > 0) {
      const bounds = L.latLngBounds(coordinates);
      map.fitBounds(bounds, { padding: [50, 50] });
    }
  }, [coordinates, map]);
  
  return null;
};

const getEdmontonDateFromTimestamp = (timestamp) => {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' });
};

export default function PolylineViewer({ users = [] }) {
  const [polylines, setPolylines] = useState([]);
  const [breadcrumbs, setBreadcrumbs] = useState([]);
  const [viewMode, setViewMode] = useState('polylines');
  const [isLoading, setIsLoading] = useState(true);
  const [selectedPolyline, setSelectedPolyline] = useState(null);
  const [decodedCoordinates, setDecodedCoordinates] = useState([]);
  const [selectedPolylines, setSelectedPolylines] = useState(new Set());
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRecomputing, setIsRecomputing] = useState(false);
  const [opProgress, setOpProgress] = useState({ total: 0, processed: 0, label: '' });
  const [driverFilter, setDriverFilter] = useState('all');
  const [dateFilter, setDateFilter] = useState('');
  const [dataSource, setDataSource] = useState('online'); // 'online' | 'offline'
  const [isMobile, setIsMobile] = useState(false);
  const [showList, setShowList] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(30);
  const listContainerRef = React.useRef(null);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const handler = () => setIsMobile(mq.matches);
    setIsMobile(mq.matches);
    if (mq.addEventListener) mq.addEventListener('change', handler); else mq.addListener(handler);
    return () => { if (mq.removeEventListener) mq.removeEventListener('change', handler); else mq.removeListener(handler); };
  }, []);
  const handleListScroll = (e) => {
    const el = e?.currentTarget;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) {
      setVisibleCount((c) => Math.min(c + 30, (viewMode === 'polylines' ? filteredPolylines.length : filteredBreadcrumbs.length)));
    }
  };

  useEffect(() => {
    const fetchData = async () => {
      try {
        setIsLoading(true);
        if (viewMode === 'polylines') {
          if (dataSource === 'online') {
            const { offlineDB } = await import('../utils/offlineDatabase');
            const rows = await offlineDB.getAll(offlineDB.STORES.DRIVER_ROUTE_POLYLINES);
            const sorted = (rows || [])
              .filter((row) => typeof row?.encoded_polyline === 'string' && row.encoded_polyline.length > 0)
              .sort((a, b) => {
                const aTs = new Date(a.last_generated_at || a.updated_date || a.created_date || 0).getTime();
                const bTs = new Date(b.last_generated_at || b.updated_date || b.created_date || 0).getTime();
                return bTs - aTs;
              })
              .slice(0, 500);
            setPolylines(sorted);
          } else {
            const polylinesData = await queueEntityRequest(
              () => base44.entities.DriverRoutePolyline.list('-delivery_date', 250),
              'Routes: DriverRoutePolyline.list'
            );
            setPolylines(polylinesData || []);
          }
        } else {
          try {
            if (dataSource === 'online') {
              const breadcrumbsData = await queueEntityRequest(
                () => base44.entities.DeliveryBreadcrumbs.list('-delivery_date', 250),
                'Routes: DeliveryBreadcrumbs.list'
              );
              setBreadcrumbs(breadcrumbsData || []);
            } else {
              const { offlineDB } = await import('../utils/offlineDatabase');
              const pending = await offlineDB.getAll(offlineDB.STORES.PENDING_BREADCRUMBS);
              // CRITICAL: Filter out records that exist in online DB - only show truly offline-only records
              const onlineIds = new Set((breadcrumbs || []).map(b => b.id));
              const offlineOnly = (pending || []).filter(r => !onlineIds.has(`pending-${r.driver_id}`));
              const normalized = offlineOnly.map((record) => ({
                id: `pending-${record.driver_id}`,
                storage_key: record.driver_id,
                driver_id: record.driver_id,
                coordinates: Array.isArray(record.breadcrumbs) ? record.breadcrumbs.map((point) => [point[0], point[1]]) : [],
                point_count: Array.isArray(record.breadcrumbs) ? record.breadcrumbs.length : 0,
                created_date: record.timestamp ? new Date(record.timestamp).toISOString() : null,
                delivery_date: getEdmontonDateFromTimestamp(record.timestamp),
                is_temp_offline: true,
                is_offline_only: true,
              }));
              setBreadcrumbs(normalized);
            }
          } catch (breadcrumbError) {
            console.warn('⚠️ [PolylineViewer] Breadcrumb data not available:', breadcrumbError.message);
            setBreadcrumbs([]);
          }
        }
      } catch (error) {
        console.error('❌ [PolylineViewer] Error fetching data:', error);
        if (viewMode === 'polylines') setPolylines([]); else setBreadcrumbs([]);
      } finally {
        setIsLoading(false);
      }
    };
    fetchData();
  }, [viewMode, dataSource]);

  const handlePolylineClick = (polyline) => {
    setSelectedPolyline(polyline);
    const decoded = decodePolyline(polyline.encoded_polyline);
    setDecodedCoordinates(decoded);
  };

  const getDriverName = (driverId) => {
    const driver = users.find(u => u?.id === driverId);
    return driver ? getDriverDisplayName(driver) : driverId?.substring(0, 8) + '...' || 'Unknown';
  };

  const filteredPolylines = useMemo(() => {
    let filtered = polylines;

    if (driverFilter !== 'all') {
      filtered = filtered.filter(p => p.driver_id === driverFilter);
    }

    if (dateFilter) {
      filtered = filtered.filter(p => p.delivery_date === dateFilter);
    }

    filtered = filtered.filter(p => typeof p.encoded_polyline === 'string' && p.encoded_polyline.length > 0);

    const deduped = new Map();
    filtered.forEach((row) => {
      const key = [
        row.driver_id,
        row.delivery_date,
        Number(row.segment_origin_lat).toFixed(5),
        Number(row.segment_origin_lon).toFixed(5),
        Number(row.segment_dest_lat).toFixed(5),
        Number(row.segment_dest_lon).toFixed(5)
      ].join('|');
      const existing = deduped.get(key);
      const existingTs = existing ? new Date(existing.last_generated_at || existing.updated_date || existing.created_date || 0).getTime() : 0;
      const currentTs = new Date(row.last_generated_at || row.updated_date || row.created_date || 0).getTime();
      if (!existing || currentTs > existingTs) {
        deduped.set(key, row);
      }
    });

    return Array.from(deduped.values()).sort((a, b) => {
      const aTs = new Date(a.last_generated_at || a.updated_date || a.created_date || 0).getTime();
      const bTs = new Date(b.last_generated_at || b.updated_date || b.created_date || 0).getTime();
      return bTs - aTs;
    });
  }, [polylines, driverFilter, dateFilter]);

  const filteredBreadcrumbs = useMemo(() => {
    let filtered = breadcrumbs;

    if (driverFilter !== 'all') {
      filtered = filtered.filter(b => b.driver_id === driverFilter);
    }

    if (dateFilter) {
      filtered = filtered.filter(b => b.delivery_date === dateFilter);
    }

    return filtered;
  }, [breadcrumbs, driverFilter, dateFilter]);
  
  // Reset lazy-load window when data set changes
  useEffect(() => {
    setVisibleCount(30);
  }, [viewMode, filteredPolylines.length, filteredBreadcrumbs.length]);

  const availableDrivers = useMemo(() => {
    const dataSource = viewMode === 'polylines' ? polylines : breadcrumbs;
    const driverIds = [...new Set(dataSource.map(p => p.driver_id))];
    return driverIds.map(id => ({
      id,
      name: getDriverName(id)
    }));
  }, [polylines, breadcrumbs, users, viewMode]);

  const activeItems = viewMode === 'polylines' ? filteredPolylines : filteredBreadcrumbs;

  // Remove any cached polyline keys (memory resets on reload; we clear localStorage keys here)
  const clearLocalCachesForPolyline = (rec) => {
    try {
      if (
        rec && rec.segment_origin_lat != null && rec.segment_origin_lon != null &&
        rec.segment_dest_lat != null && rec.segment_dest_lon != null
      ) {
        clearHereCacheForSegment(
          { latitude: Number(rec.segment_origin_lat), longitude: Number(rec.segment_origin_lon) },
          { latitude: Number(rec.segment_dest_lat), longitude: Number(rec.segment_dest_lon) }
        );
      }
    } catch (_) {}
  };

   const handleSelectAll = (checked) => {
    if (checked) {
      setSelectedPolylines(new Set(activeItems.map(item => item.id)));
    } else {
      setSelectedPolylines(new Set());
    }
  };

  const handleSelectPolyline = (polylineId, checked) => {
    setSelectedPolylines(prev => {
      const newSet = new Set(prev);
      if (checked) {
        newSet.add(polylineId);
      } else {
        newSet.delete(polylineId);
      }
      return newSet;
    });
  };

  const handleDeleteSelected = async () => {
    if (selectedPolylines.size === 0) return;
    if (!window.confirm(`Delete ${selectedPolylines.size} selected ${viewMode === 'polylines' ? 'route' : 'breadcrumb'} record(s)?`)) return;

    try {
      setIsDeleting(true);
      const ids = Array.from(selectedPolylines);
      setOpProgress({ total: ids.length, processed: 0, label: 'Deleting selected…' });
      const CHUNK = 50;

      const { offlineDB } = await import('../utils/offlineDatabase');
      for (let i = 0; i < ids.length; i += CHUNK) {
        const batch = ids.slice(i, i + CHUNK);
        await Promise.all(batch.map(async (id) => {
          if (viewMode === 'polylines') {
            const rec = polylines.find(p => p.id === id);
            if (rec) clearLocalCachesForPolyline(rec);
            try { await base44.entities.DriverRoutePolyline.delete(id); } catch (_) {}
            try { await offlineDB.deleteRecord(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, id); } catch (_) {}
            return;
          }

          const rec = breadcrumbs.find(b => b.id === id);
          if (dataSource === 'offline' && rec?.storage_key) {
            try { await offlineDB.deleteRecord(offlineDB.STORES.PENDING_BREADCRUMBS, rec.storage_key); } catch (_) {}
          } else {
            try { await base44.entities.DeliveryBreadcrumbs.delete(id); } catch (_) {}
          }
        }));
        setOpProgress((p) => ({ ...p, processed: Math.min(i + CHUNK, ids.length) }));
        await new Promise(r => setTimeout(r, 100));
      }

      if (viewMode === 'polylines') {
        setPolylines(polylines.filter(p => !selectedPolylines.has(p.id)));
      } else {
        setBreadcrumbs(breadcrumbs.filter(b => !selectedPolylines.has(b.id)));
      }
      setSelectedPolylines(new Set());
      setSelectedPolyline(null);
      setDecodedCoordinates([]);
    } catch (error) {
      console.error('Error deleting route records:', error);
      alert('Failed to delete route records: ' + error.message);
    } finally {
      setIsDeleting(false);
      setOpProgress({ total: 0, processed: 0, label: '' });
    }
  };

  const handleDeleteAll = async () => {
    if (activeItems.length === 0) return;
    if (!window.confirm(`Delete all ${activeItems.length} filtered ${viewMode === 'polylines' ? 'route' : 'breadcrumb'} record(s)? This cannot be undone.`)) return;

    try {
      setIsDeleting(true);
      const ids = activeItems.map(item => item.id);
      setOpProgress({ total: ids.length, processed: 0, label: 'Deleting filtered…' });
      const CHUNK = 50;

      const { offlineDB } = await import('../utils/offlineDatabase');
      for (let i = 0; i < ids.length; i += CHUNK) {
        const batch = ids.slice(i, i + CHUNK);
        await Promise.all(batch.map(async (id) => {
          if (viewMode === 'polylines') {
            const rec = filteredPolylines.find(p => p.id === id) || polylines.find(p => p.id === id);
            if (rec) clearLocalCachesForPolyline(rec);
            try { await base44.entities.DriverRoutePolyline.delete(id); } catch (_) {}
            try { await offlineDB.deleteRecord(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, id); } catch (_) {}
            return;
          }

          const rec = filteredBreadcrumbs.find(b => b.id === id) || breadcrumbs.find(b => b.id === id);
          if (dataSource === 'offline' && rec?.storage_key) {
            try { await offlineDB.deleteRecord(offlineDB.STORES.PENDING_BREADCRUMBS, rec.storage_key); } catch (_) {}
          } else {
            try { await base44.entities.DeliveryBreadcrumbs.delete(id); } catch (_) {}
          }
        }));
        setOpProgress((p) => ({ ...p, processed: Math.min(i + CHUNK, ids.length) }));
        await new Promise(r => setTimeout(r, 100));
      }

      if (viewMode === 'polylines') {
        setPolylines(polylines.filter(p => !ids.includes(p.id)));
      } else {
        setBreadcrumbs(breadcrumbs.filter(b => !ids.includes(b.id)));
      }
      setSelectedPolylines(new Set());
      setSelectedPolyline(null);
      setDecodedCoordinates([]);
    } catch (error) {
      console.error('Error deleting route records:', error);
      alert('Failed to delete route records: ' + error.message);
    } finally {
      setIsDeleting(false);
      setOpProgress({ total: 0, processed: 0, label: '' });
    }
  };

  const isAllSelected = activeItems.length > 0 && selectedPolylines.size === activeItems.length;
  const isSomeSelected = selectedPolylines.size > 0 && selectedPolylines.size < activeItems.length;

  return (
    <Card className="h-full flex flex-col">
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MapPin className="w-5 h-5" />
            {viewMode === 'polylines' ? 'Google Polyline Data' : 'GPS Breadcrumbs'}
          </div>
          <div className="flex gap-2">
            {selectedPolylines.size > 0 && (
              <>
                {viewMode === 'polylines' && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      if (!window.confirm(`Recompute distance/time for ${selectedPolylines.size} selected polyline(s)?`)) return;
                      try {
                        setIsRecomputing(true);
                        const ids = Array.from(selectedPolylines);
                        setOpProgress({ total: ids.length, processed: 0, label: 'Recomputing…' });
                        for (let i = 0; i < ids.length; i++) {
                          const id = ids[i];
                          const pl = polylines.find(p => p.id === id);
                          if (!pl) continue;
                          try {
                            const res = await base44.functions.invoke('getHereDirections', {
                              origin: { lat: pl.segment_origin_lat, lng: pl.segment_origin_lon },
                              destination: { lat: pl.segment_dest_lat, lng: pl.segment_dest_lon }
                            });
                            const estKm = res?.data?.estimated_distance_km ?? null;
                            const estMin = res?.data?.estimated_duration_minutes ?? null;
                            if (estKm !== null && estMin !== null) {
                              await base44.entities.DriverRoutePolyline.update(pl.id, {
                                estimated_distance_km: estKm,
                                estimated_duration_minutes: estMin,
                                last_generated_at: new Date().toISOString(),
                              });
                              setPolylines(prev => prev.map(p => p.id === pl.id ? { ...p, estimated_distance_km: estKm, estimated_duration_minutes: estMin, last_generated_at: new Date().toISOString() } : p));
                            }
                          } catch (_) {}
                          setOpProgress((p) => ({ ...p, processed: i + 1 }));
                          await new Promise(r => setTimeout(r, 75));
                        }
                      } finally {
                        setIsRecomputing(false);
                        setOpProgress({ total: 0, processed: 0, label: '' });
                      }
                    }}
                    disabled={isLoading || isDeleting || isRecomputing}
                    className="gap-2"
                  >
                    <RefreshCw className="w-4 h-4" /> Recompute Selected
                  </Button>
                )}
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleDeleteSelected}
                  disabled={isLoading || isDeleting}
                >
                  {isDeleting ? 'Deleting…' : `Delete Selected (${selectedPolylines.size})`}
                </Button>
              </>
            )}
            {activeItems.length > 0 && selectedPolylines.size === 0 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDeleteAll}
                disabled={isLoading}
              >
                Delete All Filtered ({activeItems.length})
              </Button>
            )}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col min-h-0">
        {(isDeleting || isRecomputing) && opProgress.total > 0 ? (
          <div className="flex justify-center items-center h-24 mb-4 rounded border bg-slate-50 text-slate-700">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            {opProgress.label} {opProgress.processed}/{opProgress.total}
          </div>
        ) : null}
        {isLoading ? (
          <div className="flex flex-1 justify-center items-center min-h-[24rem]">
            <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
            <span className="ml-3 text-slate-600">Loading polyline data...</span>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 mb-4 md:hidden">
              <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
                <SheetTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-2">
                    <Filter className="w-4 h-4" /> Controls
                  </Button>
                </SheetTrigger>
                <SheetContent side="bottom" className="h-[80vh] overflow-y-auto">
                  <SheetHeader>
                    <SheetTitle>Routes Controls</SheetTitle>
                  </SheetHeader>
                  <div className="space-y-4 pt-4">
                    <div className="flex gap-1 bg-slate-100 p-1 rounded-lg w-full">
                      <Button variant={viewMode === 'polylines' ? 'default' : 'ghost'} size="sm" onClick={() => setViewMode('polylines')} className="flex-1 h-8">Polylines</Button>
                      <Button variant={viewMode === 'breadcrumbs' ? 'default' : 'ghost'} size="sm" onClick={() => setViewMode('breadcrumbs')} className="flex-1 h-8">Breadcrumbs</Button>
                    </div>
                    <div className="flex gap-1 bg-slate-100 p-1 rounded-lg w-full">
                      <Button variant={dataSource === 'online' ? 'default' : 'ghost'} size="sm" onClick={() => setDataSource('online')} className="flex-1 h-8">Online</Button>
                      <Button variant={dataSource === 'offline' ? 'default' : 'ghost'} size="sm" onClick={() => setDataSource('offline')} className="flex-1 h-8">Offline</Button>
                    </div>
                    <Select value={driverFilter} onValueChange={setDriverFilter}>
                      <SelectTrigger className="w-full"><SelectValue placeholder="All Drivers" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Drivers</SelectItem>
                        {availableDrivers.map(driver => <SelectItem key={driver.id} value={driver.id}>{driver.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Input type="date" value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} className="w-full" />
                    {(driverFilter !== 'all' || dateFilter) && <Button variant="outline" size="sm" onClick={() => { setDriverFilter('all'); setDateFilter(''); }}>Clear Filters</Button>}
                  </div>
                </SheetContent>
              </Sheet>
              <Sheet open={showList} onOpenChange={setShowList}>
                <SheetTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-2">
                    <ChevronDown className="w-4 h-4" /> Records ({activeItems.length})
                  </Button>
                </SheetTrigger>
                <SheetContent side="bottom" className="h-[80vh] p-0">
                  <SheetHeader className="p-4 pb-2 border-b">
                    <SheetTitle>{viewMode === 'polylines' ? 'Route Records' : 'Breadcrumb Records'}</SheetTitle>
                  </SheetHeader>
                  <div className="h-[calc(80vh-73px)] overflow-y-auto">
                    {viewMode === 'polylines' ? filteredPolylines.slice(0, visibleCount).map((polyline) => (
                      <div key={polyline.id} className={`p-3 border-b transition-colors ${selectedPolyline?.id === polyline.id ? 'bg-blue-50 border-l-4 border-l-blue-500' : 'hover:bg-slate-50'}`}>
                        <div className="flex items-start gap-2">
                          <Checkbox checked={selectedPolylines.has(polyline.id)} onCheckedChange={(checked) => handleSelectPolyline(polyline.id, checked)} onClick={(e) => e.stopPropagation()} className="mt-1" />
                          <div className="flex-1 cursor-pointer" onClick={() => { handlePolylineClick(polyline); setShowList(false); }}>
                            <div className="font-medium text-sm mb-1">{getDriverName(polyline.driver_id)}</div>
                            <div className="text-xs text-slate-600 space-y-1">
                              <div>📅 {format(new Date(polyline.delivery_date + 'T00:00:00'), 'MMM d, yyyy')}</div>
                              <div className="flex justify-between"><span>🕒 {polyline.estimated_duration_minutes?.toFixed(1) || '0'} min</span><span>📏 {polyline.estimated_distance_km?.toFixed(2) || '0'} km</span></div>
                              <div>🟢 Origin: {Number(polyline.segment_origin_lat).toFixed(5)}, {Number(polyline.segment_origin_lon).toFixed(5)}</div>
                              <div>🔴 Destination: {Number(polyline.segment_dest_lat).toFixed(5)}, {Number(polyline.segment_dest_lon).toFixed(5)}</div>
                              {polyline.last_generated_at && <div className="text-slate-400">Updated: {format(new Date(polyline.last_generated_at), 'MMM d, h:mm a')}</div>}
                            </div>
                          </div>
                        </div>
                      </div>
                    )) : filteredBreadcrumbs.slice(0, visibleCount).map((breadcrumb) => (
                      <div key={breadcrumb.id} className={`p-3 border-b transition-colors ${selectedPolyline?.id === breadcrumb.id ? 'bg-blue-50 border-l-4 border-l-blue-500' : 'hover:bg-slate-50'}`}>
                        <div className="flex items-start gap-2">
                          <Checkbox checked={selectedPolylines.has(breadcrumb.id)} onCheckedChange={(checked) => handleSelectPolyline(breadcrumb.id, checked)} onClick={(e) => e.stopPropagation()} className="mt-1" />
                          <div className="flex-1 cursor-pointer" onClick={() => { setSelectedPolyline(breadcrumb); setDecodedCoordinates(breadcrumb.coordinates || []); setShowList(false); }}>
                            <div className="font-medium text-sm mb-1">{getDriverName(breadcrumb.driver_id)}</div>
                            <div className="text-xs text-slate-600 space-y-1">
                              <div>📅 {breadcrumb.delivery_date ? format(new Date(breadcrumb.delivery_date + 'T00:00:00'), 'MMM d, yyyy') : 'No date'}</div>
                              <div className="flex justify-between"><span>📍 {breadcrumb.point_count || breadcrumb.coordinates?.length || 0} points</span>{breadcrumb.is_temp_offline && <span className="text-amber-600">Offline Temp</span>}</div>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </SheetContent>
              </Sheet>
            </div>

            <div className="flex gap-3 mb-4 hidden md:flex">
              <div className="flex gap-1 bg-slate-100 p-1 rounded-lg">
                <Button
                  variant={viewMode === 'polylines' ? 'default' : 'ghost'}
                  size="sm"
                  onClick={() => setViewMode('polylines')}
                  className="h-8"
                >
                  Polylines
                </Button>
                <Button
                  variant={viewMode === 'breadcrumbs' ? 'default' : 'ghost'}
                  size="sm"
                  onClick={() => setViewMode('breadcrumbs')}
                  className="h-8"
                >
                  Breadcrumbs
                </Button>
              </div>

              <div className="flex gap-1 bg-slate-100 p-1 rounded-lg">
                <Button
                  variant={dataSource === 'online' ? 'default' : 'ghost'}
                  size="sm"
                  onClick={() => setDataSource('online')}
                  className="h-8"
                >
                  Online
                </Button>
                <Button
                  variant={dataSource === 'offline' ? 'default' : 'ghost'}
                  size="sm"
                  onClick={() => setDataSource('offline')}
                  className="h-8"
                >
                  Offline
                </Button>
              </div>

              <Select value={driverFilter} onValueChange={setDriverFilter}>
                <SelectTrigger className="w-48">
                  <SelectValue placeholder="All Drivers" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Drivers</SelectItem>
                  {availableDrivers.map(driver => (
                    <SelectItem key={driver.id} value={driver.id}>
                      {driver.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Input
                type="date"
                value={dateFilter}
                onChange={(e) => setDateFilter(e.target.value)}
                placeholder="Filter by date"
                className="w-48"
              />

              {(driverFilter !== 'all' || dateFilter) && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setDriverFilter('all');
                    setDateFilter('');
                  }}
                >
                  Clear Filters
                </Button>
              )}
            </div>

            <div className="flex flex-col md:flex-row gap-4 flex-1 min-h-0">
              {/* Left: List */}
              <div className="hidden md:flex md:w-1/3 border rounded-lg overflow-hidden flex-col disabled:opacity-50">
                <div className="bg-slate-100 p-3 border-b flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={isAllSelected}
                      onCheckedChange={handleSelectAll}
                      className={isSomeSelected ? 'data-[state=checked]:bg-slate-500' : ''}
                    />
                    <h3 className="font-semibold text-sm">
                      {viewMode === 'polylines' ? `Polyline Records (${filteredPolylines.length})` : `Breadcrumb Records (${filteredBreadcrumbs.length})`}
                   {viewMode === 'polylines' && dataSource === 'online' && polylines.length === 0 && (
                     <span className="ml-2 text-xs text-slate-500">(No online data — switch to Offline to manage cached records)</span>
                   )}
                    </h3>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto" onScroll={handleListScroll} ref={listContainerRef}>
                  {viewMode === 'polylines' ? filteredPolylines.slice(0, visibleCount).map((polyline) => (
                    <div
                      key={polyline.id}
                      className={`p-3 border-b transition-colors ${
                        selectedPolyline?.id === polyline.id
                          ? 'bg-blue-50 border-l-4 border-l-blue-500'
                          : 'hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <Checkbox
                          checked={selectedPolylines.has(polyline.id)}
                          onCheckedChange={(checked) => handleSelectPolyline(polyline.id, checked)}
                          onClick={(e) => e.stopPropagation()}
                          className="mt-1"
                        />
                        <div 
                          className="flex-1 cursor-pointer"
                          onClick={() => handlePolylineClick(polyline)}
                        >
                          <div className="font-medium text-sm mb-1">
                            {getDriverName(polyline.driver_id)}
                          </div>
                          <div className="text-xs text-slate-600 space-y-1">
                            <div>📅 {format(new Date(polyline.delivery_date + 'T00:00:00'), 'MMM d, yyyy')}</div>
                            <div className="flex justify-between">
                              <span>🕒 {polyline.estimated_duration_minutes?.toFixed(1) || '0'} min</span>
                              <span>📏 {polyline.estimated_distance_km?.toFixed(2) || '0'} km</span>
                            </div>
                            <div>🟢 Origin: {Number(polyline.segment_origin_lat).toFixed(5)}, {Number(polyline.segment_origin_lon).toFixed(5)}</div>
                            <div>🔴 Destination: {Number(polyline.segment_dest_lat).toFixed(5)}, {Number(polyline.segment_dest_lon).toFixed(5)}</div>
                            {polyline.last_generated_at && (
                              <div className="text-slate-400">
                                Updated: {format(new Date(polyline.last_generated_at), 'MMM d, h:mm a')}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )) : filteredBreadcrumbs.slice(0, visibleCount).map((breadcrumb) => (
                    <div
                      key={breadcrumb.id}
                      className={`p-3 border-b transition-colors ${
                        selectedPolyline?.id === breadcrumb.id
                          ? 'bg-blue-50 border-l-4 border-l-blue-500'
                          : 'hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <Checkbox
                          checked={selectedPolylines.has(breadcrumb.id)}
                          onCheckedChange={(checked) => handleSelectPolyline(breadcrumb.id, checked)}
                          onClick={(e) => e.stopPropagation()}
                          className="mt-1"
                        />
                        <div 
                          className="flex-1 cursor-pointer"
                          onClick={() => {
                            setSelectedPolyline(breadcrumb);
                            setDecodedCoordinates(breadcrumb.coordinates || []);
                          }}
                        >
                          <div className="font-medium text-sm mb-1">
                            {getDriverName(breadcrumb.driver_id)}
                          </div>
                          <div className="text-xs text-slate-600 space-y-1">
                            <div>📅 {breadcrumb.delivery_date ? format(new Date(breadcrumb.delivery_date + 'T00:00:00'), 'MMM d, yyyy') : 'No date'}</div>
                            <div className="flex justify-between">
                              <span>📍 {breadcrumb.point_count || breadcrumb.coordinates?.length || 0} points</span>
                              {breadcrumb.is_temp_offline && <span className="text-amber-600">Offline Temp</span>}
                            </div>
                            {breadcrumb.created_date && (
                              <div className="text-slate-400">
                                Created: {format(new Date(breadcrumb.created_date), 'h:mm a')}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Right: Map */}
              <div className="flex-1 border rounded-lg overflow-hidden h-[420px] md:h-auto md:min-h-0">
                {selectedPolyline && decodedCoordinates.length > 0 ? (
                  <MapContainer
                    center={decodedCoordinates[0]}
                    zoom={13}
                    style={{ height: '100%', width: '100%' }}
                    key={`${viewMode}-${selectedPolyline.id}`}
                  >
                    <TileLayer
                      url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                      attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                    />
                    
                    {decodedCoordinates.length > 0 && (
                      <>
                        <Polyline
                          positions={decodedCoordinates}
                          color={viewMode === 'polylines' ? 'blue' : 'red'}
                          weight={viewMode === 'polylines' ? 4 : 2}
                          opacity={0.7}
                        />
                        
                        {/* Origin marker - only for polylines */}
                        {viewMode === 'polylines' && selectedPolyline.segment_origin_lat && selectedPolyline.segment_origin_lon && (
                          <Marker position={[selectedPolyline.segment_origin_lat, selectedPolyline.segment_origin_lon]}>
                            <Popup>
                              <strong>Origin</strong>
                              <br />
                              {selectedPolyline.segment_origin_lat.toFixed(6)}, {selectedPolyline.segment_origin_lon.toFixed(6)}
                            </Popup>
                          </Marker>
                        )}
                        
                        {/* Destination marker - only for polylines */}
                        {viewMode === 'polylines' && selectedPolyline.segment_dest_lat && selectedPolyline.segment_dest_lon && (
                          <Marker position={[selectedPolyline.segment_dest_lat, selectedPolyline.segment_dest_lon]}>
                            <Popup>
                              <strong>Destination</strong>
                              <br />
                              {selectedPolyline.segment_dest_lat.toFixed(6)}, {selectedPolyline.segment_dest_lon.toFixed(6)}
                            </Popup>
                          </Marker>
                        )}
                        
                        <MapUpdater coordinates={decodedCoordinates} />
                      </>
                    )}
                  </MapContainer>
                ) : (
                  <div className="h-full flex items-center justify-center bg-slate-50 text-slate-400">
                    Select a route record to view it on the map
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}