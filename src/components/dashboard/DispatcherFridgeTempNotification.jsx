import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Thermometer, X, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { format } from 'date-fns';

const TEMP_MIN = 2;
const TEMP_MAX = 6;

function formatLocalTime(isoStr) {
  if (!isoStr) return '--:--';
  try {
    const d = new Date(isoStr);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch { return '--:--'; }
}

export default function DispatcherFridgeTempNotification({ currentUser, deliveries, appUsers, stores }) {
  const [activeNotification, setActiveNotification] = useState(null);
  const [dismissedKeys, setDismissedKeys] = useState(new Set());

  // Restricted to AppOwner only for testing
  const isAppOwner = currentUser?.role === 'admin';
  const isDispatcher = isAppOwner;
  const dispatcherStoreIds = currentUser?.store_ids || [];

  // Listen for driver recordings (same-browser scenario)
  useEffect(() => {
    const handleDriverRecorded = (e) => {
      if (!isDispatcher || dispatcherStoreIds.length === 0) return;
      const { temperature, driverName, timestamp, isOutOfRange, driverId } = e.detail || {};

      // Check if this driver has any deliveries for our stores
      const todayStr = format(new Date(), 'yyyy-MM-dd');
      const hasStoreDelivery = (deliveries || []).some(
        (d) => d && d.driver_id === driverId && d.delivery_date === todayStr &&
          dispatcherStoreIds.includes(d.store_id) && d.fridge_item === true
      );
      if (!hasStoreDelivery) return;

      const key = `${driverId}_${timestamp}`;
      if (dismissedKeys.has(key)) return;

      setActiveNotification({ key, temperature, driverName, timestamp, isOutOfRange });
    };

    window.addEventListener('fridgeTempRecorded', handleDriverRecorded);
    return () => window.removeEventListener('fridgeTempRecorded', handleDriverRecorded);
  }, [isDispatcher, dispatcherStoreIds, deliveries, dismissedKeys]);

  // Also detect new readings via deliveries data update (cross-device)
  useEffect(() => {
    if (!isDispatcher || dispatcherStoreIds.length === 0 || !deliveries) return;
    const todayStr = format(new Date(), 'yyyy-MM-dd');

    // Find all fridge deliveries for our stores today
    const relevantFridgeDeliveries = deliveries.filter(
      (d) => d && d.fridge_item === true && d.delivery_date === todayStr &&
        dispatcherStoreIds.includes(d.store_id)
    );

    // Get the most recent reading across all relevant fridge deliveries
    let latestReading = null;
    let latestDriverId = null;
    for (const d of relevantFridgeDeliveries) {
      if (!Array.isArray(d.temperature_readings)) continue;
      for (const r of d.temperature_readings) {
        if (!latestReading || r.timestamp > latestReading.timestamp) {
          latestReading = r;
          latestDriverId = d.driver_id;
        }
      }
    }

    if (!latestReading) return;

    const key = `${latestDriverId}_${latestReading.timestamp}`;
    if (dismissedKeys.has(key)) return;

    // Only show if the reading is < 3 minutes old (fresh)
    const ageMinutes = (Date.now() - new Date(latestReading.timestamp).getTime()) / 60000;
    if (ageMinutes > 3) return;

    const driver = (appUsers || []).find((au) => au?.user_id === latestDriverId);
    const driverName = driver?.user_name || 'Driver';
    const isOutOfRange = latestReading.temperature_celsius < TEMP_MIN || latestReading.temperature_celsius > TEMP_MAX;

    setActiveNotification({
      key,
      temperature: latestReading.temperature_celsius,
      driverName,
      timestamp: latestReading.timestamp,
      isOutOfRange
    });
  }, [deliveries, isDispatcher, dispatcherStoreIds, appUsers, dismissedKeys]);

  const handleDismiss = () => {
    if (activeNotification) {
      setDismissedKeys((prev) => new Set(prev).add(activeNotification.key));
      setActiveNotification(null);
    }
  };

  // Auto-dismiss after 12 seconds
  useEffect(() => {
    if (!activeNotification) return;
    const t = setTimeout(handleDismiss, 12000);
    return () => clearTimeout(t);
  }, [activeNotification?.key]);

  if (!isDispatcher) return null;

  return (
    <AnimatePresence>
      {activeNotification && (
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          className="fixed top-4 right-4 z-[9999] max-w-sm w-[calc(100%-2rem)] sm:w-80"
        >
          <div className={`rounded-xl border-2 shadow-2xl p-4 ${
            activeNotification.isOutOfRange
              ? 'bg-red-600 border-red-400 text-white'
              : 'bg-blue-600 border-blue-400 text-white'
          }`}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3 flex-1">
                <div className="p-2 bg-white/20 rounded-lg flex-shrink-0">
                  {activeNotification.isOutOfRange
                    ? <AlertTriangle className="w-5 h-5" />
                    : <Thermometer className="w-5 h-5" />
                  }
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold text-lg leading-tight">
                    {activeNotification.isOutOfRange ? '⚠️ Temp Out of Range!' : 'Cooler Temp Recorded'}
                  </h3>
                  <p className="text-sm opacity-90 mt-0.5">
                    <span className="font-semibold">{activeNotification.driverName}</span> recorded{' '}
                    <span className="font-bold text-lg">{activeNotification.temperature}°C</span>
                    {activeNotification.isOutOfRange && (
                      <span className="block text-xs mt-0.5 font-semibold opacity-90">
                        Safe range: {TEMP_MIN}–{TEMP_MAX}°C
                      </span>
                    )}
                  </p>
                  <p className="text-xs opacity-75 mt-1">at {formatLocalTime(activeNotification.timestamp)}</p>
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