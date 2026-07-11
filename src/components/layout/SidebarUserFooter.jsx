import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Phone, MessageCircle, QrCode, Thermometer, MapPin, ChevronDown } from 'lucide-react';

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getDriverDistToStore(driver, stores, dispatcherStoreIds) {
  const driverLat = driver.current_latitude ?? driver.home_latitude;
  const driverLng = driver.current_longitude ?? driver.home_longitude;
  if (!driverLat || !driverLng) return null;
  const originStores = dispatcherStoreIds?.length ?
  stores.filter((s) => dispatcherStoreIds.includes(s?.id) && s?.latitude && s?.longitude) :
  stores.filter((s) => s?.latitude && s?.longitude);
  if (!originStores.length) return null;
  let minDist = Infinity;
  originStores.forEach((s) => {
    const d = haversineMeters(s.latitude, s.longitude, driverLat, driverLng);
    if (d < minDist) minDist = d;
  });
  return minDist === Infinity ? null : minDist < 1000 ? `${Math.round(minDist)}m` : `${(minDist / 1000).toFixed(1)}km`;
}
import { formatRoles } from '@/components/utils/userRoles';
import { getDriverDisplayName } from '@/components/utils/driverUtils';
import { formatPhoneNumber } from '@/components/utils/phoneFormatter';
import ExportRouteButton from '@/components/deliveries/ExportRouteButton';
import { globalFilters } from '@/components/utils/globalFilters';
import { User } from '@/api/entities';
import { canShowExportRoute, getUserAvatarGradient } from '@/components/layout/sidebarUserUtils';
import { base44 } from '@/api/base44Client';

// ── Fridge temp settings cache (loaded once from AppSettings) ─────────────
let _fridgeCfgCache = null;
async function loadFridgeCfg() {
  if (_fridgeCfgCache) return _fridgeCfgCache;
  try {
    const s = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
    const ft = s?.[0]?.setting_value?.fridge_temp_settings;
    _fridgeCfgCache = {
      safe_min: typeof ft?.safe_min === 'number' ? ft.safe_min : 2,
      safe_max: typeof ft?.safe_max === 'number' ? ft.safe_max : 6,
      danger_buffer: typeof ft?.danger_buffer === 'number' ? ft.danger_buffer : 2
    };
  } catch (_) {
    _fridgeCfgCache = { safe_min: 2, safe_max: 6, danger_buffer: 2 };
  }
  return _fridgeCfgCache;
}

// ── Local timestamp helper ─────────────────────────────────────────────────
// All stored timestamps are local ISO strings (YYYY-MM-DDTHH:MM:SS, no Z).
// new Date('2026-06-11T08:30:00') is parsed as LOCAL time by JS — correct.
// We format with toLocaleTimeString to always display in the browser's local zone.
function fmtLocalTime(ts, opts = { hour: '2-digit', minute: '2-digit' }) {
  if (!ts) return null;
  try {
    // Ensure we never accidentally parse a UTC string as local by stripping Z if present
    const clean = String(ts).replace('Z', '').replace('+00:00', '');
    return new Date(clean).toLocaleTimeString([], opts);
  } catch (_) {return ts;}
}

