import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Thermometer, ChevronUp, ChevronDown, X, CheckCircle, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { format } from 'date-fns';
import { base44 } from '@/api/base44Client';

const TEMP_MIN = 2;
const TEMP_MAX = 6;
const TEMP_PREFERRED = 4;
const READING_INTERVAL_MINUTES = 60;
const PROMPT_THRESHOLD_MINUTES = 50; // Prompt if ≥50 min since last reading

const STORAGE_KEY = 'rxdeliver_fridge_last_reading_time';

function getLastReadingFromDeliveries(fridgeDeliveries) {
  let latest = null;
  for (const d of fridgeDeliveries) {
    if (!Array.isArray(d.temperature_readings)) continue;
    for (const r of d.temperature_readings) {
      if (!latest || r.timestamp > latest.timestamp) {
        latest = r;
      }
    }
  }
  return latest;
}

function formatLocalTime(isoStr) {
  if (!isoStr) return '--:--';
  try {
    const d = new Date(isoStr);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return '--:--';
  }
}

export default function FridgeTempDialog({ currentUser, deliveries, isMobileDevice }) {
  const [showDialog, setShowDialog] = useState(false);
  const [tempValue, setTempValue] = useState(TEMP_PREFERRED);
  const [isSaving, setIsSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [lastReading, setLastReading] = useState(null);
  const [fridgeDeliveries, setFridgeDeliveries] = useState([]);
  const checkIntervalRef = useRef(null);
  const [lastReadingLoadedAt, setLastReadingLoadedAt] = useState(null);
  // Read synchronously from localStorage so it's available before any effect runs
  const dismissedAtRef = useRef(null);
  if (dismissedAtRef.current === null) {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) dismissedAtRef.current = parseInt(stored, 10);
    } catch {}
  }

  // Restricted to AppOwner only for testing
  const isAppOwner = currentUser?.role === 'admin';
  const isDriver = isAppOwner && (currentUser?.app_roles?.includes('driver') || currentUser?.app_roles?.includes('admin'));

  // Find active fridge deliveries for this driver today
  const activeFridgeDeliveries = React.useMemo(() => {
    if (!deliveries || !currentUser?.id) return [];
    const todayStr = format(new Date(), 'yyyy-MM-dd');
    return deliveries.filter((d) =>
      d &&
      d.fridge_item === true &&
      d.driver_id === currentUser.id &&
      d.delivery_date === todayStr &&
      !['completed', 'failed', 'cancelled'].includes(d.status)
    );
  }, [deliveries, currentUser?.id]);

  // Update local fridge deliveries when deliveries prop changes
  useEffect(() => {
    setFridgeDeliveries(activeFridgeDeliveries);
  }, [activeFridgeDeliveries]);

  // On mount: fetch the actual last reading from RxTempLogs DB
  useEffect(() => {
    if (!currentUser?.id || !isDriver) return;
    const todayStr = format(new Date(), 'yyyy-MM-dd');
    base44.entities.RxTempLogs.filter({ driver_id: currentUser.id, delivery_date: todayStr })
      .then((logs) => {
        let latest = null;
        (logs || []).forEach((log) => {
          (log.temperature_readings || []).forEach((r) => {
            if (!latest || r.timestamp > latest.timestamp) latest = r;
          });
        });
        if (latest) {
          setLastReading(latest);
          setTempValue(latest.temperature_celsius);
          // Sync the cooldown ref with the actual last recorded time
          const readingMs = new Date(latest.timestamp).getTime();
          if (!dismissedAtRef.current || readingMs > dismissedAtRef.current) {
            dismissedAtRef.current = readingMs;
            try { localStorage.setItem(STORAGE_KEY, String(readingMs)); } catch {}
          }
        }
        setLastReadingLoadedAt(Date.now());
      })
      .catch(() => setLastReadingLoadedAt(Date.now()));
  }, [currentUser?.id, isDriver]); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for external trigger (e.g. pickup completion with fridge items)
  useEffect(() => {
    const handler = () => {
      if (!isDriver) return;
      setShowDialog(true);
    };
    window.addEventListener('showFridgeTempDialog', handler);
    return () => window.removeEventListener('showFridgeTempDialog', handler);
  }, [isDriver]);

  const [manualInput, setManualInput] = useState('');

  const handleManualInputChange = (e) => {
    const val = e.target.value;
    setManualInput(val);
    const parsed = parseFloat(val);
    if (!isNaN(parsed)) setTempValue(parsed);
  };

  const handleStepChange = (delta) => {
    const next = Math.round((tempValue + delta) * 2) / 2;
    const clamped = Math.min(20, Math.max(-10, next));
    setTempValue(clamped);
    setManualInput(String(clamped));
  };

  const checkShouldPrompt = useCallback(() => {
    if (!isDriver) return;
    if (activeFridgeDeliveries.length === 0) return;

    // Use the most recent of: last saved reading time OR last dismiss time
    const lastActivityTime = dismissedAtRef.current || 0;
    if (lastActivityTime > 0) {
      const minutesSince = (Date.now() - lastActivityTime) / 60000;
      if (minutesSince < PROMPT_THRESHOLD_MINUTES) return;
    }

    // Also check deliveries for a reading timestamp (fallback)
    const latest = getLastReadingFromDeliveries(activeFridgeDeliveries);
    if (latest) {
      const minutesSinceLastReading = (Date.now() - new Date(latest.timestamp).getTime()) / 60000;
      if (minutesSinceLastReading < PROMPT_THRESHOLD_MINUTES) return;
    }

    setShowDialog(true);
  }, [isDriver, activeFridgeDeliveries]);

  // Check only after DB load completes, then every 5 minutes
  useEffect(() => {
    if (lastReadingLoadedAt === null) return; // wait for DB read before prompting
    checkShouldPrompt();
    clearInterval(checkIntervalRef.current);
    checkIntervalRef.current = setInterval(checkShouldPrompt, 5 * 60 * 1000);
    return () => clearInterval(checkIntervalRef.current);
  }, [checkShouldPrompt, lastReadingLoadedAt]);

  // When any temp is recorded (BLE or manual from another component), reset the cooldown
  useEffect(() => {
    const handler = (e) => {
      if (!currentUser?.id) return;
      const { driverId } = e.detail || {};
      if (driverId && driverId !== currentUser.id) return;
      dismissedAtRef.current = Date.now();
      try { localStorage.setItem(STORAGE_KEY, String(dismissedAtRef.current)); } catch {}
      setShowDialog(false);
    };
    window.addEventListener('fridgeTempRecorded', handler);
    return () => window.removeEventListener('fridgeTempRecorded', handler);
  }, [currentUser?.id]);

  const handleSave = async () => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      const todayStr = format(new Date(), 'yyyy-MM-dd');
      const now = new Date();
      const localTimestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

      const res = await base44.functions.invoke('recordFridgeTemperature', {
        temperatureCelsius: tempValue,
        deliveryDate: todayStr,
        driverId: currentUser.id,
        timestamp: localTimestamp
      });

      const data = res?.data || res;
      if (data?.error) throw new Error(data.error);

      const newReading = { timestamp: localTimestamp, temperature_celsius: tempValue, recorded_by_driver_id: currentUser.id };
      setLastReading(newReading);
      // Persist so checkShouldPrompt won't re-fire for another hour
      dismissedAtRef.current = Date.now();
      try { localStorage.setItem(STORAGE_KEY, String(dismissedAtRef.current)); } catch {}
      setSavedSuccess(true);

      // Dispatch event so dispatchers get notified
      window.dispatchEvent(new CustomEvent('fridgeTempRecorded', {
        detail: {
          temperature: tempValue,
          driverId: currentUser.id,
          driverName: currentUser.full_name || currentUser.user_name || 'Driver',
          timestamp: localTimestamp,
          isOutOfRange: data?.isOutOfRange || false,
          updatedDeliveryIds: activeFridgeDeliveries.map((d) => d.id)
        }
      }));

      setTimeout(() => {
        setSavedSuccess(false);
        setShowDialog(false);
      }, 1500);
    } catch (err) {
      console.error('[FridgeTempDialog] Save failed:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDismiss = () => {
    dismissedAtRef.current = Date.now();
    try { localStorage.setItem(STORAGE_KEY, String(dismissedAtRef.current)); } catch {}
    setShowDialog(false);
  };

  const isOutOfRange = tempValue < TEMP_MIN || tempValue > TEMP_MAX;
  const tempColor = isOutOfRange ? 'text-red-600' : tempValue === TEMP_PREFERRED ? 'text-emerald-600' : 'text-blue-600';
  const bgColor = isOutOfRange ? 'bg-red-50 border-red-300' : 'bg-cyan-50 border-cyan-300';

  if (!isDriver || activeFridgeDeliveries.length === 0) return null;

  return createPortal(
    <AnimatePresence>
      {showDialog && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.18 }}
          className="fixed z-[9000] flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.4)', top: 0, left: 0, right: 0, bottom: 0 }}
          onClick={(e) => { if (e.target === e.currentTarget) handleDismiss(); }}
        >
        <div className="w-full max-w-sm">
          <div className={`rounded-xl border-2 shadow-lg p-4 ${bgColor}`}>
            <div className="flex items-start justify-between gap-2 mb-3">
              <div className="flex items-center gap-2">
                <Thermometer className="w-5 h-5 text-cyan-600 flex-shrink-0" />
                <div>
                  <h4 className="font-bold text-slate-900 text-sm leading-tight">Cooler Temperature Check</h4>
                  {lastReading ? (
                    <p className="text-xs text-slate-500 mt-0.5">
                      Last: <span className="font-semibold">{lastReading.temperature_celsius}°C</span> at {formatLocalTime(lastReading.timestamp)}
                    </p>
                  ) : (
                    <p className="text-xs text-slate-500 mt-0.5">No reading recorded yet today</p>
                  )}
                </div>
              </div>
              <button
                onClick={handleDismiss}
                className="text-slate-400 hover:text-slate-600 flex-shrink-0 p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex items-center justify-center gap-4 mb-3">
              <button
                onClick={() => handleStepChange(-0.5)}
                className="w-12 h-12 rounded-full bg-white border-2 border-slate-200 hover:border-cyan-400 flex items-center justify-center shadow-sm active:scale-95 transition-transform"
              >
                <ChevronDown className="w-6 h-6 text-slate-600" />
              </button>

              <div className="text-center">
                <div className={`text-4xl font-bold tabular-nums ${tempColor}`}>
                  {tempValue}°C
                </div>
                <div className="text-xs text-slate-500 mt-0.5">Target: {TEMP_MIN}–{TEMP_MAX}°C</div>
              </div>

              <button
                onClick={() => handleStepChange(0.5)}
                className="w-12 h-12 rounded-full bg-white border-2 border-slate-200 hover:border-cyan-400 flex items-center justify-center shadow-sm active:scale-95 transition-transform"
              >
                <ChevronUp className="w-6 h-6 text-slate-600" />
              </button>
            </div>

            <div className="flex items-center gap-2 mb-3">
              <label className="text-xs text-slate-500 whitespace-nowrap">Manual entry:</label>
              <Input
                type="number"
                step="0.5"
                value={manualInput}
                onChange={handleManualInputChange}
                placeholder={String(tempValue)}
                className="h-9 text-sm text-center"
              />
              <span className="text-xs text-slate-500">°C</span>
            </div>

            {isOutOfRange && (
              <div className="flex items-center gap-1.5 text-red-700 text-xs font-semibold mb-2 bg-red-100 rounded-lg px-2 py-1.5">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                Outside safe range ({TEMP_MIN}–{TEMP_MAX}°C)! Please check cooler.
              </div>
            )}

            <div className="text-xs text-slate-500 mb-3">
              {activeFridgeDeliveries.length} fridge item{activeFridgeDeliveries.length !== 1 ? 's' : ''} in transit
            </div>

            <Button
              onClick={handleSave}
              disabled={isSaving || savedSuccess}
              className={`w-full h-11 font-semibold ${
                savedSuccess
                  ? 'bg-emerald-600 hover:bg-emerald-600'
                  : isOutOfRange
                    ? 'bg-red-600 hover:bg-red-700'
                    : 'bg-cyan-600 hover:bg-cyan-700'
              } text-white`}
            >
              {savedSuccess ? (
                <><CheckCircle className="w-4 h-4 mr-1.5" /> Recorded</>
              ) : isSaving ? (
                'Saving...'
              ) : (
                `Record ${tempValue}°C`
              )}
            </Button>
          </div>
        </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}