import React, { useMemo } from "react";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { 
  CheckCircle, 
  XCircle, 
  Package, 
  Clock, 
  MapPin, 
  TrendingUp,
  Truck,
  Home,
  X
} from "lucide-react";
import { format, differenceInMinutes } from "date-fns";

// Calculate distance between two points (Haversine formula)
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

export default function RouteSummaryModal({ deliveries, patients, stores, driver, onClose }) {
  const stats = useMemo(() => {
    if (!deliveries || deliveries.length === 0) return null;

    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
    const completedDeliveries = deliveries.filter(d => 
      d && finishedStatuses.includes(d.status) && d.actual_delivery_time
    );

    if (completedDeliveries.length === 0) return null;

    // Sort by completion time
    const sorted = [...completedDeliveries].sort((a, b) => 
      new Date(a.actual_delivery_time) - new Date(b.actual_delivery_time)
    );

    const firstStop = sorted[0];
    const lastStop = sorted[sorted.length - 1];

    // Calculate total stops
    const totalStops = sorted.length;
    const pickups = sorted.filter(d => !d.patient_id);
    const patientDeliveries = sorted.filter(d => d.patient_id);

    // Calculate failed/returned
    const failed = sorted.filter(d => d.status === 'failed').length;
    const returned = sorted.filter(d => d.status === 'returned').length;
    const cancelled = sorted.filter(d => d.status === 'cancelled').length;

    // Calculate time on road (first to last)
    const firstTime = new Date(firstStop.actual_delivery_time);
    const lastTime = new Date(lastStop.actual_delivery_time);
    const totalMinutes = differenceInMinutes(lastTime, firstTime);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    // Calculate average time between stops
    const avgTimeBetweenStops = totalStops > 1 ? 
      Math.round(totalMinutes / (totalStops - 1)) : 0;

    // Calculate total distance including start and end
    let totalDistance = 0;
    
    // Add distance from driver's home to first stop
    if (driver?.home_latitude && driver?.home_longitude && sorted.length > 0) {
      const firstStopCoords = (() => {
        if (firstStop.patient_id) {
          const patient = patients.find(p => p && p.id === firstStop.patient_id);
          return { lat: patient?.latitude, lon: patient?.longitude };
        } else {
          const store = stores.find(s => s && s.id === firstStop.store_id);
          return { lat: store?.latitude, lon: store?.longitude };
        }
      })();
      
      if (firstStopCoords.lat && firstStopCoords.lon) {
        totalDistance += calculateDistance(
          driver.home_latitude, 
          driver.home_longitude, 
          firstStopCoords.lat, 
          firstStopCoords.lon
        );
      }
    }
    
    // Add distances between consecutive stops
    for (let i = 1; i < sorted.length; i++) {
      const prevStop = sorted[i - 1];
      const currStop = sorted[i];

      // Get coordinates for previous stop
      let prevLat, prevLon;
      if (prevStop.patient_id) {
        const patient = patients.find(p => p && p.id === prevStop.patient_id);
        prevLat = patient?.latitude;
        prevLon = patient?.longitude;
      } else {
        const store = stores.find(s => s && s.id === prevStop.store_id);
        prevLat = store?.latitude;
        prevLon = store?.longitude;
      }

      // Get coordinates for current stop
      let currLat, currLon;
      if (currStop.patient_id) {
        const patient = patients.find(p => p && p.id === currStop.patient_id);
        currLat = patient?.latitude;
        currLon = patient?.longitude;
      } else {
        const store = stores.find(s => s && s.id === currStop.store_id);
        currLat = store?.latitude;
        currLon = store?.longitude;
      }

      if (prevLat && prevLon && currLat && currLon) {
        totalDistance += calculateDistance(prevLat, prevLon, currLat, currLon);
      }
    }
    
    // Add distance from last stop back to driver's home
    if (driver?.home_latitude && driver?.home_longitude && sorted.length > 0) {
      const lastStopCoords = (() => {
        if (lastStop.patient_id) {
          const patient = patients.find(p => p && p.id === lastStop.patient_id);
          return { lat: patient?.latitude, lon: patient?.longitude };
        } else {
          const store = stores.find(s => s && s.id === lastStop.store_id);
          return { lat: store?.latitude, lon: store?.longitude };
        }
      })();
      
      if (lastStopCoords.lat && lastStopCoords.lon) {
        totalDistance += calculateDistance(
          lastStopCoords.lat, 
          lastStopCoords.lon,
          driver.home_latitude, 
          driver.home_longitude
        );
      }
    }

    const avgDistanceBetweenStops = totalStops > 1 ? 
      totalDistance / (totalStops - 1) : 0;

    return {
      totalStops,
      totalPickups: pickups.length,
      totalDeliveries: patientDeliveries.length,
      failed,
      returned,
      cancelled,
      totalTime: { hours, minutes, totalMinutes },
      avgTimeBetweenStops,
      totalDistance: Math.round(totalDistance * 10) / 10,
      avgDistanceBetweenStops: Math.round(avgDistanceBetweenStops * 100) / 100,
      firstStopTime: format(firstTime, 'h:mm a'),
      lastStopTime: format(lastTime, 'h:mm a')
    };
  }, [deliveries, patients, stores]);

  if (!stats) return null;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-[9999]">
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        className="w-full max-w-lg">
        
        <Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 shadow-2xl">
          <CardHeader className="border-b border-slate-200 dark:border-slate-700 bg-gradient-to-r from-emerald-50 to-blue-50 dark:from-emerald-950/40 dark:to-blue-950/40">
            <div className="flex items-center justify-between">
              <CardTitle className="text-2xl font-bold text-slate-900 dark:text-slate-100 flex items-center gap-3">
                <div className="p-2 bg-emerald-500 rounded-lg">
                  <CheckCircle className="w-6 h-6 text-white" />
                </div>
                Route Complete!
              </CardTitle>
              <Button variant="ghost" size="icon" onClick={onClose}>
                <X className="w-5 h-5" />
              </Button>
            </div>
          </CardHeader>

          <CardContent className="p-6 space-y-6">
            {/* Stop Summary */}
            <div>
              <h3 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
                Stop Summary
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-slate-50 dark:bg-slate-800 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <Package className="w-4 h-4 text-blue-600" />
                    <span className="text-sm text-slate-600 dark:text-slate-300">Total Stops</span>
                  </div>
                  <p className="text-2xl font-bold text-slate-900 dark:text-slate-100">{stats.totalStops}</p>
                </div>

                <div className="bg-slate-50 dark:bg-slate-800 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <Home className="w-4 h-4 text-emerald-600" />
                    <span className="text-sm text-slate-600 dark:text-slate-300">Pickups</span>
                  </div>
                  <p className="text-2xl font-bold text-slate-900 dark:text-slate-100">{stats.totalPickups}</p>
                </div>

                <div className="bg-slate-50 dark:bg-slate-800 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <Truck className="w-4 h-4 text-purple-600" />
                    <span className="text-sm text-slate-600 dark:text-slate-300">Deliveries</span>
                  </div>
                  <p className="text-2xl font-bold text-slate-900 dark:text-slate-100">{stats.totalDeliveries}</p>
                </div>

                <div className="bg-slate-50 dark:bg-slate-800 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <XCircle className="w-4 h-4 text-red-600" />
                    <span className="text-sm text-slate-600 dark:text-slate-300">Failed/Returned</span>
                  </div>
                  <p className="text-2xl font-bold text-slate-900 dark:text-slate-100">
                    {stats.failed} / {stats.returned}
                  </p>
                </div>
              </div>
            </div>

            {/* Time & Distance */}
            <div>
              <h3 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
                Performance Metrics
              </h3>
              <div className="space-y-3">
                <div className="bg-gradient-to-r from-blue-50 to-blue-100 dark:from-blue-950/40 dark:to-blue-900/30 rounded-lg p-4 border border-blue-200 dark:border-blue-800">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Clock className="w-5 h-5 text-blue-600" />
                      <span className="text-sm font-medium text-blue-900 dark:text-blue-200">Total Time on Road</span>
                    </div>
                    <p className="text-xl font-bold text-blue-900 dark:text-blue-100">
                      {stats.totalTime.hours}h {stats.totalTime.minutes}m
                    </p>
                  </div>
                  <div className="mt-2 text-xs text-blue-700 dark:text-blue-300">
                    {stats.firstStopTime} → {stats.lastStopTime}
                  </div>
                </div>

                <div className="bg-gradient-to-r from-emerald-50 to-emerald-100 dark:from-emerald-950/40 dark:to-emerald-900/30 rounded-lg p-4 border border-emerald-200 dark:border-emerald-800">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <MapPin className="w-5 h-5 text-emerald-600" />
                      <span className="text-sm font-medium text-emerald-900 dark:text-emerald-200">Total Distance</span>
                    </div>
                    <p className="text-xl font-bold text-emerald-900 dark:text-emerald-100">
                      {stats.totalDistance} km
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-slate-50 dark:bg-slate-800 rounded-lg p-3 border border-slate-200 dark:border-slate-700">
                    <div className="flex items-center gap-2 mb-1">
                      <TrendingUp className="w-4 h-4 text-slate-600" />
                      <span className="text-xs text-slate-600 dark:text-slate-300">Avg Time/Stop</span>
                    </div>
                    <p className="text-lg font-bold text-slate-900 dark:text-slate-100">{stats.avgTimeBetweenStops} min</p>
                  </div>

                  <div className="bg-slate-50 dark:bg-slate-800 rounded-lg p-3 border border-slate-200 dark:border-slate-700">
                    <div className="flex items-center gap-2 mb-1">
                      <TrendingUp className="w-4 h-4 text-slate-600" />
                      <span className="text-xs text-slate-600 dark:text-slate-300">Avg Dist/Stop</span>
                    </div>
                    <p className="text-lg font-bold text-slate-900 dark:text-slate-100">{stats.avgDistanceBetweenStops} km</p>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>

          <div className="border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 p-4">
            <Button 
              onClick={onClose} 
              className="w-full bg-emerald-600 hover:bg-emerald-700 gap-2"
            >
              <CheckCircle className="w-4 h-4" />
              Close
            </Button>
          </div>
        </Card>
      </motion.div>
    </div>
  );
}