// ── Dispatcher inline temp badge — LIVE / last reading ────────────────────
// Shows while fridge items are still in_transit.
// Polls RxTempLogs every 60s; instant update via fridgeTempRecorded event.
function DispatcherTempBadge({ driverId, selectedDateStr }) {
  const [reading, setReading] = useState(null);
  const pollRef = useRef(null);

  const load = useCallback(async () => {
    if (!driverId || !selectedDateStr) return;
    try {
      let latest = null;
      try {
        const { offlineDB } = await import('@/components/utils/offlineDatabase');
        const all = await offlineDB.getAll(offlineDB.STORES.RX_TEMP_LOGS);
        const log = (all || []).find((l) => l?.driver_id === driverId && l?.delivery_date === selectedDateStr);
        if (log) latest = log.latest_reading || null;
      } catch (_) {}
      if (!latest) {
        const logs = await base44.entities.RxTempLogs.filter({ driver_id: driverId, delivery_date: selectedDateStr });
        latest = logs?.[0]?.latest_reading || null;
      }
      setReading(latest);
    } catch (_) {}
  }, [driverId, selectedDateStr]);

  useEffect(() => {
    load();
    pollRef.current = setInterval(load, 60000);
    return () => clearInterval(pollRef.current);
  }, [load]);

  const [dispCfg, setDispCfg] = useState({ safe_min: 2, safe_max: 6, danger_buffer: 2 });

  useEffect(() => {loadFridgeCfg().then(setDispCfg).catch(() => {});}, []);

  useEffect(() => {
    const handler = (e) => {
      const { temperature, timestamp, driverId: eid } = e.detail || {};
      if (eid !== driverId) return;
      setReading({ temperature_celsius: temperature, timestamp });
    };
    window.addEventListener('fridgeTempRecorded', handler);
    return () => window.removeEventListener('fridgeTempRecorded', handler);
  }, [driverId]);

  if (!reading?.temperature_celsius) return null;

  const t = reading.temperature_celsius;
  const isOut = t < dispCfg.safe_min - dispCfg.danger_buffer || t > dispCfg.safe_max + dispCfg.danger_buffer;
  const ts = fmtLocalTime(reading.timestamp);

  return (
    <span
      title={ts ? `Last reading: ${ts}` : undefined}
      className={`flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0 cursor-default ${
      isOut ? 'bg-red-100 text-red-600' : 'bg-cyan-100 text-cyan-700'}`
      }>
      
      <Thermometer className="w-2.5 h-2.5" />
      {t}°C
    </span>);

}

