import React, { useMemo, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from "@/components/ui/button";
import { MapPin, Home, Building2, Truck, X } from 'lucide-react';
import { MapContainer, TileLayer, Marker, Popup, Polyline } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import DeliveryMap from '../dashboard/DeliveryMap';
import { getStoreColor } from '../utils/colorGenerator';

export default function RouteMapView({ 
  isOpen, 
  onClose, 
  deliveries = [], 
  patients = [], 
  stores = [], 
  drivers = [], 
  selectedDate, 
  currentUser,
  selectedDeliveryId, // New prop
  onDeliveryClick // New prop
}) {
  // Add ESC key handler
  useEffect(() => {
    if (!isOpen) return;
    
    const handleEscKey = (event) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscKey);
    return () => {
      document.removeEventListener('keydown', handleEscKey);
    };
  }, [isOpen, onClose]);

  const mapData = useMemo(() => {
    if (!deliveries.length) return { markers: [], storesToShow: [] };

    // Create markers for deliveries - exactly like dashboard
    const markers = deliveries
      .filter(delivery => {
        const isPickup = delivery.patient_id === null;
        if (isPickup) {
          const store = stores.find(s => s.id === delivery.store_id);
          return store && store.latitude && store.longitude;
        } else {
          const patient = patients.find(p => p && (p.id === delivery.patient_id || p.patient_id === delivery.patient_id));
          return patient && patient.latitude && patient.longitude;
        }
      })
      .map(delivery => {
        const isPickup = delivery.patient_id === null;
        
        if (isPickup) {
          const store = stores.find(s => s.id === delivery.store_id);
          return {
            id: delivery.id,
            position: [store.latitude, store.longitude],
            type: 'pickup',
            delivery,
            store,
            patient: null
          };
        } else {
          const patient = patients.find(p => p && (p.id === delivery.patient_id || p.patient_id === delivery.patient_id));
          const store = stores.find(s => s.id === patient?.store_id);
          return {
            id: delivery.id,
            position: [patient.latitude, patient.longitude],
            type: 'delivery',
            delivery,
            patient,
            store
          };
        }
      });

    // Get all stores involved in this route
    const storeIds = new Set();
    deliveries.forEach(delivery => {
      if (delivery.patient_id === null) {
        // This is a pickup
        storeIds.add(delivery.store_id);
      } else {
        // This is a delivery, find the patient's store
        const patient = patients.find(p => p.id === delivery.patient_id);
        if (patient) storeIds.add(patient.store_id);
      }
    });

    const storesToShow = stores.filter(store => 
      storeIds.has(store.id) && store.latitude && store.longitude
    );

    return { markers, storesToShow };
  }, [deliveries, patients, stores]);

  if (!isOpen) return null;

  const dateString = selectedDate ? selectedDate.toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  }) : 'Selected Route';

  // Find the center point for the map
  const getMapCenter = () => {
    if (mapData.markers.length > 0) {
      return mapData.markers[0].position;
    } else if (mapData.storesToShow.length > 0) {
      return [mapData.storesToShow[0].latitude, mapData.storesToShow[0].longitude];
    }
    return [43.6532, -79.3832]; // Default center
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50 lg:pl-64">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full h-full max-w-6xl max-h-[90vh] flex flex-col"
      >
        <Card className="bg-white border-slate-200 shadow-xl flex flex-col h-full overflow-hidden">
          <CardHeader className="flex-shrink-0 border-b border-slate-200 p-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-xl font-bold text-slate-900">
                Route Map - {dateString}
              </CardTitle>
              <Button variant="ghost" size="icon" onClick={onClose}>
                <X className="w-4 h-4" />
              </Button>
            </div>
            <p className="text-slate-600 mt-1">
              {mapData.markers.length} stops • {mapData.storesToShow.length} stores
            </p>
          </CardHeader>
          
          <div className="flex-1 overflow-hidden">
            {mapData.markers.length > 0 || mapData.storesToShow.length > 0 ? (
              <MapContainer
                center={getMapCenter()}
                zoom={11}
                className="w-full h-full"
                zoomControl={true}
              >
                <TileLayer
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                />
                <DeliveryMap 
                  markers={mapData.markers}
                  currentUser={currentUser}
                  storesToShow={mapData.storesToShow}
                  showStoreMarkers={true}
                  showDriverMarkers={false}
                  showStopCards={false}
                  zoom={11}
                  selectedDeliveryId={selectedDeliveryId} // Pass new prop
                  onDeliveryClick={onDeliveryClick} // Pass new prop
                />
              </MapContainer>
            ) : (
              <div className="w-full h-full flex items-center justify-center text-slate-500">
                <div className="text-center">
                  <p className="text-lg font-medium">No stops to display</p>
                  <p className="text-sm">No deliveries or pickups found for this route.</p>
                </div>
              </div>
            )}
          </div>
        </Card>
      </motion.div>
    </div>
  );
}