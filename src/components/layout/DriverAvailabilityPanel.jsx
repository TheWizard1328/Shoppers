import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Truck, Clock, AlertCircle, CheckCircle2, Radio, X, Loader2, ChevronUp } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { userHasRole } from '@/components/utils/userRoles';

/**
 * DriverAvailabilityPanel
 * ----------------------------------------------------------------------------
 * Sidebar panel for dispatchers to request an available driver for pickup.
 * Sits just above the SidebarUserFooter (driver info cards).
 *
 * States:
 *  - idle        — Button enabled (or disabled with reason)
 *  - waiting     — Assigned driver(s) pinged, 2-min countdown + Escalate Now
 *  - broadcast    — Request sent to all city drivers
 *  - response    — Driver(s) responded Yes
 *  - cooldown    — 5-min cooldown after broadcast
 */

const POLL_INTERVAL = 5000; // 5s poll for status updates
const TWO_MIN_MS = 2 * 60 * 1000;
const FIVE_MIN_MS = 5 * 60 * 1000;

function formatCountdown(ms) {
  if (ms <= 0) return '0:00';
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

export default function DriverAvailabilityPanel({ currentUser, stores, appUsers, deliveries }) {
  // Only dispatchers see this panel
  const isDispatcher = currentUser && userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin');
  const isAdmin = currentUser && userHasRole(currentUser, 'admin');

  // Admins can also use it (for testing / managing)
  const canUse = isDispatcher || isAdmin;
  const [guardPassed, setGuardPassed] = useState(true);
  const [guardLoading, setGuardLoading] = useState(false);
  const [showDialog, setShowDialog] = useState(false);
  const [activeRequest, setActiveRequest] = useState(null);
  const [phase, setPhase] = useState('idle'); // idle, waiting, broadcast, response, cooldown
  const [countdownMs, setCountdownMs] = useState(0);
  const [escalating, setEscalating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // Dialog form state
  const [extraInfo, setExtraInfo] = useState('');
  const [selectedDriverId, setSelectedDriverId] = useState('all');

  // Dispatcher's store(s)
  const dispatcherStoreIds = useMemo(() => currentUser?.store_ids || [], [currentUser]);
  const dispatcherStores = useMemo(() =>
    (stores || []).filter(s => dispatcherStoreIds.includes(s?.id)),
    [stores, dispatcherStoreIds]
  );

  // City + company info from dispatcher's stores
  const cityId = dispatcherStores[0]?.city_id || '';
  const companyId = dispatcherStores[0]?.company_id || '';
  const cityName = (() => {
    const cid = cityId;
    // Try to find city name from stores
    return '';
  })();

  // Drivers for the current city + company (for dialog dropdown)
  const cityDrivers = useMemo(() => {
    if (!appUsers) return [];
    return appUsers
      .filter(au =>
        au?.status === 'active' &&
        Array.isArray(au.app_roles) &&
        au.app_roles.includes('driver') &&
        (cityId ? (au.city_ids?.includes(cityId) || au.city_id === cityId) : true)
      )
      .sort((a, b) => (a.user_name || '').localeCompare(b.user_name || ''));
  }, [appUsers, cityId]);

  // ── Guard check: any driver with isNextDelivery=true for dispatcher's store? ──
  const checkGuard = useCallback(async () => {
    if (!canUse || dispatcherStoreIds.length === 0) return;
    setGuardLoading(true);
    try {
      // Check locally first — faster than backend call
      const today = new Date().toISOString().split('T')[0];
      const TERMINAL = ['completed', 'failed', 'cancelled'];
      const todayDeliveries = (deliveries || []).filter(d =>
        d?.delivery_date === today &&
        dispatcherStoreIds.includes(d?.store_id)
      );
      const blocking = todayDeliveries.filter(d =>
        d?.isNextDelivery === true && !TERMINAL.includes(d?.status)
      );
      setGuardPassed(blocking.length === 0);
    } catch (e) {
      // Fallback to backend
      for (const storeId of dispatcherStoreIds) {
        try {
          const result = await base44.functions.invoke('driverAvailabilityManager', {
            action: 'check_guard',
            store_id: storeId
          });
          if (!result.guard_passed) {
            setGuardPassed(false);
            break;
          }
        } catch (err) {
          console.error('[DriverAvailabilityPanel] Guard check failed:', err);
        }
      }
    } finally {
      setGuardLoading(false);
    }
  }, [canUse, dispatcherStoreIds, deliveries]);

  // ── Check for active request on mount ──
  const checkActiveRequest = useCallback(async () => {
    if (!canUse || !currentUser) return;
    try {
      const result = await base44.functions.invoke('driverAvailabilityManager', {
        action: 'get_active',
        dispatcher_id: currentUser.id
      });
      if (result.active_request) {
        const req = result.active_request;
        // If the request is 'waiting' but its timeout already expired, immediately
        // trigger the timeout check instead of showing a stale countdown — this
        // auto-escalates or clears the request so the dispatcher isn't stuck.
        if (req.status === 'waiting' && req.timeout_expires_at) {
          const expired = new Date(req.timeout_expires_at).getTime() <= Date.now();
          if (expired) {
            try {
              const timeoutResult = await base44.functions.invoke('driverAvailabilityManager', {
                action: 'check_timeout',
                request_id: req.id
              });
              if (timeoutResult.status === 'escalated' || timeoutResult.phase === 'broadcast') {
                setActiveRequest(timeoutResult.request || { ...req, status: 'escalated' });
                setPhase('broadcast');
                return;
              }
            } catch (_) { /* fall through to stale handling */ }
            // If timeout check didn't escalate, treat as stale — go idle
            setActiveRequest(null);
            setPhase('idle');
            return;
          }
        }
        setActiveRequest(req);
        if (req.status === 'waiting') {
          setPhase('waiting');
        } else if (req.status === 'escalated') {
          setPhase('broadcast');
        } else if (req.status === 'completed') {
          setPhase('response');
        } else if (req.status === 'expired' || req.status === 'cancelled') {
          // Stale request — don't show it, just go idle
          setActiveRequest(null);
          setPhase('idle');
        }
      }
    } catch (e) {
      console.error('[DriverAvailabilityPanel] Failed to check active request:', e);
    }
  }, [canUse, currentUser]);

  useEffect(() => {
    if (!canUse) return;
    checkGuard();
    checkActiveRequest();
  }, [canUse, checkGuard, checkActiveRequest]);

  // ── Poll for timeout/status when in waiting phase ──
  useEffect(() => {
    if (phase !== 'waiting' || !activeRequest) return;
    const interval = setInterval(async () => {
      try {
        const result = await base44.functions.invoke('driverAvailabilityManager', {
          action: 'check_timeout',
          request_id: activeRequest.id
        });
        if (result.status === 'escalated' || result.phase === 'broadcast') {
          setActiveRequest(result.request || { ...activeRequest, status: 'escalated' });
          setPhase('broadcast');
        } else if (result.status === 'completed') {
          setActiveRequest(prev => ({ ...prev, status: 'completed' }));
          setPhase('response');
        }
      } catch (e) {
        console.error('[DriverAvailabilityPanel] Timeout poll failed:', e);
      }
    }, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [phase, activeRequest]);

  // ── Countdown timer ──
  useEffect(() => {
    if (phase === 'waiting' && activeRequest?.timeout_expires_at) {
      const update = () => {
        const remaining = new Date(activeRequest.timeout_expires_at).getTime() - Date.now();
        setCountdownMs(Math.max(0, remaining));
        if (remaining <= 0) {
          // Timeout will be handled by poll
        }
      };
      update();
      const interval = setInterval(update, 1000);
      return () => clearInterval(interval);
    } else if (phase === 'cooldown' && activeRequest?.cooldown_expires_at) {
      const update = () => {
        const remaining = new Date(activeRequest.cooldown_expires_at).getTime() - Date.now();
        setCountdownMs(Math.max(0, remaining));
        if (remaining <= 0) {
          setPhase('idle');
          setActiveRequest(null);
        }
      };
      update();
      const interval = setInterval(update, 1000);
      return () => clearInterval(interval);
    }
  }, [phase, activeRequest]);

  // ── Listen for driver responses via WS ──
  useEffect(() => {
    if (!canUse) return;
    const handleMessage = (event) => {
      const { type, data, changedFields } = event?.detail || {};
      if (type !== 'create' && type !== 'update') return;
      if (!data) return;
      // Check if this is a DriverAvailabilityRequest update for our request
      if (data.dispatcher_id !== currentUser?.id) return;

      if (data.status === 'completed' && data.responded_driver_name) {
        setActiveRequest(data);
        setPhase('response');
      } else if (data.status === 'escalated') {
        setActiveRequest(data);
        setPhase('broadcast');
      }
    };
    window.addEventListener('realtimeUpdate_DriverAvailabilityRequest', handleMessage);
    return () => window.removeEventListener('realtimeUpdate_DriverAvailabilityRequest', handleMessage);
  }, [canUse, currentUser]);

  // ── Submit request ──
  const handleSubmit = useCallback(async () => {
    if (dispatcherStoreIds.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const store = dispatcherStores[0];
      const result = await base44.functions.invoke('driverAvailabilityManager', {
        action: 'create_request',
        store_id: store.id,
        store_name: store.name,
        city_id: cityId,
        company_id: companyId,
        extra_info: extraInfo.trim() || undefined,
        specific_driver_id: selectedDriverId
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      setShowDialog(false);
      setExtraInfo('');
      setSelectedDriverId('all');
      if (result.request) {
        setActiveRequest(result.request);
        if (result.phase === 'waiting') {
          setPhase('waiting');
        } else if (result.phase === 'broadcast') {
          setPhase('broadcast');
        }
      }
    } catch (e) {
      setError(e?.message || 'Failed to send request');
    } finally {
      setSubmitting(false);
    }
  }, [dispatcherStoreIds, dispatcherStores, cityId, companyId, extraInfo, selectedDriverId]);

  // ── Escalate Now ──
  const handleEscalate = useCallback(async () => {
    if (!activeRequest) return;
    setEscalating(true);
    try {
      const result = await base44.functions.invoke('driverAvailabilityManager', {
        action: 'escalate_now',
        request_id: activeRequest.id
      });
      if (result.request) {
        setActiveRequest(result.request);
        setPhase('broadcast');
      }
    } catch (e) {
      console.error('[DriverAvailabilityPanel] Escalate failed:', e);
    } finally {
      setEscalating(false);
    }
  }, [activeRequest]);

  // ── Cancel request ──
  const handleCancel = useCallback(async () => {
    if (!activeRequest) return;
    try {
      await base44.functions.invoke('driverAvailabilityManager', {
        action: 'cancel',
        request_id: activeRequest.id
      });
      setPhase('idle');
      setActiveRequest(null);
    } catch (e) {
      console.error('[DriverAvailabilityPanel] Cancel failed:', e);
    }
  }, [activeRequest]);

  // ── When broadcast completes, transition to cooldown ──
  useEffect(() => {
    if (phase === 'broadcast' && activeRequest?.cooldown_expires_at) {
      const cooldownEnd = new Date(activeRequest.cooldown_expires_at).getTime();
      if (Date.now() < cooldownEnd) {
        // Show broadcast status briefly, then transition to cooldown view
        const timer = setTimeout(() => {
          setPhase('cooldown');
        }, 3000);
        return () => clearTimeout(timer);
      }
    }
  }, [phase, activeRequest]);

  // ── Render ──
  if (!canUse || dispatcherStoreIds.length === 0) return null;

  return (
    <>
      {/* Panel container — sits above driver info cards */}
      <div className="px-2 pt-1 pb-1 border-t" style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)' }}>
        {/* IDLE STATE */}
        {phase === 'idle' && (
          <div className="flex flex-col gap-1">
            <Button
              size="sm"
              className="w-full gap-1.5 text-xs font-semibold"
              disabled={!guardPassed || guardLoading}
              onClick={() => setShowDialog(true)}
              style={guardPassed ? {
                background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                color: 'white'
              } : {
                background: 'var(--bg-slate-100)',
                color: 'var(--text-slate-400)'
              }}
            >
              {guardLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Truck className="w-3.5 h-3.5" />}
              {guardPassed ? 'Request A Driver' : 'Driver en route'}
            </Button>
            {!guardPassed && (
              <p className="text-[10px] text-slate-400 px-1">A driver is already heading to your store</p>
            )}
          </div>
        )}

        {/* WAITING STATE */}
        {phase === 'waiting' && activeRequest && (
          <div className="rounded-lg border p-2 flex flex-col gap-1.5" style={{ borderColor: '#c7d2fe', background: 'linear-gradient(135deg, #eef2ff, #f5f3ff)' }}>
            <div className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-indigo-500 animate-pulse" />
              <span className="text-[11px] font-semibold text-indigo-700 truncate flex-1">
                Waiting for assigned driver(s)...
              </span>
              <span className="text-[11px] font-bold text-indigo-600 tabular-nums">
                {formatCountdown(countdownMs)}
              </span>
            </div>
            {activeRequest.assigned_driver_ids?.length > 0 && (
              <p className="text-[10px] text-indigo-500 px-0.5">
                {activeRequest.assigned_driver_ids.length} driver(s) notified
              </p>
            )}
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="destructive"
                className="flex-1 h-7 text-[11px] gap-1"
                onClick={handleEscalate}
                disabled={escalating}
              >
                {escalating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Radio className="w-3 h-3" />}
                Escalate Now
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-[11px] px-2"
                onClick={handleCancel}
              >
                <X className="w-3 h-3" />
              </Button>
            </div>
          </div>
        )}

        {/* BROADCAST STATE */}
        {phase === 'broadcast' && activeRequest && (
          <div className="rounded-lg border p-2 flex flex-col gap-1.5" style={{ borderColor: '#fde68a', background: 'linear-gradient(135deg, #fffbeb, #fefce8)' }}>
            <div className="flex items-center gap-1.5">
              <Radio className="w-3.5 h-3.5 text-amber-500" />
              <span className="text-[11px] font-semibold text-amber-700 truncate flex-1">
                Request sent to all drivers in city...
              </span>
            </div>
            {activeRequest.broadcast_driver_ids?.length > 0 && (
              <p className="text-[10px] text-amber-600 px-0.5">
                {activeRequest.broadcast_driver_ids.length} driver(s) notified
              </p>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-[11px] gap-1 self-end"
              onClick={handleCancel}
            >
              <X className="w-3 h-3" /> Cancel
            </Button>
          </div>
        )}

        {/* RESPONSE STATE */}
        {phase === 'response' && activeRequest && (
          <div className="rounded-lg border p-2 flex flex-col gap-1" style={{ borderColor: '#bbf7d0', background: 'linear-gradient(135deg, #f0fdf4, #dcfce7)' }}>
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
              <span className="text-[11px] font-semibold text-emerald-700 truncate flex-1">
                {activeRequest.responded_driver_name || 'A driver'} is available ✓
              </span>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-[10px] gap-1 self-end"
              onClick={() => { setPhase('idle'); setActiveRequest(null); checkGuard(); }}
            >
              Dismiss
            </Button>
          </div>
        )}

        {/* COOLDOWN STATE */}
        {phase === 'cooldown' && (
          <div className="rounded-lg border p-2 flex flex-col gap-0.5" style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-slate-50)' }}>
            <div className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-slate-400" />
              <span className="text-[11px] font-semibold text-slate-500 truncate flex-1">
                Available in {formatCountdown(countdownMs)}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Request Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Truck className="w-4 h-4 text-indigo-500" />
              Request A Driver
            </DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-3 py-2">
            {/* Driver filter */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-slate-600">Send to</label>
              <Select value={selectedDriverId} onValueChange={setSelectedDriverId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a driver" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Drivers (auto-assigned first)</SelectItem>
                  {cityDrivers.map(driver => (
                    <SelectItem key={driver.user_id} value={driver.user_id}>
                      {driver.user_name || 'Unknown Driver'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Extra info */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-slate-600">
                Pickup details <span className="text-slate-400 font-normal">(optional)</span>
              </label>
              <Textarea
                placeholder="Add pickup details (optional)"
                value={extraInfo}
                onChange={(e) => setExtraInfo(e.target.value.slice(0, 200))}
                rows={3}
                className="resize-none text-sm"
                maxLength={200}
              />
              <p className="text-[10px] text-slate-400 text-right">{extraInfo.length}/200</p>
            </div>

            {error && (
              <div className="flex items-center gap-1.5 text-xs text-red-500">
                <AlertCircle className="w-3.5 h-3.5" />
                {error}
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            <DialogClose asChild>
              <Button variant="ghost" size="sm">Cancel</Button>
            </DialogClose>
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={submitting}
              className="gap-1.5"
              style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', color: 'white' }}
            >
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Radio className="w-3.5 h-3.5" />}
              Request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