// ── Dispatcher avg temp badge — COMPLETED route ────────────────────────────
// Shown once all fridge items for a driver+date are completed/failed.
// Window: pickup actual_delivery_time → last fridge delivery actual_delivery_time.
// Averages all temperature_readings within that window from RxTempLogs.
function DispatcherAvgTempBadge({ driverId, selectedDateStr, fridgeDeliveries, storeId }) {
  const [avgData, setAvgData] = useState(null); // { avg, count, windowStart, windowEnd, isOut }
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    (async () => {
      try {
        // Get the full RxTempLogs record for this driver+date
        let logRecord = null;
        try {
          const { offlineDB } = await import('@/components/utils/offlineDatabase');
          const all = await offlineDB.getAll(offlineDB.STORES.RX_TEMP_LOGS);
          logRecord = (all || []).find((l) => l?.driver_id === driverId && l?.delivery_date === selectedDateStr) || null;
        } catch (_) {}
        if (!logRecord) {
          const logs = await base44.entities.RxTempLogs.filter({ driver_id: driverId, delivery_date: selectedDateStr });
          logRecord = logs?.[0] || null;
        }
        if (!logRecord) return;

        const allReadings = Array.isArray(logRecord.temperature_readings) ? logRecord.temperature_readings : [];
        if (!allReadings.length) return;

        // Determine fridge window:
        // Window START = earliest actual_delivery_time among pickup records for this store
        //   (pickup = patient_id is empty/null AND is linked to store via store_id)
        // Window END   = latest actual_delivery_time among completed fridge deliveries
        //   (patient_id non-empty, fridge_item true, status completed/failed)
        const driverFridgeDeliveries = fridgeDeliveries.filter(
          (d) => d?.driver_id === driverId && d?.delivery_date === selectedDateStr && d?.store_id === storeId
        );

        // Pickups = no patient_id (or patient_id empty), fridge_item true
        const pickups = driverFridgeDeliveries.filter(
          (d) => !d?.patient_id && d?.actual_delivery_time
        );
        // Deliveries = have patient_id, fridge_item true, completed/failed
        const drops = driverFridgeDeliveries.filter(
          (d) => d?.patient_id && d?.fridge_item && ['completed', 'failed'].includes(d?.status) && d?.actual_delivery_time
        );

        if (!drops.length) return; // no completed drops yet

        // Parse timestamps (local ISO — no Z)
        const parseLocal = (ts) => ts ? new Date(String(ts).replace('Z', '').replace('+00:00', '')) : null;

        const pickupTimes = pickups.map((d) => parseLocal(d.actual_delivery_time)).filter(Boolean);
        const dropTimes = drops.map((d) => parseLocal(d.actual_delivery_time)).filter(Boolean);

        const windowStart = pickupTimes.length ? new Date(Math.min(...pickupTimes)) : new Date(Math.min(...dropTimes));
        const windowEnd = new Date(Math.max(...dropTimes));

        // Filter readings within window
        const inWindow = allReadings.filter((r) => {
          if (!r?.timestamp || r.temperature_celsius == null) return false;
          const t = parseLocal(r.timestamp);
          return t && t >= windowStart && t <= windowEnd;
        });

        if (!inWindow.length) {
          // Fallback: avg over all readings for the day
          const allTemps = allReadings.map((r) => r.temperature_celsius).filter((v) => v != null);
          if (!allTemps.length) return;
          const avg = +(allTemps.reduce((a, b) => a + b, 0) / allTemps.length).toFixed(1);
          const cfg1 = await loadFridgeCfg();
          setAvgData({ avg, count: allTemps.length, windowStart: null, windowEnd: null, isOut: avg < cfg1.safe_min || avg > cfg1.safe_max });
          return;
        }

        const temps = inWindow.map((r) => r.temperature_celsius);
        const avg = +(temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1);
        setAvgData({
          avg,
          count: temps.length,
          windowStart,
          windowEnd,
          isOut: avg < (await loadFridgeCfg()).safe_min || avg > (await loadFridgeCfg()).safe_max
        });
        loadedRef.current = true;
      } catch (_) {}
    })();
  }, [driverId, selectedDateStr, fridgeDeliveries, storeId]);

  if (!avgData) return null;

  const { avg, count, windowStart, windowEnd, isOut } = avgData;
  // windowStart/End are Date objects — use toLocaleTimeString directly (already local)
  const startStr = windowStart ? windowStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  const endStr = windowEnd ? windowEnd.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  const tooltip = [
  `Avg cooler temp over ${count} readings`,
  startStr && endStr ? `${startStr} → ${endStr}` : null].
  filter(Boolean).join('\n');

  return (
    <span
      title={tooltip}
      className={`flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0 cursor-default ${
      isOut ? 'bg-red-100 text-red-600' : 'bg-emerald-100 text-emerald-700'}`
      }>
      
      <Thermometer className="w-2.5 h-2.5" />
      ⌀{avg}°C
    </span>);

}

function getSlotKeysForDate(dateStr) {
  const d = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
  const dow = d.getDay();
  if (dow === 0) return ['sunday_am', 'sunday_pm'];
  if (dow === 6) return ['saturday_am', 'saturday_pm'];
  return ['weekday_am', 'weekday_pm'];
}

function getDefaultDriverIdForSlot(store, slotKey) {
  const map = {
    weekday_am: store.weekday_am_driver_id,
    weekday_pm: store.weekday_pm_driver_id,
    saturday_am: store.saturday_am_driver_id,
    saturday_pm: store.saturday_pm_driver_id,
    sunday_am: store.sunday_am_driver_id,
    sunday_pm: store.sunday_pm_driver_id
  };
  return map[slotKey] || null;
}

