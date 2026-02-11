import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, CheckCircle, AlertCircle, DollarSign } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { format } from 'date-fns';

export default function StoreDeliveryNotification({ 
  deliveries, 
  stores, 
  appUsers,
  currentUser,
  isStoreUser 
}) {
  const [activeNotification, setActiveNotification] = useState(null);
  const [dismissedNotifications, setDismissedNotifications] = useState(new Set());

  useEffect(() => {
    if (!isStoreUser || !currentUser?.store_ids || !deliveries || !stores || !appUsers) {
      setActiveNotification(null);
      return;
    }

    const storeIds = new Set(currentUser.store_ids);
    const todayStr = format(new Date(), 'yyyy-MM-dd');

    // Find completed or failed deliveries for store's customers
    const completedDeliveries = deliveries.filter(d => {
      if (!d || d.delivery_date !== todayStr) return false;
      if (!d.patient_id) return false; // Must be a patient delivery (not pickup)
      if (!storeIds.has(d.store_id)) return false; // Must be store's delivery
      if (d.status !== 'completed' && d.status !== 'failed') return false; // Must be completed or failed
      return true;
    });

    if (completedDeliveries.length === 0) {
      setActiveNotification(null);
      return;
    }

    // Show the most recently updated one
    const delivery = completedDeliveries.sort((a, b) => {
      const timeA = new Date(a.updated_date || 0).getTime();
      const timeB = new Date(b.updated_date || 0).getTime();
      return timeB - timeA;
    })[0];

    // Check if already dismissed
    const notificationKey = `${delivery.id}_${delivery.updated_date}`;
    if (dismissedNotifications.has(notificationKey)) {
      return;
    }

    const store = stores.find(s => s?.id === delivery.store_id);
    const driver = appUsers.find(au => au?.id === delivery.driver_id);

    if (!store || !driver) return;

    // Find next incomplete delivery for this driver
    let nextDelivery = null;
    let nextRouteInfo = null;
    
    const driverDeliveries = deliveries.filter(d => 
      d && d.delivery_date === todayStr && d.driver_id === delivery.driver_id && d.patient_id
    );
    const incompleteDeliveries = driverDeliveries
      .filter(d => d.id !== delivery.id && d.status !== 'completed' && d.status !== 'failed' && d.status !== 'cancelled')
      .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
    
    if (incompleteDeliveries.length > 0) {
      nextDelivery = incompleteDeliveries[0];
      const sameStore = nextDelivery.store_id === delivery.store_id;
      const stopOrder = nextDelivery.stop_order || 1;
      const eta = nextDelivery.delivery_time_eta || nextDelivery.delivery_time_start || 'N/A';
      
      nextRouteInfo = {
        sameStore,
        stopOrder,
        patientName: nextDelivery.patient_name || 'Patient',
        eta: eta
      };
    }

    // Extract COD info
    let codInfo = null;
    if (delivery.cod_total_amount_required && delivery.cod_total_amount_required > 0) {
      if (delivery.cod_payments && delivery.cod_payments.length > 0) {
        const paymentTypes = delivery.cod_payments.map(p => p.type).join(', ');
        const totalCollected = delivery.cod_payments.reduce((sum, p) => sum + (p.amount || 0), 0);
        codInfo = {
          amount: delivery.cod_total_amount_required,
          collected: totalCollected,
          paymentTypes: paymentTypes
        };
      } else {
        codInfo = {
          amount: delivery.cod_total_amount_required,
          collected: 0,
          paymentTypes: 'None'
        };
      }
    }

    setActiveNotification({
      key: notificationKey,
      driverName: driver.user_name || 'Driver',
      patientName: delivery.patient_name || 'Patient',
      status: delivery.status,
      completionTime: delivery.actual_delivery_time ? format(new Date(delivery.actual_delivery_time), 'h:mm a') : 'N/A',
      codInfo: codInfo,
      nextRouteInfo: nextRouteInfo,
      deliveryId: delivery.id
    });

  }, [deliveries, stores, appUsers, currentUser, isStoreUser, dismissedNotifications]);

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
          className="fixed top-4 left-4 z-[9999] max-w-md"
        >
          <div 
            className={`text-white rounded-xl shadow-2xl p-4 border-2 ${
              activeNotification.status === 'completed' 
                ? 'bg-blue-600 border-blue-400' 
                : 'bg-red-600 border-red-400'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3 flex-1">
                <div className="p-2 bg-white/20 rounded-lg">
                  {activeNotification.status === 'completed' ? (
                    <CheckCircle className="w-5 h-5" />
                  ) : (
                    <AlertCircle className="w-5 h-5" />
                  )}
                </div>
                
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold text-lg mb-1">
                    {activeNotification.status === 'completed' ? 'Delivery Completed' : 'Delivery Failed'}
                  </h3>
                  <p className="text-sm mb-2">
                    <span className="font-semibold">{activeNotification.patientName}</span> by <span className="font-semibold">{activeNotification.driverName}</span>
                  </p>
                  
                  <div className="flex items-center gap-2 text-sm mb-2">
                    <span className="font-medium">Time: {activeNotification.completionTime}</span>
                  </div>

                  {activeNotification.codInfo && (
                    <div className="bg-white/10 rounded-lg p-2">
                      <div className="flex items-center gap-1.5 text-sm mb-1">
                        <DollarSign className="w-4 h-4" />
                        <span className="font-medium">COD: ${activeNotification.codInfo.amount}</span>
                      </div>
                      <div className="text-xs text-white/90">
                        Collected: ${activeNotification.codInfo.collected} via {activeNotification.codInfo.paymentTypes}
                      </div>
                    </div>
                  )}
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