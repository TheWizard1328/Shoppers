import React, { useState, useEffect } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { base44 } from '@/api/base44Client';
import { AlertTriangle, Navigation, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

/**
 * Dynamic Re-routing Alert Component
 * Monitors route conditions and suggests re-optimization when beneficial
 */
export default function DynamicReroutingAlert({ 
  driverId, 
  deliveryDate, 
  deliveries,
  currentLocation,
  onRerouteTriggered
}) {
  const [showAlert, setShowAlert] = useState(false);
  const [alertMessage, setAlertMessage] = useState('');
  const [isRerouting, setIsRerouting] = useState(false);
  const [lastCheckTime, setLastCheckTime] = useState(null);

  useEffect(() => {
    if (!driverId || !deliveryDate || !deliveries?.length) return;

    const checkForReroutingNeeds = async () => {
      try {
        const now = new Date();
        
        // Don't check more than once every 10 minutes
        if (lastCheckTime && (now - lastCheckTime) < 600000) return;
        
        setLastCheckTime(now);

        const incompleteDeliveries = deliveries.filter(d => 
          d && !['completed', 'failed', 'cancelled', 'returned'].includes(d.status)
        );

        if (incompleteDeliveries.length === 0) return;

        // Check for time window risks
        const currentTimeMinutes = now.getHours() * 60 + now.getMinutes();
        const urgentDeliveries = incompleteDeliveries.filter(d => {
          if (!d.time_window_end) return false;
          const [hours, minutes] = d.time_window_end.split(':').map(Number);
          const windowEnd = hours * 60 + minutes;
          const etaParts = d.delivery_time_eta?.split(':').map(Number);
          const etaMinutes = etaParts ? etaParts[0] * 60 + etaParts[1] : windowEnd + 100;
          
          // Alert if ETA is past window or very close
          return etaMinutes > windowEnd - 15;
        });

        if (urgentDeliveries.length > 0) {
          setAlertMessage(`${urgentDeliveries.length} deliveries at risk of missing time windows. Re-route recommended.`);
          setShowAlert(true);
          return;
        }

        // Check for significant delays (next delivery ETA is > 30 min from now but driver is on duty)
        const nextDelivery = incompleteDeliveries.find(d => d.isNextDelivery);
        if (nextDelivery?.delivery_time_eta) {
          const etaParts = nextDelivery.delivery_time_eta.split(':').map(Number);
          const etaMinutes = etaParts[0] * 60 + etaParts[1];
          const minutesUntilETA = etaMinutes - currentTimeMinutes;
          
          if (minutesUntilETA > 30 && incompleteDeliveries.length > 3) {
            setAlertMessage('Traffic delay detected. Re-routing could save time.');
            setShowAlert(true);
          }
        }
      } catch (error) {
        console.warn('Re-routing check failed:', error);
      }
    };

    // Check every 5 minutes
    const interval = setInterval(checkForReroutingNeeds, 300000);
    
    // Initial check after 30 seconds
    const initialTimer = setTimeout(checkForReroutingNeeds, 30000);

    return () => {
      clearInterval(interval);
      clearTimeout(initialTimer);
    };
  }, [driverId, deliveryDate, deliveries, lastCheckTime]);

  const handleReroute = async () => {
    setIsRerouting(true);
    try {
      await base44.functions.invoke('aiRouteOptimizer', {
        driverId,
        deliveryDate,
        currentLocation,
        trigger: 'traffic_alert',
        enableAIAnalysis: true
      });

      if (onRerouteTriggered) {
        onRerouteTriggered();
      }

      setShowAlert(false);
    } catch (error) {
      console.error('Re-routing failed:', error);
    } finally {
      setIsRerouting(false);
    }
  };

  return (
    <AnimatePresence>
      {showAlert && (
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          className="fixed top-20 left-1/2 -translate-x-1/2 z-[9999] max-w-md w-full px-4"
        >
          <Alert className="bg-gradient-to-r from-orange-50 to-red-50 border-orange-300 shadow-lg">
            <AlertTriangle className="w-5 h-5 text-orange-600" />
            <AlertDescription className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <p className="font-semibold text-orange-900 mb-2">Route Optimization Recommended</p>
                <p className="text-sm text-orange-800">{alertMessage}</p>
              </div>
              <div className="flex flex-col gap-2">
                <Button
                  onClick={handleReroute}
                  disabled={isRerouting}
                  size="sm"
                  className="bg-orange-600 hover:bg-orange-700 whitespace-nowrap"
                >
                  {isRerouting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <>
                      <Navigation className="w-4 h-4 mr-1" />
                      Re-route
                    </>
                  )}
                </Button>
                <Button
                  onClick={() => setShowAlert(false)}
                  variant="ghost"
                  size="sm"
                  className="text-slate-600"
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        </motion.div>
      )}
    </AnimatePresence>
  );
}