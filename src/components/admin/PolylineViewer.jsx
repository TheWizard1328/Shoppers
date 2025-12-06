import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { MapContainer, TileLayer, Polyline, Marker, Popup, useMap } from 'react-leaflet';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, MapPin } from 'lucide-react';
import { format } from 'date-fns';
import { getDriverDisplayName } from '../utils/driverUtils';
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
  const [isLoading, setIsLoading] = useState(true);
  const [selectedPolyline, setSelectedPolyline] = useState(null);
  const [decodedCoordinates, setDecodedCoordinates] = useState([]);

  useEffect(() => {
    const fetchPolylines = async () => {
      try {
        setIsLoading(true);
        const data = await base44.entities.DriverRoutePolyline.list('-delivery_date');
        setPolylines(data || []);
      } catch (error) {
        console.error('Error fetching polylines:', error);
        setPolylines([]);
      } finally {
        setIsLoading(false);
      }
    };

    fetchPolylines();
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MapPin className="w-5 h-5" />
          Google Polyline Data
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
          <div className="flex gap-4" style={{ height: '600px' }}>
            {/* Left: List */}
            <div className="w-1/3 border rounded-lg overflow-hidden flex flex-col">
              <div className="bg-slate-100 p-3 border-b">
                <h3 className="font-semibold text-sm">Polyline Records ({polylines.length})</h3>
              </div>
              <div className="flex-1 overflow-y-auto">
                {polylines.map((polyline) => (
                  <div
                    key={polyline.id}
                    onClick={() => handlePolylineClick(polyline)}
                    className={`p-3 border-b cursor-pointer transition-colors ${
                      selectedPolyline?.id === polyline.id
                        ? 'bg-blue-50 border-l-4 border-l-blue-500'
                        : 'hover:bg-slate-50'
                    }`}
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
                ))}
              </div>
            </div>

            {/* Right: Map */}
            <div className="flex-1 border rounded-lg overflow-hidden">
              {selectedPolyline ? (
                <MapContainer
                  center={[43.6532, -79.3832]}
                  zoom={13}
                  style={{ height: '100%', width: '100%' }}
                  key={selectedPolyline.id}
                >
                  <TileLayer
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                  />
                  
                  {decodedCoordinates.length > 0 && (
                    <>
                      <Polyline
                        positions={decodedCoordinates}
                        color="blue"
                        weight={4}
                        opacity={0.7}
                      />
                      
                      {/* Origin marker */}
                      {selectedPolyline.segment_origin_lat && selectedPolyline.segment_origin_lon && (
                        <Marker position={[selectedPolyline.segment_origin_lat, selectedPolyline.segment_origin_lon]}>
                          <Popup>
                            <strong>Origin</strong>
                            <br />
                            {selectedPolyline.segment_origin_lat.toFixed(6)}, {selectedPolyline.segment_origin_lon.toFixed(6)}
                          </Popup>
                        </Marker>
                      )}
                      
                      {/* Destination marker */}
                      {selectedPolyline.segment_dest_lat && selectedPolyline.segment_dest_lon && (
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
        )}
      </CardContent>
    </Card>
  );
}