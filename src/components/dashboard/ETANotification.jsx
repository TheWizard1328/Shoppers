import React, { useEffect, useState } from 'react';
import { Bell, Clock, TrendingUp, TrendingDown, AlertTriangle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { format } from 'date-fns';

/**
 * Real-time ETA notification system
 * Monitors ETA changes and alerts users about significant delays or improvements
 */
export default function ETANotification({ 
  deliveries = [], 
  driverId, 
  onDismiss 
}) {
  const [notification, setNotification] = useState(null);
  const [previousETAs, setPreviousETAs] = useState(new Map());

  useEffect(() => {
    if (!deliveries || deliveries.length === 0) return;

    // Check for significant ETA changes
    deliveries.forEach(delivery => {
      if (!delivery || !delivery.delivery_time_eta) return;

      const currentETA = delivery.delivery_time_eta;
      const previousETA = previousETAs.get(delivery.id);

      if (previousETA && previousETA !== currentETA) {
        // Calculate time difference in minutes using local device time
        const today = new Date();
        const dateStr = today.toISOString().split('T')[0];
        
        const [prevHours, prevMinutes] = previousETA.split(':').map(Number);
        const [currHours, currMinutes] = currentETA.split(':').map(Number);
        
        // Create Date objects in local time
        const prevDate = new Date(dateStr + 'T' + previousETA + ':00');
        const currDate = new Date(dateStr + 'T' + currentETA + ':00');
        
        const diffMinutes = Math.round((currDate - prevDate) / (1000 * 60));

        // Only notify for changes > 5 minutes
        if (Math.abs(diffMinutes) >= 5) {
          const isDelay = diffMinutes > 0;
          
          setNotification({
            id: Date.now(),
            deliveryId: delivery.delivery_id,
            patientName: delivery.patient_name,
            oldEta: previousETA,
            newEta: currentETA,
            diffMinutes,
            isDelay,
            type: Math.abs(diffMinutes) >= 15 ? 'critical' : 'warning'
          });

          // Auto-dismiss after 8 seconds
          setTimeout(() => {
            setNotification(null);
          }, 8000);
        }
      }

      // Update ETA map
      setPreviousETAs(prev => new Map(prev).set(delivery.id, currentETA));
    });
  }, [deliveries]);

  if (!notification) return null;

  const { isDelay, diffMinutes, type, patientName, deliveryId, oldEta, newEta } = notification;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -50, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -50, scale: 0.95 }}
        className="fixed top-4 left-1/2 -translate-x-1/2 z-[10000] max-w-md w-full px-4"
      >
        <div 
          className={`rounded-xl shadow-2xl p-4 border-2 ${
            type === 'critical' 
              ? 'bg-red-50 border-red-500' 
              : isDelay 
                ? 'bg-yellow-50 border-yellow-500' 
                : 'bg-green-50 border-green-500'
          }`}
        >
          <div className="flex items-start gap-3">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${
              type === 'critical' 
                ? 'bg-red-100' 
                : isDelay 
                  ? 'bg-yellow-100' 
                  : 'bg-green-100'
            }`}>
              {type === 'critical' ? (
                <AlertTriangle className="w-5 h-5 text-red-600" />
              ) : isDelay ? (
                <TrendingUp className="w-5 h-5 text-yellow-600" />
              ) : (
                <TrendingDown className="w-5 h-5 text-green-600" />
              )}
            </div>

            <div className="flex-1 min-w-0">
              <h4 className={`font-bold text-sm mb-1 ${
                type === 'critical' 
                  ? 'text-red-900' 
                  : isDelay 
                    ? 'text-yellow-900' 
                    : 'text-green-900'
              }`}>
                ETA {isDelay ? 'Delayed' : 'Improved'}
              </h4>
              
              <p className="text-sm text-slate-700 mb-2">
                <span className="font-semibold">{deliveryId}</span>
                {patientName && <span className="text-slate-600"> • {patientName}</span>}
              </p>

              <div className="flex items-center gap-4 text-xs">
                <div>
                  <span className="text-slate-500">Previous:</span>
                  <span className="font-mono font-semibold ml-1 text-slate-700">{oldEta}</span>
                </div>
                <div>
                  <span className="text-slate-500">Updated:</span>
                  <span className={`font-mono font-semibold ml-1 ${
                    isDelay ? 'text-red-700' : 'text-green-700'
                  }`}>{newEta}</span>
                </div>
              </div>

              <div className={`text-xs font-semibold mt-2 ${
                isDelay ? 'text-yellow-700' : 'text-green-700'
              }`}>
                {isDelay ? '+' : ''}{diffMinutes} minutes
              </div>
            </div>

            <button
              onClick={() => {
                setNotification(null);
                if (onDismiss) onDismiss();
              }}
              className="text-slate-400 hover:text-slate-600 transition-colors flex-shrink-0"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}