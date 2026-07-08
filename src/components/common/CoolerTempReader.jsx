import React, { useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Thermometer, Bluetooth, BluetoothSearching,
  AlertTriangle, CheckCircle2, X, Loader2, Wifi
} from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "sonner";
import { useInkbirdSensor } from "./useInkbirdSensor";

const TEMP_MIN_C = 2;
const TEMP_MAX_C = 8;

/**
 * CoolerTempReader
 *
 * Props:
 *   delivery    – current delivery record
 *   currentUser – auth user
 *   onDone      – called after save or skip
 *   actionLabel – "Arrived" | "Completed" | "Failed"
 *   sensorHook  – (optional) already-running useInkbirdSensor instance from
 *                 StopCard. When provided, we reuse the existing BLE connection
 *                 instead of spinning up a new one — the reading may already be
 *                 live by the time this dialog opens.
 */
export default function CoolerTempReader({ delivery, currentUser, onDone, actionLabel = "Arrived", sensorHook }) {
  // Use the passed-in hook if available, otherwise own instance as fallback
  const ownHook  = useInkbirdSensor(sensorHook ? null : currentUser);
  const { status, reading, sensorName, connect } = sensorHook || ownHook;

  const [manualTemp, setManualTemp] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [isSaving,   setIsSaving]   = useState(false);

  // ── Save reading ──────────────────────────────────────────────────────────
  const saveTemp = useCallback(async (tempCelsius, inputMethod) => {
    setIsSaving(true);
    try {
      // Always write to today's LOCAL date — delivery_date can be a UTC string
      // that resolves to yesterday in local time. Build YYYY-MM-DD from wall clock.
      const _now = new Date();
      const _pad = n => String(n).padStart(2, '0');
      const _todayLocal = `${_now.getFullYear()}-${_pad(_now.getMonth() + 1)}-${_pad(_now.getDate())}`;
      // Driver is always the delivery's assigned driver (or current user if not set)
      const _driverId = delivery?.driver_id || currentUser?.id;
      await base44.functions.invoke('recordFridgeTemperature', {
        temperatureCelsius: Number(tempCelsius),
        deliveryDate: _todayLocal,
        driverId:     _driverId,
        timestamp:    (() => { const d=new Date(),p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; })(),
        trigger:      actionLabel.toLowerCase(),
        input_method: inputMethod,
        sensor_id:    inputMethod === 'ble' ? sensorName : null,
      });

      const isOut = Number(tempCelsius) < TEMP_MIN_C || Number(tempCelsius) > TEMP_MAX_C;
      if (isOut) {
        toast.warning(`⚠️ Cooler temp ${tempCelsius}°C is outside target range (${TEMP_MIN_C}–${TEMP_MAX_C}°C)`);
      } else {
        toast.success(`✓ Cooler temp recorded: ${tempCelsius}°C`);
      }
      onDone?.();
    } catch (err) {
      toast.error(`Failed to save temperature: ${err?.message}`);
      setIsSaving(false);
    }
  }, [delivery, currentUser, actionLabel, sensorName, onDone]);

  const skip = useCallback(() => onDone?.(), [onDone]);

  const tempColor = (t) => {
    if (t == null) return 'text-slate-700';
    return (t < TEMP_MIN_C || t > TEMP_MAX_C) ? 'text-red-600' : 'text-emerald-600';
  };

  const hasReading  = reading?.tempC != null;
  const showConfirm = hasReading && !showManual;
  const isActive    = ['connecting', 'reading', 'auto-connecting'].includes(status);

  // ── Status badge ──────────────────────────────────────────────────────────
  const statusBadge = () => {
    if (isActive) return (
      <span className="flex items-center gap-1 text-xs text-cyan-600">
        <BluetoothSearching className="w-3.5 h-3.5 animate-pulse" />
        {status === 'connecting' ? 'Pairing…' : 'Reading…'}
      </span>
    );
    if (status === 'connected' && sensorName) return (
      <span className="flex items-center gap-1 text-xs text-emerald-600">
        <Wifi className="w-3.5 h-3.5" /> {sensorName}
      </span>
    );
    if (status === 'disconnected') return (
      <span className="text-xs text-amber-500">Reconnecting…</span>
    );
    return null;
  };

  // ─────────────────────────────────────────────────────────────────────────
  return createPortal(
    <div className="fixed inset-0 z-[9500] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <div className="flex items-center gap-2">
            <Thermometer className="w-5 h-5 text-cyan-600" />
            <span className="font-semibold text-slate-800">Cooler Temp</span>
          </div>
          <div className="flex items-center gap-3">
            {statusBadge()}
            <button onClick={skip} className="text-slate-400 hover:text-slate-600">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="px-5 pb-6 space-y-4">

          {/* ── Non-primary device — manual entry only ── */}
          {status === 'non-primary' && !showManual && (
            <div className="space-y-3">
              <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 text-sm text-slate-600 flex items-start gap-2">
                <Bluetooth className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                <span>Bluetooth sensor not available on this device. Enter temperature manually.</span>
              </div>
              <button onClick={() => setShowManual(true)}
                className="w-full text-center text-sm text-cyan-600 hover:text-cyan-700 font-medium">
                Enter temperature manually
              </button>
            </div>
          )}

          {/* ── First-time pair ── */}
          {status === 'idle' && !hasReading && !showManual && (
            <div className="space-y-4">
              <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 text-center space-y-2">
                <Bluetooth className="w-10 h-10 text-cyan-400 mx-auto" />
                <p className="text-sm text-slate-700 font-medium">Connect your Inkbird sensor</p>
                <p className="text-xs text-slate-500">
                  One time only — it connects automatically every delivery after this.
                </p>
              </div>
              <Button className="w-full bg-cyan-600 hover:bg-cyan-700 text-white" onClick={connect}>
                <Bluetooth className="w-4 h-4 mr-2" /> Connect Sensor
              </Button>
              <button onClick={() => setShowManual(true)}
                className="w-full text-center text-xs text-slate-400 hover:text-slate-600">
                Enter temperature manually instead
              </button>
            </div>
          )}

          {/* ── Waiting for gesture / reading in background ── */}
          {(status === 'waiting-gesture' || isActive) && !hasReading && !showManual && (
            <div className="flex flex-col items-center gap-3 py-6">
              <BluetoothSearching className="w-10 h-10 text-cyan-400 animate-pulse" />
              <p className="text-slate-500 text-sm text-center">Reading cooler temperature…</p>
              <button onClick={() => setShowManual(true)}
                className="text-xs text-slate-400 hover:text-slate-600 mt-1">
                Enter manually
              </button>
            </div>
          )}

          {/* ── Confirm BLE reading ── */}
          {showConfirm && (
            <div className="space-y-4">
              <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 text-center space-y-1">
                <p className="text-xs text-slate-500 uppercase tracking-wide">Cooler temperature</p>
                <p className={`text-5xl font-bold ${tempColor(reading.tempC)}`}>
                  {reading.tempC}°C
                </p>
                {reading.humidity != null && (
                  <p className="text-sm text-slate-500">Humidity: {reading.humidity}%</p>
                )}
                {(reading.tempC < TEMP_MIN_C || reading.tempC > TEMP_MAX_C) && (
                  <div className="flex items-center justify-center gap-1 text-red-500 text-xs mt-1">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    Outside target range ({TEMP_MIN_C}–{TEMP_MAX_C}°C)
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1 text-sm"
                  onClick={() => setShowManual(true)}>Edit</Button>
                <Button className="flex-1 bg-cyan-600 hover:bg-cyan-700 text-white text-sm"
                  disabled={isSaving} onClick={() => saveTemp(reading.tempC, 'ble')}>
                  {isSaving
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <><CheckCircle2 className="w-4 h-4 mr-1" /> Confirm</>}
                </Button>
              </div>
            </div>
          )}

          {/* ── Manual entry ── */}
          {showManual && (
            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-500 mb-1 block">
                  Enter cooler temperature (°C)
                </label>
                <Input
                  type="number" step="0.1" placeholder="e.g. 4.5"
                  value={manualTemp}
                  onChange={e => setManualTemp(e.target.value)}
                  className="text-center text-lg font-semibold"
                  autoFocus
                />
                {manualTemp !== '' && (Number(manualTemp) < TEMP_MIN_C || Number(manualTemp) > TEMP_MAX_C) && (
                  <p className="text-xs text-red-500 mt-1 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" />
                    Outside target range ({TEMP_MIN_C}–{TEMP_MAX_C}°C)
                  </p>
                )}
              </div>
              <div className="flex gap-2">
                {hasReading && (
                  <Button variant="outline" className="flex-1 text-sm"
                    onClick={() => setShowManual(false)}>
                    ← Use {reading.tempC}°C
                  </Button>
                )}
                <Button className="flex-1 bg-cyan-600 hover:bg-cyan-700 text-white text-sm"
                  disabled={isSaving || manualTemp === '' || isNaN(Number(manualTemp))}
                  onClick={() => saveTemp(Number(manualTemp), 'manual')}>
                  {isSaving
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <><CheckCircle2 className="w-4 h-4 mr-1" /> Save</>}
                </Button>
              </div>
            </div>
          )}

          {/* ── Error ── */}
          {status === 'error' && !hasReading && !showManual && (
            <div className="space-y-3">
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-amber-700 text-xs flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                Could not read sensor. Enter manually or reconnect.
              </div>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1 text-sm" onClick={connect}>
                  <Bluetooth className="w-4 h-4 mr-1" /> Retry
                </Button>
                <Button className="flex-1 text-sm bg-cyan-600 hover:bg-cyan-700 text-white"
                  onClick={() => setShowManual(true)}>Enter Manually</Button>
              </div>
            </div>
          )}

          {/* Skip */}
          {!isSaving && (
            <button onClick={skip}
              className="w-full text-center text-xs text-slate-400 hover:text-slate-600 pt-1">
              Skip temperature log
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}