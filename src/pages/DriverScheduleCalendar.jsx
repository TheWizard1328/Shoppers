import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { useDevice } from '@/components/utils/DeviceContext';
import {
  format, startOfMonth, endOfMonth, addMonths, subMonths,
  eachDayOfInterval, isBefore, isToday, startOfDay } from 'date-fns';
import { ChevronLeft, ChevronRight, Calendar, Lock, LockOpen, RefreshCw, Clock, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { userHasRole } from '@/components/utils/userRoles';
import { generateDriverColor, getContrastColor } from '@/components/utils/colorGenerator';
import { loadStatHolidays, getStatHoliday } from '@/components/utils/statHolidayResolver';

// ── helpers ─────────────────────────────────────────────────────────────────

function getSlotKey(date) {
  const dow = date.getDay();
  if (dow === 0) return ['sunday_am', 'sunday_pm'];
  if (dow === 6) return ['saturday_am', 'saturday_pm'];
  return ['weekday_am', 'weekday_pm'];
}

function getDefaultDriverId(store, slotKey) {
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

function getTimeWindow(store, slotKey) {
  const map = {
    weekday_am: [store.weekday_am_start, store.weekday_am_end],
    weekday_pm: [store.weekday_pm_start, store.weekday_pm_end],
    saturday_am: [store.saturday_am_start, store.saturday_am_end],
    saturday_pm: [store.saturday_pm_start, store.saturday_pm_end],
    sunday_am: [store.sunday_am_start, store.sunday_am_end],
    sunday_pm: [store.sunday_pm_start, store.sunday_pm_end]
  };
  const [s, e] = map[slotKey] || [];
  if (!s && !e) return null;
  return `${s || ''}–${e || ''}`;
}

function getSlotStartTime(store, slotKey) {
  const map = {
    weekday_am: store.weekday_am_start,
    weekday_pm: store.weekday_pm_start,
    saturday_am: store.saturday_am_start,
    saturday_pm: store.saturday_pm_start,
    sunday_am: store.sunday_am_start,
    sunday_pm: store.sunday_pm_start
  };
  return map[slotKey] || (slotKey.endsWith('_am') ? '00:00' : '12:00');
}

function isSlotEnabled(store, slotKey) {
  const map = {
    weekday_am: store.weekday_am_enabled,
    weekday_pm: store.weekday_pm_enabled,
    saturday_am: store.saturday_am_enabled,
    saturday_pm: store.saturday_pm_enabled,
    sunday_am: store.sunday_am_enabled,
    sunday_pm: store.sunday_pm_enabled
  };
  return !!map[slotKey];
}

function isPastDate(date) {
  return isBefore(startOfDay(date), startOfDay(new Date()));
}

// Returns true if a today-slot should be treated as locked based on delivery activity
function isSlotLockedToday(deliveriesByDay, dateStr, effectiveDriverId, storeId, isAM) {
  const ampm = isAM ? 'AM' : 'PM';
  const slotDelivs = (deliveriesByDay?.[dateStr] || []).filter(
    (d) => d.driver_id === effectiveDriverId && d.store_id === storeId &&
    d.patient_id && d.patient_id !== '' && (
    !d.ampm_deliveries || d.ampm_deliveries === ampm)
  );

  const hasPickedUp = slotDelivs.some((d) => ['en_route', 'in_transit', 'completed'].includes(d.status));
  if (hasPickedUp) return true;

  const currentHour = new Date().getHours();
  const hasPending = slotDelivs.some((d) => d.status === 'pending');
  if (currentHour >= 20 && !hasPending) return true;

  return false;
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return isNaN(d) ? ts : format(d, 'HH:mm');
}

function slotLockKey(dateStr, storeId, slotKey) {
  return `${dateStr}|${storeId}|${slotKey}`;
}

// ── DriverSlotCell ────────────────────────────────────────────────────────────

function DriverSlotCell({
  date, slotKey, store, overrides, drivers, appUsers, currentUser,
  onDriverChange, deliveriesByDay, isAdmin, unlockedSlots, onToggleSlotLock, isMobile,
  isDeliveryDriven = false, deliveryDrivenDriverId = null
}) {
  const dateStr = format(date, 'yyyy-MM-dd');
  const past = isPastDate(date);
  const lockKey = slotLockKey(dateStr, store.id, slotKey);
  const adminUnlocked = isAdmin && unlockedSlots.has(lockKey);
  const [open, setOpen] = useState(false);

  const override = overrides.find((o) => o.date === dateStr && o.slot_key === slotKey && o.store_id === store.id);
  const defaultDriverId = getDefaultDriverId(store, slotKey);
  const rawEffectiveDriverId = override ? override.driver_id : defaultDriverId;
  const isBookedOff = rawEffectiveDriverId === '__booked_off__';
  const effectiveDriverId = isBookedOff ? null : rawEffectiveDriverId;
  const isOverride = !!override;
  const timeWindow = getTimeWindow(store, slotKey);
  const isAM = slotKey.endsWith('_am');

  const todayLocked = useMemo(() => {
    if (!isToday(date)) return false;
    return isSlotLockedToday(deliveriesByDay, dateStr, effectiveDriverId, store.id, isAM);
  }, [date, deliveriesByDay, dateStr, effectiveDriverId, store.id, isAM]);

  const canDriverEdit = useMemo(() => {
    // Delivery-driven slots: admin can always edit; non-admin cannot reassign
    if (isDeliveryDriven) return isAdmin ? adminUnlocked || !past : false;
    if (past) return isAdmin ? adminUnlocked : false;
    if (isToday(date)) {
      if (adminUnlocked) return true;
      if (todayLocked) return false;
      if (isBookedOff) return true;
      const myUserId = currentUser?.id;
      if (!myUserId) return false;
      const isDefault = defaultDriverId === myUserId;
      const isOverrider = override?.overridden_by === myUserId;
      return isAdmin || isDefault || isOverrider;
    }
    if (isAdmin) return true;
    if (isBookedOff) return true;
    const myUserId = currentUser?.id;
    if (!myUserId) return false;
    const isDefault = defaultDriverId === myUserId;
    const isOverrider = override?.overridden_by === myUserId;
    return isDefault || isOverrider;
  }, [isAdmin, past, adminUnlocked, todayLocked, date, currentUser, defaultDriverId, override, isBookedOff, isDeliveryDriven]);

  const storeColor = store.color || '#64748b';
  const storeLabel = store.abbreviation || store.name;

  const isMySlot = useMemo(() => {
    if (isAdmin) return true;
    const myId = currentUser?.id;
    const slotDriverId = isDeliveryDriven ? deliveryDrivenDriverId : effectiveDriverId;
    return myId && slotDriverId === myId;
  }, [isAdmin, currentUser, effectiveDriverId, deliveryDrivenDriverId, isDeliveryDriven]);

  const slotDeliveries = useMemo(() => {
    if (!deliveriesByDay || !isMySlot) return [];
    const ampm = isAM ? 'AM' : 'PM';
    const filterDriverId = isDeliveryDriven ? deliveryDrivenDriverId : effectiveDriverId;
    return (deliveriesByDay[dateStr] || []).filter((d) => {
      if (isBookedOff && !filterDriverId) {
        // Show unassigned pending stops for this store/slot
        return !d.driver_id && d.store_id === store.id &&
          d.patient_id && d.patient_id !== '' && d.status === 'pending' &&
          (!d.ampm_deliveries || d.ampm_deliveries === ampm);
      }
      return d.driver_id === filterDriverId && d.store_id === store.id &&
        d.patient_id && d.patient_id !== '' &&
        (!d.ampm_deliveries || d.ampm_deliveries === ampm);
    });
  }, [deliveriesByDay, dateStr, effectiveDriverId, deliveryDrivenDriverId, isDeliveryDriven, isBookedOff, store.id, isAM, isMySlot]);

  // Raw count for visibility check — always computed regardless of isMySlot
  const assignedDeliveryCount = useMemo(() => {
    if (!deliveriesByDay) return 0;
    const ampm = isAM ? 'AM' : 'PM';
    const filterDriverId = isDeliveryDriven ? deliveryDrivenDriverId : effectiveDriverId;
    if (isBookedOff && !filterDriverId) {
      return (deliveriesByDay[dateStr] || []).filter((d) =>
        !d.driver_id && d.store_id === store.id &&
        d.patient_id && d.patient_id !== '' && d.status === 'pending' &&
        (!d.ampm_deliveries || d.ampm_deliveries === ampm)
      ).length;
    }
    if (!filterDriverId) return 0;
    return (deliveriesByDay[dateStr] || []).filter((d) =>
    d.driver_id === filterDriverId && d.store_id === store.id &&
    d.patient_id && d.patient_id !== '' && (
    !d.ampm_deliveries || d.ampm_deliveries === ampm)
    ).length;
  }, [deliveriesByDay, dateStr, effectiveDriverId, deliveryDrivenDriverId, isDeliveryDriven, isBookedOff, store.id, isAM]);

  // Always compute timing from the assigned driver's deliveries (not gated by isMySlot)
  const allSlotDeliveries = useMemo(() => {
    if (!deliveriesByDay) return [];
    const ampm = isAM ? 'AM' : 'PM';
    const filterDriverId = isDeliveryDriven ? deliveryDrivenDriverId : effectiveDriverId;
    if (!filterDriverId && !isBookedOff) return [];
    return (deliveriesByDay[dateStr] || []).filter((d) => {
      if (isBookedOff && !filterDriverId) {
        return !d.driver_id && d.store_id === store.id &&
          d.patient_id && d.patient_id !== '' && d.status === 'pending' &&
          (!d.ampm_deliveries || d.ampm_deliveries === ampm);
      }
      return d.driver_id === filterDriverId && d.store_id === store.id &&
        d.patient_id && d.patient_id !== '' &&
        (!d.ampm_deliveries || d.ampm_deliveries === ampm);
    });
  }, [deliveriesByDay, dateStr, effectiveDriverId, deliveryDrivenDriverId, isDeliveryDriven, isBookedOff, store.id, isAM]);

  const completedDeliveries = allSlotDeliveries.filter((d) => d.status === 'completed' && d.actual_delivery_time);
  const sortedCompleted = [...completedDeliveries].sort((a, b) => new Date(a.actual_delivery_time) - new Date(b.actual_delivery_time));
  // First stop: earliest by arrival_time (or actual_delivery_time as fallback)
  const sortedByArrival = [...completedDeliveries].sort((a, b) =>
  new Date(a.arrival_time || a.actual_delivery_time) - new Date(b.arrival_time || b.actual_delivery_time)
  );
  const firstStop = sortedByArrival[0];
  const lastStop = sortedCompleted[sortedCompleted.length - 1];
  const totalDeliveries = slotDeliveries.length;

  if (!isSlotEnabled(store, slotKey) && !isDeliveryDriven) return null;

  const isLocked = past ? !adminUnlocked : isToday(date) ? todayLocked && !adminUnlocked : false;

  // Hide locked slots with no assigned deliveries for everyone
  if (isLocked && assignedDeliveryCount === 0) return null;

  // For delivery-driven slots on stores with the slot disabled, show a simplified "transferred" style
  const borderColor = isDeliveryDriven ?
  '#6366f1' :
  isOverride ? '#ea580c' : '#16a34a';
  const bgColor = isDeliveryDriven ?
  '#eef2ff' :
  isOverride ? '#fff7ed' : '#dcfce7';

  const cardContent = isLocked ?
  <div className="grid items-center gap-0.5 w-full" style={{ gridTemplateColumns: '26px 26px 1fr 28px 14px' }}>
      <span
      className="text-[9px] font-bold rounded-full leading-4 inline-flex items-center justify-center w-[26px] h-4 overflow-hidden"
      style={{ background: '#ffffff', color: storeColor, border: `1px solid ${storeColor}` }}>
        <span className="truncate px-0.5">{storeLabel}</span>
      </span>
      <span
      className="text-[9px] font-bold uppercase rounded-full leading-4 inline-flex items-center justify-center w-[26px] h-4"
      style={{ background: isAM ? '#e0f2fe' : '#ede9fe', color: isAM ? '#0ea5e9' : '#7c3aed' }}>
        {isAM ? 'AM' : 'PM'}
      </span>
      <div className="flex items-center gap-0.5 justify-center">
        {firstStop && lastStop ?
      <>
            <Clock className="w-2.5 h-2.5 flex-shrink-0" style={{ color: '#94a3b8' }} />
            <span className="text-[9px]" style={{ color: '#64748b' }}>
              {fmtTime(firstStop.arrival_time || firstStop.actual_delivery_time)}–{fmtTime(lastStop.actual_delivery_time)}
            </span>
          </> :
      timeWindow ?
      <>
            <Clock className="w-2.5 h-2.5 flex-shrink-0" style={{ color: '#94a3b8' }} />
            <span className="text-[9px]" style={{ color: '#64748b' }}>{timeWindow}</span>
          </> :
      null}
      </div>
      <span className={`text-[9px] font-semibold rounded-full leading-4 h-4 w-[28px] inline-flex items-center justify-center flex-shrink-0 ${totalDeliveries > 0 ? '' : 'invisible'}`}
    style={{ background: '#e2e8f0', color: '#475569' }}>
        {totalDeliveries}
      </span>
      <span className="inline-flex items-center justify-center w-[14px]">
        {isAdmin ?
      adminUnlocked ?
      <span title="Click to lock" style={{ cursor: 'pointer', lineHeight: 0 }}
      onClick={(e) => {e.stopPropagation();onToggleSlotLock(lockKey);}}>
              <LockOpen className="w-2.5 h-2.5 text-orange-500" />
            </span> :
      <span title="Click to unlock and edit this slot" style={{ cursor: 'pointer', lineHeight: 0 }}
      onClick={(e) => {e.stopPropagation();onToggleSlotLock(lockKey);}}>
              <Lock className="w-2.5 h-2.5 text-slate-400 hover:text-orange-500" />
            </span> :
      <Lock className="w-2.5 h-2.5 text-slate-400" />
      }
      </span>
    </div> :

  <div className="grid w-full items-center gap-0.5" style={{ gridTemplateColumns: '26px 26px 1fr 28px 14px' }}>
      <span
      className="text-[9px] font-bold rounded-full leading-4 inline-flex items-center justify-center w-[26px] h-4 overflow-hidden"
      style={{ background: '#ffffff', color: storeColor, border: `1px solid ${storeColor}` }}>
        <span className="truncate px-0.5">{storeLabel}</span>
      </span>
      <span
      className="text-[9px] font-bold uppercase rounded-full leading-4 inline-flex items-center justify-center w-[26px] h-4"
      style={{ background: isAM ? '#e0f2fe' : '#ede9fe', color: isAM ? '#0ea5e9' : '#7c3aed' }}>
        {isAM ? 'AM' : 'PM'}
      </span>
      <div className="flex items-center justify-center gap-0.5 px-0.5">
        {firstStop ?
      <>
            <Clock className="w-2.5 h-2.5 flex-shrink-0" style={{ color: '#94a3b8' }} />
            <span className="text-[9px] truncate" style={{ color: '#64748b' }}>
              {fmtTime(firstStop.arrival_time || firstStop.actual_delivery_time)}–{fmtTime(lastStop.actual_delivery_time)}
            </span>
          </> :
      timeWindow ?
      <>
            <Clock className="w-2.5 h-2.5 flex-shrink-0" style={{ color: '#94a3b8' }} />
            <span className="text-[9px] truncate" style={{ color: '#64748b' }}>{timeWindow}</span>
          </> :
      null}
      </div>
      <span className={`text-[9px] font-semibold rounded-full leading-4 h-4 w-[28px] inline-flex items-center justify-center ${totalDeliveries > 0 ? '' : 'invisible'}`}
    style={{ background: '#e2e8f0', color: '#475569' }}>
        {slotDeliveries.filter((d) => d.status === 'completed').length}/{totalDeliveries}
      </span>
      <span className="inline-flex items-center justify-center w-[14px]">
        <ChevronDown className={`w-2.5 h-2.5 ${canDriverEdit ? 'text-slate-400' : 'invisible'}`} />
      </span>
    </div>;


  if (canDriverEdit) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <div
            className="rounded-md px-1.5 py-1 mb-0.5 cursor-pointer"
            style={{
              background: bgColor,
              border: '2px solid',
              borderColor
            }}>
            {cardContent}
          </div>
        </PopoverTrigger>
        <PopoverContent className="w-52 p-1" align="start">
          {!isAdmin && isBookedOff ?
          <>
              <div className="text-[10px] font-semibold px-2 py-1" style={{ color: 'var(--text-slate-500)' }}>Claim this slot</div>
              <button
              className="w-full text-left text-xs px-2 py-1.5 rounded bg-green-100 hover:bg-green-200 text-green-800 font-semibold"
              onClick={() => {onDriverChange(date, slotKey, store, currentUser?.id);setOpen(false);}}>
                ✓ Accept — assign to me
              </button>
            </> :
          <>
              <div className="text-[10px] font-semibold px-2 py-1" style={{ color: 'var(--text-slate-500)' }}>Assign driver</div>
              {defaultDriverId &&
            <button
              className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-accent"
              style={{ color: 'var(--text-slate-600)' }}
              onClick={() => {onDriverChange(date, slotKey, store, `__default__:${defaultDriverId}`);setOpen(false);}}>
                  ↩ Default: {appUsers.find((u) => u.user_id === defaultDriverId || u.id === defaultDriverId)?.user_name || 'Default'}
                </button>
            }
              {!isBookedOff &&
            <button
              className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-accent"
              style={{ color: 'var(--text-slate-500)' }}
              onClick={() => {onDriverChange(date, slotKey, store, '__none__');setOpen(false);}}>
                  — Book Off —
                </button>
            }
              <div className="border-t my-1" />
              {drivers.map((d) =>
            <button
              key={d.user_id || d.id}
              className={`w-full text-left text-xs px-2 py-1.5 rounded hover:bg-amber-400 hover:text-black ${effectiveDriverId === (d.user_id || d.id) ? 'font-bold bg-amber-400' : ''}`}
              style={effectiveDriverId === (d.user_id || d.id) ? { color: '#000000' } : { color: 'var(--text-slate-700)' }}
              onClick={() => {onDriverChange(date, slotKey, store, d.user_id || d.id);setOpen(false);}}>
                {d.user_name}
              </button>
            )}
            </>
          }
        </PopoverContent>
      </Popover>);
  }

  return (
    <div
      className="rounded-md py-1 px-1.5 mb-0.5"
      style={{
        background: isDeliveryDriven ? '#eef2ff' : isOverride ? '#fff7ed' : past ? 'var(--bg-slate-50)' : 'rgba(240,253,244,0.6)',
        border: '1px solid',
        borderColor: isDeliveryDriven ? '#a5b4fc' : isOverride ? '#ea580c' : past ? 'var(--border-slate-200)' : '#86efac'
      }}>
      {cardContent}
    </div>);
}

