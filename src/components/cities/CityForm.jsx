import React, { useState, useEffect, useRef, useMemo } from "react";
import { motion } from "framer-motion";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { X, Save, MapPin, Globe } from "lucide-react";

// Country and Province/State data
const COUNTRIES = [
  { value: "Canada", label: "Canada" },
  { value: "USA", label: "USA" }
];

const PROVINCES_STATES = {
  Canada: [
    "Alberta", "British Columbia", "Manitoba", "New Brunswick", 
    "Newfoundland and Labrador", "Northwest Territories", "Nova Scotia", 
    "Nunavut", "Ontario", "Prince Edward Island", "Quebec", "Saskatchewan", "Yukon"
  ].sort(),
  USA: [
    "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", 
    "Connecticut", "Delaware", "Florida", "Georgia", "Hawaii", "Idaho", 
    "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", 
    "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", 
    "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", 
    "New Hampshire", "New Jersey", "New Mexico", "New York", 
    "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", 
    "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", 
    "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", 
    "West Virginia", "Wisconsin", "Wyoming"
  ].sort()
};
import { base44 } from '@/api/base44Client';
import { User } from '@/api/entities';
import { sortUsers } from "../utils/sorting";
import { useAppData } from '../utils/AppDataContext';
import { MapContainer, TileLayer, Marker, useMapEvents, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Fix Leaflet default icon issue
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

const roundCoord = (num) => parseFloat(num.toFixed(7));

// Component to handle map click events for placing marker
function MapClickHandler({ onMapClick }) {
  useMapEvents({
    click: (e) => {
      onMapClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

// Component to recenter map when coordinates change
function MapRecenter({ lat, lng }) {
  const map = useMap();
  
  useEffect(() => {
    if (lat && lng) {
      map.setView([lat, lng], map.getZoom());
    }
  }, [lat, lng, map]);
  
  return null;
}

// Create a custom city center icon
const createCityCenterIcon = () => {
  return L.divIcon({
    className: 'custom-city-marker',
    html: `
      <div style="
        width: 40px;
        height: 40px;
        background: linear-gradient(135deg, #10b981 0%, #059669 100%);
        border-radius: 50%;
        border: 3px solid white;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        display: flex;
        align-items: center;
        justify-content: center;
      ">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/>
          <circle cx="12" cy="10" r="3"/>
        </svg>
      </div>
    `,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  });
};

export default function CityForm({ city, onSave, onCancel }) {
  const { setIsFormOverlayOpen } = useAppData();
  
  const [formData, setFormData] = useState({
    name: city?.name || "",
    province_state: city?.province_state || "",
    country: city?.country || "",
    latitude: city?.latitude || null,
    longitude: city?.longitude || null,
    sort_order: city?.sort_order || null,
  });
  const [isGeocoding, setIsGeocoding] = useState(false);
  const [stores, setStores] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [isNarrowScreen, setIsNarrowScreen] = useState(window.innerWidth < 900);
  const [isFullScreen, setIsFullScreen] = useState(() => {
    // Go full screen if narrow layout AND height is constrained
    const isNarrow = window.innerWidth < 900;
    return isNarrow && window.innerHeight < 850;
  });

  // Add ESC key handler
  useEffect(() => {
    const handleEscKey = (event) => {
      if (event.key === 'Escape') {
        onCancel();
      }
    };

    document.addEventListener('keydown', handleEscKey);
    return () => {
      document.removeEventListener('keydown', handleEscKey);
    };
  }, [onCancel]);

  // Prevent background scrolling when form is open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, []);

  // Track screen dimensions for responsive layout
  useEffect(() => {
    const handleResize = () => {
      const isNarrow = window.innerWidth < 900;
      setIsNarrowScreen(isNarrow);
      // Go full screen if narrow layout AND height is constrained
      setIsFullScreen(isNarrow && window.innerHeight < 850);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    setIsFormOverlayOpen(true);
    return () => {
      setIsFormOverlayOpen(false);
    };
  }, [setIsFormOverlayOpen]);

  useEffect(() => {
    if (city) {
      Promise.all([base44.entities.Store.list(), base44.entities.AppUser.list()]).then(([storesData, usersData]) => {
        const cityStores = storesData.filter(store => store.city_id === city.id);
        setStores(cityStores);
        const cityDrivers = usersData.filter(user => (user.app_roles || []).some(role => role === 'driver' || role === 'admin') && user.city_id === city.id);
        setDrivers(sortUsers(cityDrivers));
      }).catch(error => console.error("Error fetching city data:", error));
    }
  }, [city]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!formData.latitude || !formData.longitude) {
      alert("Please provide city coordinates by geocoding or by manually entering them.");
      return;
    }
    onSave({ ...formData, latitude: roundCoord(formData.latitude), longitude: roundCoord(formData.longitude) });
  };

  const handleGeocode = async () => {
    const fullAddress = [formData.name, formData.province_state, formData.country].filter(Boolean).join(', ');
    if (!fullAddress) {
      alert("Please enter city details first.");
      return;
    }
    setIsGeocoding(true);
    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(fullAddress)}`);
      const data = await response.json();
      if (data && data.length > 0) {
        setFormData(prev => ({ 
          ...prev, 
          latitude: parseFloat(parseFloat(data[0].lat).toFixed(7)), 
          longitude: parseFloat(parseFloat(data[0].lon).toFixed(7)) 
        }));
      } else {
        alert("Could not find coordinates for this address.");
      }
    } catch (error) {
      console.error("Geocoding error:", error);
    } finally {
      setIsGeocoding(false);
    }
  };
  
  return (
    <div className={`fixed inset-0 bg-black/60 flex items-center justify-center z-[9999] ${isFullScreen ? 'p-0' : 'p-4 lg:pl-64'}`}>
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className={`w-full ${isFullScreen ? 'h-full' : 'max-w-3xl'}`}
      >
        <Card className={`shadow-xl ${isFullScreen ? 'h-full rounded-none overflow-y-auto' : isNarrowScreen ? 'max-h-[90vh] overflow-y-auto' : ''}`} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          <CardHeader className="flex flex-row items-center justify-between px-6 py-1.5" style={{ borderBottom: '1px solid var(--border-slate-300)' }}>
            <CardTitle className="text-xl font-bold" style={{ color: 'var(--text-slate-900)' }}>{city ? 'Edit City' : 'Add New City'}</CardTitle>
            <Button variant="ghost" size="icon" onClick={onCancel}><X className="w-4 h-4" /></Button>
          </CardHeader>
          <CardContent className="p-0">
            <div className={`grid ${isNarrowScreen ? 'grid-cols-1' : 'grid-cols-2'}`}>
              <div className="p-6">
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2"><Label htmlFor="name" style={{ color: 'var(--text-slate-900)' }}>City Name *</Label><Input id="name" value={formData.name} onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))} required style={{ borderColor: 'var(--menu-border)', background: 'var(--bg-white)', color: 'var(--text-slate-900)' }}/></div>
                    <div className="space-y-2"><Label htmlFor="geocode" style={{ color: 'var(--text-slate-900)' }}>Geocode</Label><Button id="geocode" type="button" variant="outline" onClick={handleGeocode} disabled={isGeocoding} className="w-full gap-2" style={{ borderColor: 'var(--menu-border)', background: 'var(--bg-white)', color: 'var(--text-slate-900)' }}>{isGeocoding ? <div className="w-4 h-4 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin"></div> : <MapPin className="w-4 h-4" />} Geocode</Button></div>
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="country" style={{ color: 'var(--text-slate-900)' }}>Country *</Label>
                      <Select value={formData.country} onValueChange={(value) => setFormData(prev => ({ ...prev, country: value, province_state: "" }))}>
                        <SelectTrigger style={{ borderColor: 'var(--menu-border)', background: 'var(--bg-white)', color: 'var(--text-slate-900)' }}><SelectValue placeholder="Select country..." /></SelectTrigger>
                        <SelectContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                          {COUNTRIES.map((c) => <SelectItem key={c.value} value={c.value} style={{ color: 'var(--text-slate-900)' }}>{c.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="province_state" style={{ color: 'var(--text-slate-900)' }}>Prov/State *</Label>
                      <Select value={formData.province_state} onValueChange={(value) => setFormData(prev => ({ ...prev, province_state: value }))} disabled={!formData.country}>
                        <SelectTrigger style={{ borderColor: 'var(--menu-border)', background: 'var(--bg-white)', color: 'var(--text-slate-900)' }}><SelectValue placeholder={formData.country ? "Select..." : "Select country first"} /></SelectTrigger>
                        <SelectContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                          {(PROVINCES_STATES[formData.country] || []).map((ps) => <SelectItem key={ps} value={ps} style={{ color: 'var(--text-slate-900)' }}>{ps}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2"><Label htmlFor="sort_order" style={{ color: 'var(--text-slate-900)' }}>Sort Order</Label><Input type="number" id="sort_order" value={formData.sort_order || ""} onChange={(e) => setFormData(prev => ({ ...prev, sort_order: parseInt(e.target.value) || null }))} placeholder="0" style={{ borderColor: 'var(--menu-border)', background: 'var(--bg-white)', color: 'var(--text-slate-900)' }}/></div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2"><Label htmlFor="latitude" style={{ color: 'var(--text-slate-900)' }}>Latitude *</Label><Input type="number" step="any" id="latitude" value={formData.latitude || ""} onChange={(e) => setFormData(prev => ({ ...prev, latitude: parseFloat(e.target.value) || null }))} required style={{ borderColor: 'var(--menu-border)', background: 'var(--bg-white)', color: 'var(--text-slate-900)' }}/></div>
                    <div className="space-y-2"><Label htmlFor="longitude" style={{ color: 'var(--text-slate-900)' }}>Longitude *</Label><Input type="number" step="any" id="longitude" value={formData.longitude || ""} onChange={(e) => setFormData(prev => ({ ...prev, longitude: parseFloat(e.target.value) || null }))} required style={{ borderColor: 'var(--menu-border)', background: 'var(--bg-white)', color: 'var(--text-slate-900)' }}/></div>
                  </div>
                  <div className="pt-4 space-y-2" style={{ borderTop: '1px solid var(--border-slate-200)' }}><Label className="font-semibold" style={{ color: 'var(--text-slate-900)' }}>Associated Data</Label><div className="grid grid-cols-2 gap-4"><div className="space-y-1"><Label className="text-xs" style={{ color: 'var(--text-slate-600)' }}>Stores</Label><div className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>{stores.length}</div></div><div className="space-y-1"><Label className="text-xs" style={{ color: 'var(--text-slate-600)' }}>Drivers</Label><div className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>{drivers.length}</div></div></div></div>
                  <div className="flex justify-end gap-3 pt-4" style={{ borderTop: '1px solid var(--border-slate-200)' }}><Button type="button" variant="outline" onClick={onCancel} style={{ borderColor: 'var(--menu-border)', background: 'var(--bg-white)', color: 'var(--text-slate-900)' }}>Cancel</Button><Button type="submit" className="bg-emerald-600 hover:bg-emerald-700 gap-2" style={{ borderColor: 'var(--menu-border)' }}><Save className="w-4 h-4" />{city ? 'Update' : 'Create'}</Button></div>
                </form>
              </div>
              <div className={`p-6 ${isNarrowScreen ? '' : 'border-l'}`} style={{ borderColor: 'var(--border-slate-200)', borderTop: isNarrowScreen ? '1px solid var(--border-slate-200)' : 'none' }}>
                <Label className="font-semibold" style={{ color: 'var(--text-slate-800)' }}>City Center Location</Label>
                <div className="h-[380px] rounded-lg overflow-hidden mt-2" style={{ border: '1px solid var(--menu-border)', background: 'var(--bg-slate-100)' }}>
                  {formData.latitude && formData.longitude ? (
                    <MapContainer
                      center={[formData.latitude, formData.longitude]}
                      zoom={12}
                      style={{ height: '100%', width: '100%' }}
                      scrollWheelZoom={true}
                    >
                      <TileLayer
                        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                      />
                      <MapClickHandler 
                        onMapClick={(lat, lng) => {
                          setFormData(prev => ({ 
                            ...prev, 
                            latitude: roundCoord(lat), 
                            longitude: roundCoord(lng) 
                          }));
                        }} 
                      />
                      <MapRecenter lat={formData.latitude} lng={formData.longitude} />
                      <Marker 
                        position={[formData.latitude, formData.longitude]}
                        icon={createCityCenterIcon()}
                        draggable={true}
                        eventHandlers={{
                          dragend: (e) => {
                            const marker = e.target;
                            const position = marker.getLatLng();
                            setFormData(prev => ({ 
                              ...prev, 
                              latitude: roundCoord(position.lat), 
                              longitude: roundCoord(position.lng) 
                            }));
                          },
                        }}
                      />
                    </MapContainer>
                  ) : (
                    <div className="h-full flex items-center justify-center">
                      <div className="text-center" style={{ color: 'var(--text-slate-500)' }}>
                        <MapPin className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--text-slate-300)' }} />
                        <p className="text-lg font-medium mb-2">No Coordinates Set</p>
                        <p className="text-sm">Use the Geocode button or enter coordinates manually</p>
                        <p className="text-sm mt-2">to display the map.</p>
                      </div>
                    </div>
                  )}
                </div>
                <p className="text-xs mt-2" style={{ color: 'var(--text-slate-500)' }}>
                  💡 Tip: Click on the map or drag the marker to adjust the city center position.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}