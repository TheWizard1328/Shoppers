import React, { useState, useEffect, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { MapContainer, TileLayer, Polyline, Marker, Popup, useMap } from 'react-leaflet';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, MapPin, Trash2 } from 'lucide-react';
import { format } from 'date-fns';
import { getDriverDisplayName } from '../utils/driverUtils';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
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

export default function PolylineViewer({ users = [] }) {
  const [polylines, setPolylines] = useState([]);
  const [breadcrumbs, setBreadcrumbs] = useState([]);
  const [viewMode, setViewMode] = useState('polylines');
  const [isLoading, setIsLoading] = useState(true);
  const [selectedPolyline, setSelectedPolyline] = useState(null);
  const [decodedCoordinates, setDecodedCoordinates] = useState([]);
  const [selectedPolylines, setSelectedPolylines] = useState(new Set());
  const [driverFilter, setDriverFilter] = useState('all');
  const [dateFilter, setDateFilter] = useState('');

  useEffect(() => {
    const fetchData = async () => {
      try {
        setIsLoading(true);
        const polylinesData = await base44.entities.DriverRoutePolyline.list('-delivery_date');
        setPolylines(polylinesData || []);
        
        const breadcrumbsData = await base44.entities.DeliveryBreadcrumbs.list('-delivery_date');
        setBreadcrumbs(breadcrumbsData || []);
      } catch (error) {
        console.error('Error fetching data:', error);
        setPolylines([]);
        setBreadcrumbs([]);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, []);

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

    return filtered;
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

  const availableDrivers = useMemo(() => {
    const dataSource = viewMode === 'polylines' ? polylines : breadcrumbs;
    const driverIds = [...new Set(dataSource.map(p => p.driver_id))];
    return driverIds.map(id => ({
      id,
      name: getDriverName(id)
    }));
  }, [polylines, breadcrumbs, users, viewMode]);

  const handleSelectAll = (checked) => {
    if (checked) {
      setSelectedPolylines(new Set(filteredPolylines.map(p => p.id)));
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
    
    if (!window.confirm(`Delete ${selectedPolylines.size} selected polyline(s)?`)) return;

    try {
      setIsLoading(true);
      for (const id of selectedPolylines) {
        await base44.entities.DriverRoutePolyline.delete(id);
      }
      
      const remaining = polylines.filter(p => !selectedPolylines.has(p.id));
      setPolylines(remaining);
      setSelectedPolylines(new Set());
      setSelectedPolyline(null);
    } catch (error) {
      console.error('Error deleting polylines:', error);
      alert('Failed to delete polylines: ' + error.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteAll = async () => {
    if (filteredPolylines.length === 0) return;
    
    if (!window.confirm(`Delete all ${filteredPolylines.length} filtered polyline(s)? This cannot be undone.`)) return;

    try {
      setIsLoading(true);
      for (const polyline of filteredPolylines) {
        await base44.entities.DriverRoutePolyline.delete(polyline.id);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      const remaining = polylines.filter(p => !filteredPolylines.find(fp => fp.id === p.id));
      setPolylines(remaining);
      setSelectedPolylines(new Set());
      setSelectedPolyline(null);
    } catch (error) {
      console.error('Error deleting all polylines:', error);
      alert('Failed to delete polylines: ' + error.message);
    } finally {
      setIsLoading(false);
    }
  };

  const isAllSelected = filteredPolylines.length > 0 && selectedPolylines.size === filteredPolylines.length;
  const isSomeSelected = selectedPolylines.size > 0 && selectedPolylines.size < filteredPolylines.length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MapPin className="w-5 h-5" />
            {viewMode === 'polylines' ? 'Google Polyline Data' : 'GPS Breadcrumbs'}
          </div>
          <div className="flex gap-2">
            {selectedPolylines.size > 0 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDeleteSelected}
                disabled={isLoading}
              >
                Delete Selected ({selectedPolylines.size})
              </Button>
            )}
            {filteredPolylines.length > 0 && selectedPolylines.size === 0 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDeleteAll}
                disabled={isLoading}
              >
                Delete All Filtered ({filteredPolylines.length})
              </Button>
            )}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center items-center h-96">
            <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
            <span className="ml-3 text-slate-600">Loading polyline data...</span>
          </div>
        ) : polylines.length === 0 ? (
          <div className="text-center py-12 text-slate-500">
            No polyline data found.
          </div>
        ) : (
          <>
            <div className="flex gap-3 mb-4">
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

            <div className="flex gap-4" style={{ height: '600px' }}>
              {/* Left: List */}
              <div className="w-1/3 border rounded-lg overflow-hidden flex flex-col">
                <div className="bg-slate-100 p-3 border-b flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={isAllSelected}
                      onCheckedChange={handleSelectAll}
                      className={isSomeSelected ? 'data-[state=checked]:bg-slate-500' : ''}
                    />
                    <h3 className="font-semibold text-sm">
                      {viewMode === 'polylines' ? `Polyline Records (${filteredPolylines.length})` : `Breadcrumb Records (${filteredBreadcrumbs.length})`}
                    </h3>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto">
                  {viewMode === 'polylines' ? filteredPolylines.map((polyline) => (
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
                            {polyline.last_generated_at && (
                              <div className="text-slate-400">
                                Updated: {format(new Date(polyline.last_generated_at), 'h:mm a')}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )) : filteredBreadcrumbs.map((breadcrumb) => (
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
                            <div>📅 {format(new Date(breadcrumb.delivery_date + 'T00:00:00'), 'MMM d, yyyy')}</div>
                            <div className="flex justify-between">
                              <span>📍 {breadcrumb.coordinates?.length || 0} points</span>
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
              <div className="flex-1 border rounded-lg overflow-hidden">
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
                    Select a polyline from the list to view it on the map
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