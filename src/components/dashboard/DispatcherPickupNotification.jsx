import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Truck, Clock, Navigation } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { format } from 'date-fns';

// Calculate distance between two coordinates in meters
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371000; // Earth radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

export default function DispatcherPickupNotification({ 
  deliveries, 
  stores, 
  appUsers,
  currentUser,
  isDispatcher 
}) {
  const [activeNotification, setActiveNotification] = useState(null);
  const [dismissedNotifications, setDismissedNotifications] = useState(new Set());

  useEffect(() => {
    if (!isDispatcher || !currentUser?.store_ids || !deliveries || !stores || !appUsers) {
      setActiveNotification(null);
      return;
    }

    const dispatcherStoreIds = new Set(currentUser.store_ids);
    const todayStr = format(new Date(), 'yyyy-MM-dd');

    // Find next stop pickups for dispatcher's stores
    const nextStopPickups = deliveries.filter(d => {
      if (!d || d.delivery_date !== todayStr) return false;
      if (d.patient_id) return false; // Must be a pickup
      if (!dispatcherStoreIds.has(d.store_id)) return false; // Must be dispatcher's store
      if (d.status !== 'en_route') return false; // Must be en route
      if (!d.isNextDelivery) return false; // Must be next stop
      return true;
    });

    if (nextStopPickups.length === 0) {
      setActiveNotification(null);
      return;
    }

    // Show the first one (or prioritize by ETA)
    const pickup = nextStopPickups.sort((a, b) => {
      const etaA = a.delivery_time_eta || a.delivery_time_start || '99:99';
      const etaB = b.delivery_time_eta || b.delivery_time_start || '99:99';
      return etaA.localeCompare(etaB);
    })[0];

    // Check if already dismissed
    const notificationKey = `${pickup.id}_${pickup.delivery_time_eta}`;
    if (dismissedNotifications.has(notificationKey)) {
      return;
    }

    const store = stores.find(s => s?.id === pickup.store_id);
    const driver = appUsers.find(au => au?.user_id === pickup.driver_id);

    if (!store || !driver) return;

    // Check if driver is within 500m of store
    let hasArrived = false;
    if (driver.current_latitude && driver.current_longitude && store.latitude && store.longitude) {
      const distanceInMeters = calculateDistance(
        driver.current_latitude,
        driver.current_longitude,
        store.latitude,
        store.longitude
      );
      hasArrived = distanceInMeters <= 500;
    }

    // Calculate total minutes remaining until arrival (ETA)
    let minutesRemaining = null;
    if (pickup.delivery_time_eta) {
      const now = new Date();
      const [etaHours, etaMinutes] = pickup.delivery_time_eta.split(':').map(Number);
      const etaTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), etaHours, etaMinutes);
      const diffMs = etaTime - now;
      const diffMinutes = Math.max(0, Math.round(diffMs / 60000));
      minutesRemaining = `${diffMinutes} min`;
    }

    setActiveNotification({
      key: notificationKey,
      driverName: driver.user_name || 'Driver',
      storeName: store.name,
      eta: pickup.delivery_time_eta || pickup.delivery_time_start || 'N/A',
      minutesRemaining: minutesRemaining,
      hasArrived: hasArrived,
      pickupId: pickup.id
    });

  }, [deliveries, stores, appUsers, currentUser, isDispatcher, dismissedNotifications]);

  const handleDismiss = () => {
    if (activeNotification) {
      setDismissedNotifications(prev => new Set(prev).add(activeNotification.key));
      setActiveNotification(null);
    }
  };

  return (
    <AnimatePresence>
      {activeNotification && (
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          className="fixed top-4 right-4 z-[9999] max-w-md"
        >
          <div 
            className="bg-emerald-600 text-white rounded-xl shadow-2xl p-4 border-2 border-emerald-400"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3 flex-1">
                <div className="p-2 bg-white/20 rounded-lg">
                  <Truck className="w-5 h-5" />
                </div>
                
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold text-lg mb-1">
                    Your driver is on his way.
                  </h3>
                  <p className="text-sm text-emerald-50 mb-2">
                    <span className="font-semibold">{activeNotification.driverName}</span> is heading to <span className="font-semibold">{activeNotification.storeName}</span>
                  </p>
                  
                  <div className="flex items-center gap-4 text-sm">
                    <div className="flex items-center gap-1.5">
                      <Clock className="w-4 h-4" />
                      <span className="font-medium">ETA: {activeNotification.eta}</span>
                    </div>
                    
                    {activeNotification.minutesRemaining && (
                      <div className="flex items-center gap-1.5">
                        <Navigation className="w-4 h-4" />
                        <span className="font-medium">{activeNotification.minutesRemaining} remaining</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              
              <Button
                variant="ghost"
                size="icon"
                onClick={handleDismiss}
                className="h-8 w-8 text-white hover:bg-white/20 flex-shrink-0"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}