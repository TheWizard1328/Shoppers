import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Truck, Clock, Navigation } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { format } from 'date-fns';

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

    // Calculate travel time (simple approximation based on distance if available)
    let travelTime = null;
    if (pickup.travel_dist && pickup.travel_dist > 0) {
      // Assume 40 km/h average speed
      const travelMinutes = Math.round((pickup.travel_dist / 40) * 60);
      travelTime = `${travelMinutes} min`;
    }

    setActiveNotification({
      key: notificationKey,
      driverName: driver.user_name || 'Driver',
      storeName: store.name,
      eta: pickup.delivery_time_eta || pickup.delivery_time_start || 'N/A',
      travelTime: travelTime,
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
          className="fixed top-20 left-1/2 -translate-x-1/2 z-[9999] max-w-md w-full mx-4"
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
                  
                  <div className="flex items-center gap-4 text-sm">
                    <div className="flex items-center gap-1.5">
                      <Clock className="w-4 h-4" />
                      <span className="font-medium">ETA: {activeNotification.eta}</span>
                    </div>
                    
                    {activeNotification.travelTime && (
                      <div className="flex items-center gap-1.5">
                        <Navigation className="w-4 h-4" />
                        <span className="font-medium">{activeNotification.travelTime}</span>
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