function buildScheduledDrivers(currentUser, stores, appUsers, todayOverrides, deliveries, selectedDateStr) {
  if (!currentUser?.app_roles?.includes('dispatcher')) return [];
  const dispatcherStoreIds = currentUser.store_ids || [];
  if (!dispatcherStoreIds.length) return [];

  const todayStr = selectedDateStr || (() => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  })();
  const slotKeys = getSlotKeysForDate(todayStr);
  const driverMap = new Map();

  const assignedDriverIds = new Set(
    (deliveries || []).
    filter((d) => d?.delivery_date === todayStr && dispatcherStoreIds.includes(d?.store_id) && d?.driver_id).
    map((d) => d.driver_id)
  );

  const scheduledDriverIds = new Set();
  dispatcherStoreIds.forEach((storeId) => {
    const store = stores?.find((s) => s.id === storeId);
    if (!store) return;
    slotKeys.forEach((slotKey) => {
      if (!store[`${slotKey}_enabled`]) return;
      const override = todayOverrides?.find(
        (o) => o.date === todayStr && o.slot_key === slotKey && o.store_id === storeId
      );
      const driverId = override ? override.driver_id : getDefaultDriverIdForSlot(store, slotKey);
      if (driverId) scheduledDriverIds.add(driverId);
    });
  });

  const allRelevantDriverIds = new Set([...assignedDriverIds, ...scheduledDriverIds]);

  allRelevantDriverIds.forEach((driverId) => {
    const driver = appUsers?.find((u) => u.user_id === driverId || u.id === driverId);
    if (!driver) return;

    const key = driver.user_id || driver.id;
    if (driverMap.has(key)) return;

    const slots = [];
    dispatcherStoreIds.forEach((storeId) => {
      const store = stores?.find((s) => s.id === storeId);
      if (!store) return;
      slotKeys.forEach((slotKey) => {
        if (!store[`${slotKey}_enabled`]) return;
        const override = todayOverrides?.find(
          (o) => o.date === todayStr && o.slot_key === slotKey && o.store_id === storeId
        );
        const sid = override ? override.driver_id : getDefaultDriverIdForSlot(store, slotKey);
        if (sid === driverId) slots.push({ storeName: store.name, slotKey });
      });
    });

    const driverDeliveries = (deliveries || []).filter(
      (d) => d?.delivery_date === todayStr && d?.driver_id === driverId && dispatcherStoreIds.includes(d?.store_id)
    );
    const deliveryCount = driverDeliveries.filter((d) => d?.delivery_id && !d.delivery_id.startsWith('BIK') && d?.patient_id).length;
    const routeStarted = driverDeliveries.some((d) => ['completed', 'failed', 'cancelled'].includes(d?.status));

    driverMap.set(key, { driver, slots, deliveryCount, isAssigned: assignedDriverIds.has(driverId), routeStarted });
  });

  const slotOrder = (slots) => {
    const first = slots?.[0]?.slotKey || '';
    return first.endsWith('_am') ? 0 : first.endsWith('_pm') ? 1 : 2;
  };
  return Array.from(driverMap.values()).sort((a, b) => {
    const amPmDiff = slotOrder(a.slots) - slotOrder(b.slots);
    if (amPmDiff !== 0) return amPmDiff;
    return (a.driver.user_name || '').localeCompare(b.driver.user_name || '');
  });
}