// ── main page ────────────────────────────────────────────────────────────────

export default function DriverScheduleCalendar() {
  const { isMobile } = useDevice();

  const [monthDate, setMonthDate] = useState(startOfMonth(new Date()));
  const [stores, setStores] = useState([]);
  const [appUsers, setAppUsers] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [statHolidays, setStatHolidays] = useState([]);
  const [deliveriesByDay, setDeliveriesByDay] = useState({});
  const [currentUser, setCurrentUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingDeliveries, setLoadingDeliveries] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedStoreId, setSelectedStoreId] = useState('all');
  const [selectedDriverId, setSelectedDriverId] = useState('all');
  const [unlockedSlots, setUnlockedSlots] = useState(new Set());
  const [dragItem, setDragItem] = useState(null);
  const scrollContainerRef = useRef(null);
  const todayRef = useRef(null);

  const isAdmin = useMemo(() => {
    if (userHasRole(currentUser, 'admin')) return true;
    // Also treat AppUser-level admins as admins
    const appUser = appUsers.find((u) => u.user_id === currentUser?.id);
    return appUser?.app_roles?.includes('admin') === true;
  }, [currentUser, appUsers]);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const [user, storeList, userList, holidays] = await Promise.all([
        base44.auth.me(),
        base44.entities.Store.list('sort_order', 200),
        base44.entities.AppUser.list('sort_order', 200),
        loadStatHolidays()]
        );
        setCurrentUser(user);
        setStores(storeList.filter((s) => s.status !== 'inactive'));
        setAppUsers(userList);
        setStatHolidays(holidays || []);
        // Auto-select driver filter for non-admin drivers
        const appUser = userList.find((u) => u.user_id === user?.id);
        if (appUser && appUser.app_roles?.includes('driver') && !userHasRole(user, 'admin')) {
          setSelectedDriverId(user.id);
        }
      } catch {
        toast.error('Failed to load data');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const loadOverrides = useCallback(async (month) => {
    const start = format(startOfMonth(month), 'yyyy-MM-dd');
    const end = format(endOfMonth(month), 'yyyy-MM-dd');
    try {
      const all = await base44.entities.DriverScheduleOverride.filter({});
      setOverrides(all.filter((o) => o.date >= start && o.date <= end));
    } catch {
      setOverrides([]);
    }
  }, []);

  const loadDeliveriesForMonth = useCallback(async (month) => {
    setLoadingDeliveries(true);
    try {
      const start = format(startOfMonth(month), 'yyyy-MM-dd');
      const end = format(endOfMonth(month), 'yyyy-MM-dd');
      const deliveries = await base44.entities.Delivery.filter({
        delivery_date: { $gte: start, $lte: end }
      });
      const byDay = {};
      deliveries.forEach((d) => {
        if (!byDay[d.delivery_date]) byDay[d.delivery_date] = [];
        byDay[d.delivery_date].push(d);
      });
      setDeliveriesByDay(byDay);
    } catch {
      setDeliveriesByDay({});
    } finally {
      setLoadingDeliveries(false);
    }
  }, []);

  useEffect(() => {
    if (loading) return;
    loadOverrides(monthDate);
    loadDeliveriesForMonth(monthDate);
  }, [monthDate, loading, loadOverrides, loadDeliveriesForMonth]);

  useEffect(() => {
    const unsubscribe = base44.entities.Delivery.subscribe((event) => {
      const d = event.data;
      if (!d?.delivery_date) return;
      setDeliveriesByDay((prev) => {
        const dateKey = d.delivery_date;
        if (event.type === 'delete') {
          const updated = (prev[dateKey] || []).filter((x) => x.id !== event.id);
          return { ...prev, [dateKey]: updated };
        }
        const existing = prev[dateKey] || [];
        const idx = existing.findIndex((x) => x.id === d.id);
        const updated = idx >= 0 ?
        existing.map((x) => x.id === d.id ? { ...x, ...d } : x) :
        [...existing, d];
        return { ...prev, [dateKey]: updated };
      });
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = base44.entities.DriverScheduleOverride.subscribe((event) => {
      if (event.type === 'delete') {
        setOverrides((prev) => prev.filter((o) => o.id !== event.id));
      } else {
        const o = event.data;
        if (!o) return;
        setOverrides((prev) => {
          const idx = prev.findIndex((x) => x.id === o.id);
          if (idx >= 0) return prev.map((x) => x.id === o.id ? { ...x, ...o } : x);
          return [...prev, o];
        });
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (loading) return;
    const isCurrentMonth =
    format(monthDate, 'yyyy-MM') === format(new Date(), 'yyyy-MM');
    if (!isCurrentMonth) return;
    // Wait for both the DOM to render and any delivery/override data to settle
    const t = setTimeout(() => {
      todayRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 400);
    return () => clearTimeout(t);
  }, [monthDate, loading, loadingDeliveries]);

  const days = useMemo(() =>
  eachDayOfInterval({ start: startOfMonth(monthDate), end: endOfMonth(monthDate) }),
  [monthDate]
  );

  const drivers = useMemo(() =>
  appUsers.
  filter((u) => u.app_roles?.includes('driver') && u.status !== 'inactive').
  sort((a, b) => (a.sort_order ?? 999) - (b.sort_order ?? 999)),
  [appUsers]
  );

  const visibleStores = useMemo(() => {
    if (selectedStoreId === 'all') return stores;
    return stores.filter((s) => s.id === selectedStoreId);
  }, [stores, selectedStoreId]);

  const handleToggleSlotLock = useCallback((lockKey) => {
    setUnlockedSlots((prev) => {
      const next = new Set(prev);
      if (next.has(lockKey)) {next.delete(lockKey);} else {next.add(lockKey);}
      return next;
    });
  }, []);

  const handleDriverChange = useCallback(async (date, slotKey, storeArg, newValue) => {
    const dateStr = format(date, 'yyyy-MM-dd');

    let store = storeArg;
    if (storeArg.__needsLookup) {
      store = stores.find((s) => s.id === storeArg.id);
      if (!store) {toast.error('Store not found');return;}
    }

    const defaultDriverId = getDefaultDriverId(store, slotKey);
    const isBookOff = newValue === '__none__';
    const isRevertToDefault = newValue.startsWith('__default__:');
    const newDriverId = isRevertToDefault ? null : isBookOff ? null : newValue;
    const lockKey = slotLockKey(dateStr, store.id, slotKey);

    setSaving(true);
    try {
      const existing = overrides.find((o) => o.date === dateStr && o.slot_key === slotKey && o.store_id === store.id);

      if (isRevertToDefault) {
        if (existing) {
          await base44.entities.DriverScheduleOverride.delete(existing.id);
          setOverrides((prev) => prev.filter((o) => o.id !== existing.id));
        }
        setUnlockedSlots((prev) => {const next = new Set(prev);next.delete(lockKey);return next;});

        // Apply same delivery/pickup reassignment rules when reverting to default
        const isAM = slotKey.endsWith('_am');
        const ampm = isAM ? 'AM' : 'PM';
        const targetDriverId = defaultDriverId;
        const targetDriverApp = appUsers.find((u) => u.user_id === defaultDriverId || u.id === defaultDriverId);
        const targetDriverName = targetDriverApp?.user_name || '';
        const wasBookedOff = existing?.driver_id === '__booked_off__';
        const prevDriverId = existing ? (wasBookedOff ? null : existing.driver_id) : null;
        const dayDeliveries = deliveriesByDay[dateStr] || [];
        const matchesSlot = (d) => {
          if (d.store_id !== store.id) return false;
          if (d.ampm_deliveries && d.ampm_deliveries !== ampm) return false;
          const isPickup = !d.patient_id || d.patient_id === '';
          return isPickup ? true : d.status === 'pending';
        };
        let toUpdate;
        if (wasBookedOff) {
          toUpdate = dayDeliveries.filter((d) => !d.driver_id && matchesSlot(d));
        } else if (prevDriverId) {
          toUpdate = dayDeliveries.filter((d) => d.driver_id === prevDriverId && matchesSlot(d));
        } else {
          toUpdate = [];
        }
        if (toUpdate.length > 0 && targetDriverId) {
          await Promise.all(toUpdate.map((d) =>
            base44.entities.Delivery.update(d.id, {
              driver_id: targetDriverId,
              driver_name: targetDriverName,
              encoded_polyline: null,
              PolylineUpdated: false,
              isNextDelivery: d.isNextDelivery ? false : undefined,
            })
          ));
          setDeliveriesByDay((prev) => {
            const updated = (prev[dateStr] || []).map((d) =>
              toUpdate.some((t) => t.id === d.id) ? { ...d, driver_id: targetDriverId, driver_name: targetDriverName, encoded_polyline: null, PolylineUpdated: false, isNextDelivery: false } : d
            );
            return { ...prev, [dateStr]: updated };
          });
          toast.success(`Reverted to default — ${toUpdate.length} stop${toUpdate.length !== 1 ? 's' : ''} transferred to ${targetDriverName}`);
        } else {
          toast.success('Reverted to default driver');
        }
        return;
      }

      const driver = isBookOff ? null : appUsers.find((u) => u.user_id === newDriverId || u.id === newDriverId);
      const payload = {
        date: dateStr,
        store_id: store.id,
        slot_key: slotKey,
        driver_id: isBookOff ? '__booked_off__' : newDriverId,
        driver_name: isBookOff ? '(Book Off)' : driver?.user_name || '',
        overridden_by: currentUser?.id,
        overridden_by_name: currentUser?.full_name || currentUser?.email || ''
      };

      if (existing) {
        const updated = await base44.entities.DriverScheduleOverride.update(existing.id, payload);
        setOverrides((prev) => prev.map((o) => o.id === existing.id ? { ...o, ...updated } : o));
      } else {
        const created = await base44.entities.DriverScheduleOverride.create(payload);
        setOverrides((prev) => [...prev, created]);
      }

      // ── Reassign/clear deliveries & pickups for this slot ─────────────────
      const isAM = slotKey.endsWith('_am');
      const ampm = isAM ? 'AM' : 'PM';

      // Target driver: null when booking off, newDriverId when assigning
      const targetDriverId = isBookOff ? null : newDriverId;
      const targetDriverName = isBookOff ? '' : (appUsers.find((u) => u.user_id === newDriverId || u.id === newDriverId)?.user_name || '');

      // Who previously owned this slot:
      // - No existing override → default driver from store schedule
      // - Override exists and was booked off → null (deliveries were cleared)
      // - Override exists with a real driver → that driver
      const wasBookedOff = existing?.driver_id === '__booked_off__';
      const prevDriverId = existing
        ? (wasBookedOff ? null : existing.driver_id)
        : defaultDriverId;

      const dayDeliveries = deliveriesByDay[dateStr] || [];

      const matchesSlot = (d) => {
        if (d.store_id !== store.id) return false;
        if (d.ampm_deliveries && d.ampm_deliveries !== ampm) return false;
        const isPickup = !d.patient_id || d.patient_id === '';
        // Pickups: en_route status, include always
        // Deliveries: pending status only
        return isPickup ? true : d.status === 'pending';
      };

      let toUpdate;
      if (wasBookedOff) {
        // Slot was booked off → deliveries were set to driver_id=null; grab those
        toUpdate = dayDeliveries.filter((d) => !d.driver_id && matchesSlot(d));
      } else if (prevDriverId) {
        // Normal reassign → grab deliveries belonging to the previous driver
        toUpdate = dayDeliveries.filter((d) => d.driver_id === prevDriverId && matchesSlot(d));
      } else {
        toUpdate = [];
      }

      if (toUpdate.length > 0) {
        await Promise.all(
          toUpdate.map((d) =>
            base44.entities.Delivery.update(d.id, {
              driver_id: targetDriverId,
              driver_name: targetDriverName,
              encoded_polyline: null,
              PolylineUpdated: false,
              isNextDelivery: d.isNextDelivery ? false : undefined,
            })
          )
        );
        setDeliveriesByDay((prev) => {
          const updated = (prev[dateStr] || []).map((d) =>
            toUpdate.some((t) => t.id === d.id)
              ? { ...d, driver_id: targetDriverId, driver_name: targetDriverName, encoded_polyline: null, PolylineUpdated: false, isNextDelivery: false }
              : d
          );
          return { ...prev, [dateStr]: updated };
        });
        if (isBookOff) {
          toast.success(`Driver booked off — ${toUpdate.length} pending stop${toUpdate.length !== 1 ? 's' : ''} unassigned`);
        } else {
          toast.success(`Schedule updated — ${toUpdate.length} pending stop${toUpdate.length !== 1 ? 's' : ''} transferred to ${targetDriverName}`);
        }
      } else {
        toast.success(isBookOff ? 'Driver booked off' : 'Schedule updated');
      }

      setUnlockedSlots((prev) => {const next = new Set(prev);next.delete(lockKey);return next;});
    } catch {
      toast.error('Failed to save');
    } finally {
      setSaving(false);
    }
  }, [overrides, appUsers, currentUser, stores, deliveriesByDay]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin" />
      </div>);
  }

  return (
    <div
      className="flex flex-col h-full overflow-hidden"
      style={{ background: 'var(--bg-slate-50)', color: 'var(--text-slate-900)' }}
      onDragEnd={() => setDragItem(null)}>

      {/* Header */}
      <div className="flex-shrink-0 border-b"
      style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
        <div className="px-4 pt-3 pb-2 flex items-center gap-2">
          <Calendar className="w-5 h-5 flex-shrink-0" style={{ color: 'var(--text-slate-600)' }} />
          <h1 className="text-lg font-bold" style={{ color: 'var(--text-slate-900)' }}>Driver Scheduling Calendar</h1>
          {(saving || loadingDeliveries) && <RefreshCw className="w-4 h-4 animate-spin text-blue-500 ml-2" />}
        </div>
        <div className="px-4 pb-3 flex items-center gap-2 flex-wrap">
          {stores.length > 1 &&
          <Select value={selectedStoreId} onValueChange={setSelectedStoreId}>
              <SelectTrigger className={isMobile ? 'flex-1 min-w-0 text-xs h-8' : 'w-44'}>
                <SelectValue placeholder="All Stores" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Stores</SelectItem>
                {stores.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
              </SelectContent>
            </Select>
          }
          <Select value={selectedDriverId} onValueChange={setSelectedDriverId}>
            <SelectTrigger className={isMobile ? 'flex-1 min-w-0 text-xs h-8' : 'w-44'}>
              <SelectValue placeholder="All Drivers" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Drivers</SelectItem>
              {drivers.map((d) => <SelectItem key={d.user_id || d.id} value={d.user_id || d.id}>{d.user_name}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" className={isMobile ? 'h-8 w-8' : ''} onClick={() => setMonthDate((m) => subMonths(m, 1))}>
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <span className={`font-semibold text-center ${isMobile ? 'text-xs px-1 min-w-[90px]' : 'text-sm px-3 min-w-[130px]'}`}
            style={{ color: 'var(--text-slate-900)' }}>
              {isMobile ? format(monthDate, 'MMM yyyy') : format(monthDate, 'MMMM yyyy')}
            </span>
            <Button variant="outline" size="icon" className={isMobile ? 'h-8 w-8' : ''} onClick={() => setMonthDate((m) => addMonths(m, 1))}>
              <ChevronRight className="w-4 h-4" />
            </Button>
            <Button variant="outline" size="sm" className={isMobile ? 'h-8 text-xs px-2' : ''} onClick={() => setMonthDate(startOfMonth(new Date()))}>
              This Month
            </Button>
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="flex-shrink-0 px-4 py-1.5 flex flex-wrap items-center gap-3 border-b"
      style={{ borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-500)' }}>
        <span className="flex items-center gap-1.5 text-xs"><span className="w-2.5 h-2.5 rounded-full bg-green-100 border border-green-400 inline-block" /> Scheduled</span>
        <span className="flex items-center gap-1.5 text-xs"><span className="w-2.5 h-2.5 rounded-full bg-indigo-100 border border-indigo-400 inline-block" /> Transferred deliveries</span>
        <span className="flex items-center gap-1.5 text-xs"><span className="w-2.5 h-2.5 rounded-full bg-amber-300 inline-block" /> Reassigned</span>
        <span className="flex items-center gap-1.5 text-xs"><Lock className="w-3 h-3" /> Past</span>
        {isAdmin && <span className="flex items-center gap-1.5 text-xs"><LockOpen className="w-3 h-3 text-orange-500" /> Tap lock to unlock</span>}
        {!isMobile && isAdmin && <span className="text-xs">⠿ Drag to reassign</span>}
      </div>

      {/* Calendar grid */}
      <div ref={scrollContainerRef} className="flex-1 overflow-auto p-3">
        <div className={`grid gap-2 ${isMobile ? 'grid-cols-1' : 'grid-cols-7'}`}>

          {!isMobile && Array.from({ length: (days[0].getDay() + 6) % 7 }).map((_, i) =>
          <div key={`blank-${i}`} />
          )}

          {days.map((date) => {
            const past = isPastDate(date);
            const today = isToday(date);
            const dateStr = format(date, 'yyyy-MM-dd');
            const dayName = format(date, 'EEE');
            const statHoliday = getStatHoliday(dateStr, statHolidays);

            // Build scheduled driver map from store schedule + overrides
            const driverMap = new Map();
            const noDriverEntries = [];
            visibleStores.forEach((store) => {
              getSlotKey(date).forEach((sk) => {
                if (!isSlotEnabled(store, sk)) return;
                const override = overrides.find((o) => o.date === dateStr && o.slot_key === sk && o.store_id === store.id);
                const defaultDriverId = getDefaultDriverId(store, sk);
                const effectiveDriverId = override ? override.driver_id : defaultDriverId;
                const isBookedOff = effectiveDriverId === '__booked_off__';
                if (effectiveDriverId && !isBookedOff) {
                  if (!driverMap.has(effectiveDriverId)) driverMap.set(effectiveDriverId, []);
                  driverMap.get(effectiveDriverId).push({ store, slotKey: sk, startTime: getSlotStartTime(store, sk), isDeliveryDriven: false });
                } else {
                  noDriverEntries.push({ store, slotKey: sk, startTime: getSlotStartTime(store, sk), isBookedOff, isDeliveryDriven: false });
                }
              });
            });

            // ── Delivery-driven slots ──────────────────────────────────────
            // Find drivers who have actual deliveries for a store on this date
            // but are NOT already the scheduled driver for that store/slot combo.
            const dayDeliveries = deliveriesByDay[dateStr] || [];
            dayDeliveries.forEach((delivery) => {
              if (!delivery.driver_id || !delivery.store_id || !delivery.patient_id) return;
              if (delivery.status === 'cancelled') return;
              const store = visibleStores.find((s) => s.id === delivery.store_id);
              if (!store) return;

              const ampm = delivery.ampm_deliveries; // 'AM', 'PM', or undefined
              const slotKeys = getSlotKey(date);

              slotKeys.forEach((sk) => {
                const isAM = sk.endsWith('_am');
                // Only match if ampm matches (or no ampm set on delivery)
                if (ampm && (isAM && ampm !== 'AM' || !isAM && ampm !== 'PM')) return;

                // Check if this driver is already the scheduled driver for this store/slot
                const scheduledDriverId = (() => {
                  const override = overrides.find((o) => o.date === dateStr && o.slot_key === sk && o.store_id === store.id);
                  const defId = getDefaultDriverId(store, sk);
                  return override ? override.driver_id : defId;
                })();

                if (scheduledDriverId === delivery.driver_id) return; // already shown

                // Check if the slot is enabled; if it is, it's already in the scheduled view — skip
                // If slot is NOT enabled for the store, still show as delivery-driven
                // If slot IS enabled but driver is different, show as delivery-driven
                const slotAlreadyCovered = isSlotEnabled(store, sk) && scheduledDriverId === delivery.driver_id;
                if (slotAlreadyCovered) return;

                // Add to driver's group as a delivery-driven entry
                if (!driverMap.has(delivery.driver_id)) driverMap.set(delivery.driver_id, []);
                const group = driverMap.get(delivery.driver_id);
                const alreadyHas = group.some((e) => e.store.id === store.id && e.slotKey === sk);
                if (!alreadyHas) {
                  group.push({ store, slotKey: sk, startTime: getSlotStartTime(store, sk), isDeliveryDriven: true });
                }
              });
            });

            driverMap.forEach((entries) => entries.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || '')));
            noDriverEntries.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));

            const myUserId = currentUser?.id;
            const sortedDriverIds = [...driverMap.keys()].
            filter((id) => selectedDriverId === 'all' || id === selectedDriverId).
            filter((id) => {
              // Only hide on past dates
              if (!past) return true;
              const entries = driverMap.get(id);
              // If any entry is delivery-driven, always show the driver
              if (entries.some((e) => e.isDeliveryDriven)) return true;
              // Past date: only show if driver has at least one actual delivery or pickup
              const dayDelivs = deliveriesByDay[dateStr] || [];
              return dayDelivs.some((d) => d.driver_id === id && !d.is_cycling_marker);
            }).
            sort((a, b) => {
              // Current user's driver group always first
              if (a === myUserId) return -1;
              if (b === myUserId) return 1;
              const da = appUsers.find((u) => u.user_id === a || u.id === a);
              const db = appUsers.find((u) => u.user_id === b || u.id === b);
              return (da?.sort_order ?? 999) - (db?.sort_order ?? 999);
            });

            return (
              <div
                key={dateStr}
                ref={today ? todayRef : null}
                className={`rounded-xl border flex flex-col ${today ? 'border-blue-400 shadow-md' : past ? 'border-slate-200' : 'border-green-300'}`}
                style={{ background: 'var(--bg-white)', minHeight: 90 }}>

                <div className={`rounded-t-xl flex items-center px-5`}
                style={{
                  background: today ? 'rgba(59,130,246,0.12)' : past ? 'var(--bg-slate-50)' : 'rgba(134,239,172,0.18)'
                }}>
                  <span className={`text-sm font-bold min-w-[20px] ${today ? 'text-blue-500' : past ? '' : 'text-green-700'}`}
                  style={past && !today ? { color: 'var(--text-slate-500)' } : {}}>
                    {format(date, 'd')}
                  </span>
                  <span className={`flex-1 text-center text-xs font-semibold uppercase ${today ? 'text-blue-400' : past ? '' : 'text-green-600'}`}
                  style={past && !today ? { color: 'var(--text-slate-400)' } : {}}>
                    {dayName}
                  </span>
                  {past && !today ?
                  <Lock className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--text-slate-300)' }} /> :
                  <span className="w-3 h-3 flex-shrink-0" />
                  }
                </div>

                <div className="flex-1 p-1.5 flex flex-col gap-2">
                  {sortedDriverIds.map((driverId) => {
                    const dayDelivs = deliveriesByDay[dateStr] || [];

                    // On stat holidays, only show drivers who have actual deliveries/pickups/interstores
                    if (statHoliday) {
                      const hasAssignment = dayDelivs.some((d) =>
                        d.driver_id === driverId && !d.is_cycling_marker
                      );
                      if (!hasAssignment) return null;
                    }

                    const driver = appUsers.find((u) => u.user_id === driverId || u.id === driverId);
                    const driverColor = generateDriverColor(driver?.user_name || driverId);
                    const driverTextColor = getContrastColor(driverColor);

                    // On stat holidays, build entries from actual deliveries instead of default schedule
                    let entries = driverMap.get(driverId);
                    if (statHoliday) {
                      const assignedStoreIds = [...new Set(
                        dayDelivs
                          .filter((d) => d.driver_id === driverId && !d.is_cycling_marker)
                          .map((d) => d.store_id)
                          .filter(Boolean)
                      )];
                      entries = assignedStoreIds.flatMap((storeId) => {
                        const store = stores.find((s) => s.id === storeId);
                        if (!store) return [];
                        // Determine AM/PM from deliveries for this store
                        const storeDelivs = dayDelivs.filter((d) => d.driver_id === driverId && d.store_id === storeId);
                        const hasAM = storeDelivs.some((d) => !d.ampm_deliveries || d.ampm_deliveries === 'AM');
                        const hasPM = storeDelivs.some((d) => d.ampm_deliveries === 'PM');
                        const slots = [];
                        if (hasAM) slots.push({ store, slotKey: `weekday_am`, startTime: store.weekday_am_start || '08:00', isDeliveryDriven: true });
                        if (hasPM) slots.push({ store, slotKey: `weekday_pm`, startTime: store.weekday_pm_start || '13:00', isDeliveryDriven: true });
                        if (!hasAM && !hasPM) slots.push({ store, slotKey: `weekday_am`, startTime: store.weekday_am_start || '08:00', isDeliveryDriven: true });
                        return slots;
                      });
                    }

                    if (!entries || entries.length === 0) return null;

                    const isMyGroup = !isAdmin && driverId === currentUser?.id;
                    if (!isMobile && (isAdmin || isMyGroup)) {
                      return (
                        <DriverGroupDraggable
                          key={driverId}
                          driverId={driverId}
                          driver={driver}
                          entries={entries}
                          date={date}
                          overrides={overrides}
                          drivers={drivers}
                          appUsers={appUsers}
                          currentUser={currentUser}
                          onDriverChange={handleDriverChange}
                          deliveriesByDay={deliveriesByDay}
                          isAdmin={isAdmin}
                          unlockedSlots={unlockedSlots}
                          onToggleSlotLock={handleToggleSlotLock}
                          isMobile={isMobile}
                          dragItem={dragItem}
                          onDragStart={setDragItem}
                          stores={stores} />);
                    }

                    return (
                      <MobileDriverGroup
                        key={driverId}
                        driverId={driverId}
                        driver={driver}
                        entries={entries}
                        date={date}
                        overrides={overrides}
                        drivers={drivers}
                        appUsers={appUsers}
                        currentUser={currentUser}
                        onDriverChange={handleDriverChange}
                        deliveriesByDay={deliveriesByDay}
                        isAdmin={isAdmin}
                        unlockedSlots={unlockedSlots}
                        onToggleSlotLock={handleToggleSlotLock}
                        isMobile={isMobile}
                        driverColor={driverColor}
                        driverTextColor={driverTextColor} />);
                  })}

                  {/* BookOff / Unassigned slots */}
                  {noDriverEntries.length > 0 &&
                  <UnassignedGroupCard
                    noDriverEntries={noDriverEntries}
                    date={date}
                    dateStr={dateStr}
                    isAdmin={isAdmin}
                    drivers={drivers}
                    appUsers={appUsers}
                    currentUser={currentUser}
                    onDriverChange={handleDriverChange}
                    overrides={overrides}
                    deliveriesByDay={deliveriesByDay}
                    unlockedSlots={unlockedSlots}
                    onToggleSlotLock={handleToggleSlotLock}
                    isMobile={isMobile}
                    dragItem={dragItem}
                    setDragItem={setDragItem} />
                  }

                  {/* Stat Holiday Banner — fills remaining space with diagonal text */}
                  {statHoliday && <StatHolidayBanner name={statHoliday.holiday_name} />}

                  {/* Drop zones when dragging */}
                  {!isMobile && dragItem?.dateStr === dateStr && (() => {

                    // If there's already an unassigned/booked-off card visible, it acts as the book-off drop zone
                    const hasNoDriverCard = noDriverEntries.length > 0;
                    if (isAdmin) return (
                      <>
                        {!hasNoDriverCard && <BookOffDropZone dateStr={dateStr} dragItem={dragItem} onDriverChange={handleDriverChange} />}
                        <DriverDropTargets
                          drivers={drivers}
                          dateStr={dateStr}
                          dragItem={dragItem}
                          onDriverChange={handleDriverChange}
                          existingDriverIds={sortedDriverIds} />
                      </>);
                    // Drivers: show BookOff zone only if no unassigned card, plus their own drop target
                    const myDriverId = currentUser?.id;
                    const myDriver = appUsers.find((u) => u.user_id === myDriverId || u.id === myDriverId);
                    if (!myDriver) return null;
                    const driverColor = generateDriverColor(myDriver.user_name || myDriverId);
                    return (
                      <>
                        {!hasNoDriverCard && <BookOffDropZone dateStr={dateStr} dragItem={dragItem} onDriverChange={handleDriverChange} />}
                        {!sortedDriverIds.includes(myDriverId) &&
                        <DriverDropTarget
                          driverId={myDriverId}
                          driverName={myDriver.user_name}
                          driverColor={driverColor}
                          dateStr={dateStr}
                          onDriverChange={handleDriverChange} />
                        }
                      </>);
                  })()}
                </div>
              </div>);
          })}
        </div>
      </div>
    </div>);
}

// ── StatHolidayBanner ─────────────────────────────────────────────────────────

function StatHolidayBanner({ name }) {
  const ref = useRef(null);
  const [angle, setAngle] = useState(-35);

  useEffect(() => {
    if (!ref.current) return;
    const { offsetWidth: w, offsetHeight: h } = ref.current;
    if (w && h) setAngle(-Math.atan2(h, w) * (180 / Math.PI));
    const ro = new ResizeObserver(([entry]) => {
      const { width: w2, height: h2 } = entry.contentRect;
      if (w2 && h2) setAngle(-Math.atan2(h2, w2) * (180 / Math.PI));
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className="flex-1 rounded-lg overflow-hidden relative"
      style={{ background: '#fef9c3', border: '1px solid #fde047', minHeight: 40 }}>
      <div style={{
        position: 'absolute',
        top: '50%', left: '50%',
        width: '200%',
        transform: `translate(-50%, -50%) rotate(${angle}deg)`,
        textAlign: 'center',
        pointerEvents: 'none',
      }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: '#78350f', letterSpacing: '0.04em', lineHeight: 1.3 }}>
          🎉 {name} 🎉
        </div>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#92400e', marginTop: 1, opacity: 0.85 }}>
          Stat Holiday
        </div>
      </div>
    </div>);
}

// ── MobileDriverGroup ─────────────────────────────────────────────────────────

function MobileDriverGroup({ driverId, driver, entries, date, overrides, drivers, appUsers, currentUser,
  onDriverChange, deliveriesByDay, isAdmin, unlockedSlots, onToggleSlotLock, isMobile, driverColor, driverTextColor }) {

  const past = isPastDate(date);
  const [bookOffOpen, setBookOffOpen] = useState(false);
  const canBookOffDay = !past && (isAdmin || driverId === currentUser?.id);

  const isMyGroup = isAdmin || driverId === currentUser?.id;
  const dateKey = format(date, 'yyyy-MM-dd');
  const total = isMyGroup ? entries.reduce((sum, { store, slotKey }) => {
    const isAM = slotKey.endsWith('_am');
    const ampm = isAM ? 'AM' : 'PM';
    return sum + (deliveriesByDay?.[dateKey]?.filter(
      (d) => d.driver_id === driverId && d.store_id === store.id &&
      ((d.patient_id && d.patient_id !== '') || d._interstore_source_id || d._interstore_dest_id) && (
      !d.ampm_deliveries || d.ampm_deliveries === ampm)
    ).length || 0);
  }, 0) : 0;

  const scheduledEntries = entries.filter((e) => !e.isDeliveryDriven);
  const canBookOff = canBookOffDay && scheduledEntries.length > 0;

  const header =
  <div className="grid items-center w-full py-1 px-1" style={{ gridTemplateColumns: '26px 26px 1fr 28px 14px', background: driverColor, color: driverTextColor }}>
      <span />
      <span />
      <span className="text-xs font-bold truncate text-center px-1">
        {driver?.user_name || 'Unknown Driver'}
      </span>
      <span className={`text-[9px] font-semibold rounded-full leading-4 h-4 inline-flex items-center justify-center ${total > 0 ? '' : 'invisible'}`}
    style={{ background: 'rgba(255,255,255,0.3)', color: driverTextColor }}>
        {total}
      </span>
      <span className={`inline-flex items-center justify-center opacity-70 ${canBookOff ? '' : 'invisible'}`}>
        <ChevronDown className="w-2.5 h-2.5" style={{ color: driverTextColor }} />
      </span>
    </div>;

  return (
    <div className="rounded-lg overflow-hidden" style={{ border: `1.5px solid ${driverColor}55`, background: 'var(--bg-white)' }}>
      {canBookOff ?
      <Popover open={bookOffOpen} onOpenChange={setBookOffOpen}>
          <PopoverTrigger asChild>
            <div className="cursor-pointer">{header}</div>
          </PopoverTrigger>
          <PopoverContent className="w-44 p-1" align="end">
            <div className="text-[10px] font-semibold px-2 py-1" style={{ color: 'var(--text-slate-500)' }}>
              {format(date, 'EEE, MMM d')}
            </div>
            <button
            className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-orange-100 text-orange-700 font-medium"
            onClick={() => {
              setBookOffOpen(false);
              scheduledEntries.forEach(({ store, slotKey }) => {
                onDriverChange(date, slotKey, store, '__none__');
              });
            }}>
              🚫 Book Off Entire Day
            </button>
          </PopoverContent>
        </Popover> :
      header}
      <div className="p-1 space-y-1">
        {entries.map(({ store, slotKey, isDeliveryDriven }) =>
        <DriverSlotCell
          key={`${store.id}-${slotKey}`}
          date={date} slotKey={slotKey} store={store}
          overrides={overrides} drivers={drivers} appUsers={appUsers}
          currentUser={currentUser} onDriverChange={onDriverChange}
          deliveriesByDay={deliveriesByDay} isAdmin={isAdmin}
          unlockedSlots={unlockedSlots} onToggleSlotLock={onToggleSlotLock}
          isMobile={isMobile}
          isDeliveryDriven={isDeliveryDriven}
          deliveryDrivenDriverId={isDeliveryDriven ? driverId : null} />
        )}
      </div>
    </div>);
}

// ── DriverGroupDraggable ──────────────────────────────────────────────────────

function DriverGroupDraggable({ driverId, driver, entries, date, overrides, drivers, appUsers, currentUser,
  onDriverChange, deliveriesByDay, isAdmin, unlockedSlots, onToggleSlotLock, isMobile, dragItem, onDragStart, stores }) {

  const dateStr = format(date, 'yyyy-MM-dd');
  const past = isPastDate(date);
  const [isDragOver, setIsDragOver] = useState(false);
  const [bookOffOpen, setBookOffOpen] = useState(false);

  const scheduledEntries = entries.filter((e) => !e.isDeliveryDriven);

  // Check if at least one scheduled entry is still editable (not locked)
  const hasEditableScheduledEntry = scheduledEntries.some(({ store, slotKey }) => {
    const lockKey = slotLockKey(dateStr, store.id, slotKey);
    const adminUnlocked = isAdmin && unlockedSlots.has(lockKey);
    if (adminUnlocked) return true;
    if (isToday(date)) {
      const isAMSlot = slotKey.endsWith('_am');
      const override = overrides.find((o) => o.date === dateStr && o.slot_key === slotKey && o.store_id === store.id);
      const defaultDriverIdSlot = getDefaultDriverId(store, slotKey);
      const effectiveDriverIdSlot = override ? override.driver_id : defaultDriverIdSlot;
      return !isSlotLockedToday(deliveriesByDay, dateStr, effectiveDriverIdSlot, store.id, isAMSlot);
    }
    return true;
  });

  const canBookOffDay = !past && (isAdmin || driverId === currentUser?.id) && scheduledEntries.length > 0 && hasEditableScheduledEntry;

  const driverColor = generateDriverColor(driver?.user_name || driverId);
  const driverTextColor = getContrastColor(driverColor);

  const isDraggingMySlot = dragItem && dragItem.dateStr === dateStr &&
  entries.find((e) => e.store.id === dragItem.storeId && e.slotKey === dragItem.slotKey);

  const canAcceptDrop = isAdmin || driverId === currentUser?.id;

  const handleDragOver = (e) => {
    if (!dragItem || dragItem.dateStr !== dateStr || isDraggingMySlot || !canAcceptDrop) return;
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragOver(false);
    const raw = e.dataTransfer.getData('text/plain');
    let payload;try {payload = JSON.parse(raw);} catch {return;}
    if (payload.dateStr !== dateStr) return;
    const fakeDate = new Date(payload.dateStr + 'T12:00:00');
    onDriverChange(fakeDate, payload.slotKey, { id: payload.storeId, __needsLookup: true }, driverId);
  };

  return (
    <div
      className="rounded-lg overflow-hidden transition-all"
      style={{
        border: `1.5px solid ${isDragOver ? driverColor : driverColor + '55'}`,
        background: isDragOver ? driverColor + '18' : 'var(--bg-white)',
        outline: isDragOver ? `2px dashed ${driverColor}` : undefined,
        outlineOffset: 2
      }}
      onDragOver={handleDragOver}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}>
      {(() => {
        const isMyGroup = isAdmin || driverId === currentUser?.id;
        const dateKey = format(date, 'yyyy-MM-dd');
        const total = isMyGroup ? entries.reduce((sum, { store, slotKey }) => {
          const isAM = slotKey.endsWith('_am');
          const ampm = isAM ? 'AM' : 'PM';
          return sum + (deliveriesByDay?.[dateKey]?.filter(
            (d) => d.driver_id === driverId && d.store_id === store.id &&
            ((d.patient_id && d.patient_id !== '') || d._interstore_source_id || d._interstore_dest_id) && (
            !d.ampm_deliveries || d.ampm_deliveries === ampm)
          ).length || 0);
        }, 0) : 0;

        // All lock keys for this driver's scheduled entries
        const allLockKeys = scheduledEntries.map(({ store, slotKey }) => slotLockKey(dateStr, store.id, slotKey));
        const allUnlocked = allLockKeys.length > 0 && allLockKeys.every((k) => unlockedSlots.has(k));
        const anyUnlocked = allLockKeys.some((k) => unlockedSlots.has(k));
        const showLock = isAdmin && (!canBookOffDay || anyUnlocked) && scheduledEntries.length > 0;

        const handleToggleAllLocks = (e) => {
          e.stopPropagation();
          allLockKeys.forEach((k) => onToggleSlotLock(k));
        };

        const headerContent =
        <div className="grid items-center w-full py-1 mb-0.5 px-3" style={{ gridTemplateColumns: '26px 26px 1fr 28px 14px' }}>
            <span />
            <span />
            <span className="text-xs font-bold truncate text-center px-1">
              {driver?.user_name || 'Unknown Driver'}
              {isDragOver && <span className="ml-2 font-normal opacity-75">← Drop here</span>}
            </span>
            <span className={`text-[9px] font-semibold rounded-full leading-4 h-4 inline-flex items-center justify-center ${total > 0 ? '' : 'invisible'}`}
          style={{ background: 'rgba(255,255,255,0.3)', color: driverTextColor }}>
              {total}
            </span>
            <span className="inline-flex items-center justify-center">
              {showLock ?
            <span
              title={allUnlocked ? 'Click to lock all slots' : 'Click to unlock all slots'}
              style={{ cursor: 'pointer', lineHeight: 0 }}
              onClick={handleToggleAllLocks}>
                  {allUnlocked ?
              <LockOpen className="w-2.5 h-2.5 text-orange-500" /> :
              <Lock className="w-2.5 h-2.5" style={{ color: '#000000' }} />}
                </span> :
            canBookOffDay ?
            <ChevronDown className="w-2.5 h-2.5 opacity-70" style={{ color: driverTextColor }} /> :
            null}
            </span>
          </div>;

        return canBookOffDay ?
        <Popover open={bookOffOpen} onOpenChange={setBookOffOpen}>
            <PopoverTrigger asChild>
              <div className="cursor-pointer" style={{ background: driverColor, color: driverTextColor }}>
                {headerContent}
              </div>
            </PopoverTrigger>
            <PopoverContent className="w-44 p-1" align="end">
              <div className="text-[10px] font-semibold px-2 py-1" style={{ color: 'var(--text-slate-500)' }}>
                {format(date, 'EEE, MMM d')}
              </div>
              <button
              className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-orange-100 text-orange-700 font-medium"
              onClick={() => {
                setBookOffOpen(false);
                scheduledEntries.forEach(({ store, slotKey }) => {
                  onDriverChange(date, slotKey, store, '__none__');
                });
              }}>
                🚫 Book Off Entire Day
              </button>
            </PopoverContent>
          </Popover> :

        <div style={{ background: driverColor, color: driverTextColor }}>
            {headerContent}
          </div>;
      })()}
      <div className="p-1 space-y-1">
        {[...entries].sort((a, b) => (a.startTime || '').localeCompare(b.startTime || '')).map(({ store, slotKey, isDeliveryDriven }) => {
          const lockKey = slotLockKey(dateStr, store.id, slotKey);
          const adminUnlocked = isAdmin && unlockedSlots.has(lockKey);
          const isAMSlot = slotKey.endsWith('_am');
          const override = overrides.find((o) => o.date === dateStr && o.slot_key === slotKey && o.store_id === store.id);
          const defaultDriverIdSlot = getDefaultDriverId(store, slotKey);
          const effectiveDriverIdSlot = override ? override.driver_id : defaultDriverIdSlot;
          const slotLockedToday = isToday(date) && isSlotLockedToday(deliveriesByDay, dateStr, effectiveDriverIdSlot, store.id, isAMSlot);
          // Delivery-driven slots cannot be dragged (they're not schedule entries)
          const canDrag = !isDeliveryDriven && (adminUnlocked || !past && !(isToday(date) && slotLockedToday));
          return (
            <div
              key={`${store.id}-${slotKey}`}
              draggable={canDrag}
              onDragStart={canDrag ? (e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', JSON.stringify({ dateStr, slotKey, storeId: store.id }));
                onDragStart({ dateStr, slotKey, storeId: store.id });
              } : undefined}
              style={{ cursor: canDrag ? 'grab' : undefined }}>
              <DriverSlotCell
                date={date} slotKey={slotKey} store={store}
                overrides={overrides} drivers={drivers} appUsers={appUsers}
                currentUser={currentUser} onDriverChange={onDriverChange}
                deliveriesByDay={deliveriesByDay} isAdmin={isAdmin}
                unlockedSlots={unlockedSlots} onToggleSlotLock={onToggleSlotLock}
                isMobile={isMobile}
                isDeliveryDriven={isDeliveryDriven}
                deliveryDrivenDriverId={isDeliveryDriven ? driverId : null} />
            </div>);
        })}
      </div>
    </div>);
}

// ── UnassignedGroupCard ───────────────────────────────────────────────────────

function UnassignedGroupCard({ noDriverEntries, date, dateStr, isAdmin, drivers, appUsers, currentUser,
  onDriverChange, overrides, deliveriesByDay, unlockedSlots, onToggleSlotLock, isMobile, dragItem, setDragItem }) {
  const [isDropHover, setIsDropHover] = useState(false);
  const hasBookedOff = noDriverEntries.some((e) => e.isBookedOff);
  const isDragTarget = dragItem?.dateStr === dateStr;

  return (
    <div
      className="rounded-lg overflow-hidden border border-dashed transition-all"
      style={{
        borderColor: isDropHover ? '#ea580c' : hasBookedOff ? '#f97316' : isDragTarget ? 'var(--border-slate-400)' : 'var(--border-slate-300)',
        background: isDropHover ? '#fff3e0' : undefined,
        boxShadow: isDropHover ? '0 0 0 2px #f9731666' : undefined
      }}
      onDragOver={(e) => {if (!isDragTarget) return;e.preventDefault();setIsDropHover(true);}}
      onDragLeave={() => setIsDropHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDropHover(false);
        const raw = e.dataTransfer.getData('text/plain');
        let payload;try {payload = JSON.parse(raw);} catch {return;}
        if (payload.dateStr !== dateStr) return;
        onDriverChange(new Date(payload.dateStr + 'T12:00:00'), payload.slotKey, { id: payload.storeId, __needsLookup: true }, '__none__');
      }}>
      <UnassignedGroupHeader
        noDriverEntries={noDriverEntries}
        date={date}
        isAdmin={isAdmin}
        drivers={drivers}
        onDriverChange={onDriverChange}
        currentUser={currentUser} />
      
      <div className="p-1 space-y-1">
        {noDriverEntries.map(({ store, slotKey, isBookedOff }) => {
          const canDrag = !isMobile && (isAdmin || isBookedOff);
          return (
            <div
              key={`${store.id}-${slotKey}`}
              draggable={canDrag}
              onDragStart={canDrag ? (e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', JSON.stringify({ dateStr, slotKey, storeId: store.id }));
                setDragItem({ dateStr, slotKey, storeId: store.id });
              } : undefined}
              style={{ cursor: canDrag ? 'grab' : undefined }}>
              <DriverSlotCell
                date={date} slotKey={slotKey} store={store}
                overrides={overrides} drivers={drivers} appUsers={appUsers}
                currentUser={currentUser} onDriverChange={onDriverChange}
                deliveriesByDay={deliveriesByDay} isAdmin={isAdmin}
                unlockedSlots={unlockedSlots} onToggleSlotLock={onToggleSlotLock}
                isMobile={isMobile} />
            </div>);
        })}
      </div>
    </div>);
}

// ── UnassignedGroupHeader ─────────────────────────────────────────────────────

function UnassignedGroupHeader({ noDriverEntries, date, isAdmin, drivers, onDriverChange, currentUser }) {
  const [open, setOpen] = useState(false);
  const hasBookedOff = noDriverEntries.some((e) => e.isBookedOff);
  // All entries (booked off + unassigned) are reassignable
  const reassignableEntries = noDriverEntries;

  // Always open if there are any entries and a current user
  const canOpen = reassignableEntries.length > 0 && !!currentUser?.id;

  const label = hasBookedOff ? '🚫 Booked Off' : 'Unassigned';
  const color = hasBookedOff ? '#ea580c' : 'var(--text-slate-400)';
  const bg = hasBookedOff ? '#fff7ed' : 'var(--bg-slate-50)';

  const header =
  <div className="flex items-center w-full py-1 px-2 text-xs font-medium" style={{ color, background: bg }}>
      <span className="flex-1 truncate">{label}</span>
      <ChevronDown className="w-3 h-3 opacity-60 flex-shrink-0" />
    </div>;


  if (!canOpen) return header;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div className="cursor-pointer">{header}</div>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-1" align="start">
        <div className="text-[10px] font-semibold px-2 py-1" style={{ color: 'var(--text-slate-500)' }}>
          {isAdmin ? 'Assign all to driver' : 'Accept all slots'}
        </div>
        {!isAdmin &&
        <button
          className="w-full text-left text-xs px-2 py-1.5 rounded bg-green-100 hover:bg-green-200 text-green-800 font-semibold"
          onClick={() => {
            setOpen(false);
            reassignableEntries.forEach(({ store, slotKey }) => {
              onDriverChange(date, slotKey, store, currentUser.id);
            });
          }}>
            ✓ Accept All — assign to me
          </button>
        }
        {isAdmin && drivers.map((d) =>
        <button
          key={d.user_id || d.id}
          className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-amber-400 hover:text-black"
          style={{ color: 'var(--text-slate-700)' }}
          onClick={() => {
            setOpen(false);
            reassignableEntries.forEach(({ store, slotKey }) => {
              onDriverChange(date, slotKey, store, d.user_id || d.id);
            });
          }}>
            {d.user_name}
          </button>
        )}
      </PopoverContent>
    </Popover>);

}

// ── BookOffDropZone ────────────────────────────────────────────────────────

function BookOffDropZone({ dateStr, dragItem, onDriverChange }) {
  const [isDragOver, setIsDragOver] = useState(false);
  return (
    <div
      className="rounded-md border-2 border-dashed px-2 py-1 text-[9px] text-center transition-colors"
      style={isDragOver ?
      { borderColor: 'var(--border-slate-400)', background: 'var(--bg-slate-100)', color: 'var(--text-slate-600)' } :
      { borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-400)', background: 'transparent' }}
      onDragOver={(e) => {if (!dragItem || dragItem.dateStr !== dateStr) return;e.preventDefault();setIsDragOver(true);}}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();setIsDragOver(false);
        const raw = e.dataTransfer.getData('text/plain');
        let payload;try {payload = JSON.parse(raw);} catch {return;}
        onDriverChange(new Date(payload.dateStr + 'T12:00:00'), payload.slotKey, { id: payload.storeId, __needsLookup: true }, '__none__');
      }}>
      {isDragOver ? 'Drop to Book Off' : 'Book Off'}
    </div>);
}

// ── DriverDropTargets ─────────────────────────────────────────────────────────

function DriverDropTargets({ drivers, dateStr, dragItem, onDriverChange, existingDriverIds }) {
  const newDriverTargets = drivers.filter((d) => !existingDriverIds.includes(d.user_id || d.id));
  if (newDriverTargets.length === 0) return null;
  return (
    <div className="space-y-1">
      {newDriverTargets.map((d) => {
        const driverId = d.user_id || d.id;
        const driverColor = generateDriverColor(d.user_name || driverId);
        return (
          <DriverDropTarget
            key={driverId}
            driverId={driverId}
            driverName={d.user_name}
            driverColor={driverColor}
            dateStr={dateStr}
            onDriverChange={onDriverChange} />);
      })}
    </div>);
}

function DriverDropTarget({ driverId, driverName, driverColor, dateStr, onDriverChange }) {
  const [isDragOver, setIsDragOver] = useState(false);
  return (
    <div
      className="rounded-md border-2 border-dashed px-2 py-1 text-[9px] text-center transition-all"
      style={{
        borderColor: isDragOver ? driverColor : driverColor + '44',
        background: isDragOver ? driverColor + '15' : 'transparent',
        color: isDragOver ? driverColor : driverColor + '99'
      }}
      onDragOver={(e) => {e.preventDefault();setIsDragOver(true);}}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();setIsDragOver(false);
        const raw = e.dataTransfer.getData('text/plain');
        let payload;try {payload = JSON.parse(raw);} catch {return;}
        onDriverChange(new Date(payload.dateStr + 'T12:00:00'), payload.slotKey, { id: payload.storeId, __needsLookup: true }, driverId);
      }}>
      {isDragOver ? `Assign to ${driverName}` : `+ ${driverName}`}
    </div>);
}