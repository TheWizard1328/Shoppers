import React, { useEffect, useState } from 'react';
import { Bell, Clock, TrendingUp, TrendingDown, AlertTriangle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { format } from 'date-fns';
import { useAppData } from '../utils/AppDataContext';

/**
 * Real-time ETA notification system
 * Monitors ETA changes and alerts users about significant delays or improvements
 * Works with local time strings (HH:mm) - no timezone conversion needed
 */
export default function ETANotification({ 
  deliveries = [], 
  driverId,
  currentUser,
  onDismiss 
}) {
  const { updateDeliveriesLocally } = useAppData();
  const [notification, setNotification] = useState(null);
  const [previousETAs, setPreviousETAs] = useState(new Map());

  // Define finished statuses to exclude from ETA notifications
  const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];

  useEffect(() => {
    if (!deliveries || deliveries.length === 0) return;
    
    // CRITICAL: Only show ETA notifications to drivers, not dispatchers
    if (!currentUser) return;
    
    // Check if user has driver role
    const hasDriverRole = currentUser.app_roles && Array.isArray(currentUser.app_roles) && currentUser.app_roles.includes('driver');
    const hasDispatcherRole = currentUser.app_roles && Array.isArray(currentUser.app_roles) && currentUser.app_roles.includes('dispatcher');
    
    if (!hasDriverRole || (hasDispatcherRole && !hasDriverRole)) return;

    // Check for significant ETA changes - ONLY for in-transit deliveries
    deliveries.forEach(delivery => {
      if (!delivery || !delivery.delivery_time_eta) return;
      
      // CRITICAL: Only show ETA notifications for in-transit deliveries (skip finished, pending, and en_route)
      if (delivery.status !== 'in_transit') return;

      const currentETA = delivery.delivery_time_eta;
      const previousETA = previousETAs.get(delivery.id);

      if (previousETA && previousETA !== currentETA) {
        try { updateDeliveriesLocally && updateDeliveriesLocally([{ ...delivery, delivery_time_eta: currentETA }], false); } catch (_) {}
        try {
          // Parse HH:mm time strings
          const [prevHours, prevMinutes] = previousETA.split(':').map(Number);
          const [currHours, currMinutes] = currentETA.split(':').map(Number);
          
          // Convert to total minutes for comparison
          const prevTotalMinutes = prevHours * 60 + prevMinutes;
          const currTotalMinutes = currHours * 60 + currMinutes;
          
          const diffMinutes = currTotalMinutes - prevTotalMinutes;

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
        } catch (error) {
          console.error('Error parsing ETA times:', error);
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
        className="fixed top-20 z-[10000] left-4 right-4 mx-auto max-w-[28rem] lg:left-auto lg:right-4 lg:mx-0"
      >
        <div 
          className={`rounded-xl shadow-2xl p-4 border-2 ${
            type === 'critical' 
              ? 'border-red-500' 
              : isDelay 
                ? 'border-yellow-500' 
                : 'border-green-500'
          }`}
          style={{
            background: type === 'critical' 
              ? 'var(--bg-white)' 
              : isDelay 
                ? 'var(--bg-white)' 
                : 'var(--bg-white)'
          }}
        >
          <div className="flex items-start gap-3">
            <div 
              className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
              style={{
                background: type === 'critical' 
                  ? 'var(--bg-slate-100)' 
                  : isDelay 
                    ? 'var(--bg-slate-100)' 
                    : 'var(--bg-slate-100)'
              }}
            >
              {type === 'critical' ? (
                <AlertTriangle className="w-5 h-5 text-red-600" />
              ) : isDelay ? (
                <TrendingUp className="w-5 h-5 text-yellow-600" />
              ) : (
                <TrendingDown className="w-5 h-5 text-green-600" />
              )}
            </div>

            <div className="flex-1 min-w-0">
              <h4 
                className="font-bold text-sm mb-1"
                style={{
                  color: type === 'critical' 
                    ? '#dc2626' 
                    : isDelay 
                      ? '#ca8a04' 
                      : '#16a34a'
                }}
              >
                ETA {isDelay ? 'Delayed' : 'Improved'}
              </h4>
              
              <p className="text-sm mb-2" style={{ color: 'var(--text-slate-700)' }}>
                {patientName && <span className="font-semibold">{patientName}</span>}
              </p>

              <div className="flex items-center gap-4 text-xs">
                <div>
                  <span style={{ color: 'var(--text-slate-500)' }}>Previous:</span>
                  <span className="font-mono font-semibold ml-1" style={{ color: 'var(--text-slate-700)' }}>{oldEta}</span>
                </div>
                <div>
                  <span style={{ color: 'var(--text-slate-500)' }}>Updated:</span>
                  <span className={`font-mono font-semibold ml-1 ${
                    isDelay ? 'text-red-600' : 'text-green-600'
                  }`}>{newEta}</span>
                </div>
              </div>

              <div className={`text-xs font-semibold mt-2 ${
                isDelay ? 'text-yellow-600' : 'text-green-600'
              }`}>
                {isDelay ? '+' : ''}{diffMinutes} minutes
              </div>
            </div>

            <button
              onClick={() => {
                setNotification(null);
                if (onDismiss) onDismiss();
              }}
              className="transition-colors flex-shrink-0"
              style={{ color: 'var(--text-slate-400)' }}
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