export default function SidebarUserFooter({
  currentUser,
  users,
  appUsers,
  unreadMessageCount = 0,
  onOpenMessaging,
  onOpenInviteQR,
  onOpenDriverChat,
  stores,
  filteredDeliveries
}) {
  const [selectedDriverId, setSelectedDriverId] = useState(() => globalFilters.getSelectedDriverId() || 'all');
  const [selectedDateStr, setSelectedDateStr] = useState(() => globalFilters.getSelectedDate());

  // Local today string (YYYY-MM-DD) — used to decide live vs avg badge
  const localTodayStr = (() => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  })();
  const isSelectedDateToday = !selectedDateStr || selectedDateStr === localTodayStr;
  const [todayOverrides, setTodayOverrides] = useState([]);
  const [driversExpanded, setDriversExpanded] = useState(false);
  const driversExpandedAtRef = useRef(null);

  // Auto-collapse the drivers list after 2 minutes of being expanded (same as stop cards)
  useEffect(() => {
    if (!driversExpanded) { driversExpandedAtRef.current = null; return; }
    driversExpandedAtRef.current = Date.now();
    const timer = setTimeout(() => setDriversExpanded(false), 120000);
    return () => clearTimeout(timer);
  }, [driversExpanded]);

  useEffect(() => {
    const unsubscribe = globalFilters.subscribe(() => {
      setSelectedDriverId(globalFilters.getSelectedDriverId() || 'all');
      setSelectedDateStr(globalFilters.getSelectedDate());
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!currentUser?.app_roles?.includes('dispatcher')) return;
    const _now = new Date();
    const _p = (n) => String(n).padStart(2, '0');
    const todayStr = `${_now.getFullYear()}-${_p(_now.getMonth() + 1)}-${_p(_now.getDate())}`;
    base44.entities.DriverScheduleOverride.filter({ date: todayStr }).
    then(setTodayOverrides).
    catch(() => setTodayOverrides([]));
  }, [currentUser]);

  if (!currentUser) {
    return (
      <div className="border-t p-4 flex-shrink-0" style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)' }}>
        <div className="space-y-2">
          <div className="text-sm text-slate-500 mb-2">Not logged in</div>
          <Button
            onClick={async () => {
              try {
                sessionStorage.clear();
                const currentUrl = window.location.origin + window.location.pathname;
                await User.loginWithRedirect(currentUrl);
              } catch (error) {
                console.error('Login failed:', error);
                window.location.href = '/';
              }
            }}
            className="w-full gap-2 bg-emerald-500 hover:bg-emerald-600">
            Log In
          </Button>
        </div>
      </div>);
  }

  const selectedDate = selectedDateStr ? new Date(selectedDateStr + 'T00:00:00') : new Date();

  const scheduledDrivers = buildScheduledDrivers(currentUser, stores, appUsers, todayOverrides, filteredDeliveries, selectedDateStr);

  // All other drivers in the city not already shown in scheduledDrivers
  const scheduledDriverIdSet = new Set(scheduledDrivers.map(({ driver }) => driver.user_id || driver.id));
  const otherCityDrivers = (appUsers || []).filter((u) =>
  u?.status === 'active' &&
  Array.isArray(u.app_roles) && u.app_roles.includes('driver') &&
  u.user_name &&
  !(scheduledDriverIdSet.has(u.user_id) || scheduledDriverIdSet.has(u.id))
  );

  return (
    <div className="px-2 flex-shrink-0 border-t py-2" style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)' }}>
      <div>

        {currentUser?.app_roles?.includes('dispatcher') && (scheduledDrivers.length > 0 || otherCityDrivers.length > 0) &&
        <div className="pr-2 pl-2">
            <button
            className="flex items-center justify-between w-full group"
            onClick={() => setDriversExpanded((v) => !v)}>
            
              <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-slate-400)' }}>
                Drivers: {scheduledDrivers.length} / {scheduledDrivers.length + otherCityDrivers.length}
              </p>
              <ChevronDown className={`w-3.5 h-3.5 transition-transform text-slate-400 ${driversExpanded ? '' : '-rotate-90'}`} />
            </button>
            {/* Render a single scheduled driver card — used for both always-visible and collapsed sections */}
            {(() => {
            const renderDriverCard = ({ driver, deliveryCount, isAssigned, routeStarted }) => {
              const driverId = driver.user_id || driver.id;
              const dispatcherStoreIds = new Set(currentUser.store_ids || []);
              const driverFridgeDeliveries = (filteredDeliveries || []).filter(
                (d) => d?.driver_id === driverId && d?.delivery_date === selectedDateStr && d?.fridge_item === true && dispatcherStoreIds.has(d?.store_id)
              );
              const hasFridgeInTransit = driverFridgeDeliveries.some((d) => d?.status === 'in_transit');
              const activeStatuses = new Set(['pending', 'in_transit']);
              const allFridgeDone = driverFridgeDeliveries.length > 0 && !driverFridgeDeliveries.some((d) => activeStatuses.has(d?.status));
              const fridgeStoreIds = [...new Set(driverFridgeDeliveries.map((d) => d.store_id).filter(Boolean))];
              const driverName = driver.user_name || 'Driver';
              const initial = driverName.charAt(0).toUpperCase();
              const phone = driver.phone;
              const distToStore = routeStarted ? null : getDriverDistToStore(driver, stores, currentUser.store_ids);
              const isOnDuty = driver.driver_status === 'on_duty' || driver.driver_status === 'online';
              const bgGradient = isAssigned ? 'linear-gradient(135deg, #6366f1, #8b5cf6)' : 'linear-gradient(135deg, #94a3b8, #cbd5e1)';
              return (
                <div key={driver.user_id || driver.id} className="flex flex-col px-2 py-1.5 rounded-xl border cursor-pointer transition-all hover:shadow-sm active:scale-95" style={{ background: isAssigned ? 'linear-gradient(135deg, #eef2ff, #f5f3ff)' : 'var(--bg-slate-50)', borderColor: isAssigned ? '#c7d2fe' : 'var(--border-slate-200)' }} onClick={() => onOpenDriverChat?.(driver)} title={`Message ${driverName}`}>
                    <div className="flex items-center gap-1.5">
                      <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-white text-[10px] font-bold" style={{ background: bgGradient }}>{initial}</div>
                      <span className="text-xs font-semibold truncate flex-1" style={{ color: 'var(--text-slate-800)' }}>{driverName}</span>
                      {hasFridgeInTransit && <DispatcherTempBadge driverId={driverId} selectedDateStr={selectedDateStr} />}
                      {allFridgeDone && fridgeStoreIds.map((storeId) => <DispatcherAvgTempBadge key={storeId} driverId={driverId} selectedDateStr={selectedDateStr} fridgeDeliveries={driverFridgeDeliveries} storeId={storeId} />)}
                      {isAssigned && deliveryCount > 0 && <span className="font-semibold px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-600 flex-shrink-0 text-[12px]">Stops: {deliveryCount}</span>}
                      {!isAssigned && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-400 flex-shrink-0">Scheduled</span>}
                    </div>
                    <div className="flex items-center justify-between mt-0.5">
                      {phone && <a href={`tel:${phone}`} onClick={(e) => e.stopPropagation()} className="flex items-center gap-1 hover:text-slate-700 transition-colors" style={{ color: 'var(--text-slate-500)' }}><Phone className="w-2.5 h-2.5" /><span className="text-[12px]">{formatPhoneNumber(phone)}</span></a>}
                      {distToStore && <span className={`flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full flex-shrink-0 ${isOnDuty ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}><MapPin className="w-2.5 h-2.5" />{distToStore}</span>}
                    </div>
                  </div>);

            };

            const assignedDrivers = scheduledDrivers.filter(({ isAssigned }) => isAssigned);
            const unassignedDrivers = scheduledDrivers.filter(({ isAssigned }) => !isAssigned);

            return (
              <div className="flex flex-col gap-1.5">
                  {/* Assigned drivers always visible */}
                  {assignedDrivers.map(renderDriverCard)}
                  {/* Rest only when expanded */}
                  {driversExpanded &&
                <>
                      {unassignedDrivers.map(renderDriverCard)}
                      {/* Other city drivers shown inline when expanded */}
                      {otherCityDrivers.map((driver) => {
                    const driverName = driver.user_name || 'Driver';
                    const initial = driverName.charAt(0).toUpperCase();
                    const phone = driver.phone;
                    const isOnDuty = driver.driver_status === 'on_duty' || driver.driver_status === 'online';
                    const distToStore = getDriverDistToStore(driver, stores, currentUser.store_ids);
                    const statusColor = isOnDuty ?
                    'linear-gradient(135deg, #10b981, #059669)' :
                    'linear-gradient(135deg, #94a3b8, #cbd5e1)';
                    return (
                      <div
                        key={driver.user_id || driver.id}
                        className="flex flex-col px-2 py-1.5 rounded-xl border cursor-pointer transition-all hover:shadow-sm active:scale-95"
                        style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}
                        onClick={() => onOpenDriverChat?.(driver)}
                        title={`Message ${driverName}`}>
                        
                      <div className="flex items-center gap-1.5">
                        <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-white text-[10px] font-bold" style={{ background: statusColor }}>
                          {initial}
                        </div>
                        <span className="text-xs font-semibold truncate flex-1" style={{ color: 'var(--text-slate-800)' }}>{driverName}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0 ${isOnDuty ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-400'}`}>
                          {isOnDuty ? 'On Duty' : 'Off Duty'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between mt-0.5">
                        {phone &&
                          <a href={`tel:${phone}`} onClick={(e) => e.stopPropagation()} className="flex items-center gap-1 hover:text-slate-700 transition-colors" style={{ color: 'var(--text-slate-500)' }}>
                            <Phone className="w-2.5 h-2.5" />
                            <span className="text-[12px]">{formatPhoneNumber(phone)}</span>
                          </a>
                          }
                        {distToStore &&
                          <span className={`flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full flex-shrink-0 ${isOnDuty ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                            <MapPin className="w-2.5 h-2.5" />
                            {distToStore}
                          </span>
                          }
                      </div>
                    </div>);

                  })}
                    </>
                }
                </div>);

          })()}
            <div className="mt-2 mb-1 border-t" style={{ borderColor: 'var(--border-slate-100)' }} />
          </div>
        }

        <div className="rounded-lg flex items-center gap-3 px-2">

          <div className="w-9 h-9 rounded-full flex items-center justify-center relative flex-shrink-0" style={{ background: getUserAvatarGradient(currentUser) }}>
            <span className="text-white font-bold text-sm">{(getDriverDisplayName(currentUser) || 'U')?.charAt(0)}</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm truncate" style={{ color: 'var(--text-slate-900)' }}>
              {getDriverDisplayName(currentUser)}
            </p>
            <p className="text-xs truncate capitalize" style={{ color: 'var(--text-slate-500)' }}>
              {formatRoles(currentUser)}
            </p>
            {currentUser.phone &&
            <div className="flex items-center gap-2 text-xs text-slate-500">
                <Phone className="w-3 h-3" />
                <a href={`tel:${currentUser.phone}`} className="hover:text-slate-700 transition-colors text-xs">
                  {formatPhoneNumber(currentUser.phone)}
                </a>
              </div>
            }
          </div>
          <div className="flex flex-col items-center">
            <button
              onClick={onOpenMessaging} className="px-2 py-0 rounded-lg hover:bg-slate-100 transition-colors relative"
              title="Messages">
              <MessageCircle className="w-5 h-5 text-slate-500 hover:text-slate-700" fill={unreadMessageCount > 0 ? '#10b981' : 'none'} />
              {unreadMessageCount > 0 &&
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] bg-blue-500 text-xs font-bold rounded-full flex items-center justify-center px-1 border-2 border-white" style={{ color: '#ffffff' }}>
                  {unreadMessageCount > 9 ? '9+' : unreadMessageCount}
                </span>
              }
            </button>
            <button
              onClick={onOpenInviteQR} className="px-2 py-0 rounded-lg hover:bg-slate-100 transition-colors"
              title="Generate Invite QR Code">
              <QrCode className="w-5 h-5 text-slate-500 hover:text-slate-700" />
            </button>
          </div>
        </div>

        {canShowExportRoute &&
        <div className="mt-3">
            <ExportRouteButton
            currentUser={currentUser}
            driverFilter={selectedDriverId}
            selectedDate={selectedDate}
            driverFilteredDeliveries={filteredDeliveries} />
          </div>
        }
      </div>
    </div>);

}