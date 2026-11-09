import React, { useCallback, useEffect, useRef, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { offlineDB } from './offlineDatabase';
import { updateDeliveryLocal } from './entityMutations';
import { locationTracker } from './locationTracker';
import { haversineMeters } from './geoUtils';
import { roundInstantToFiveMin } from './timeRoundingHelper';
import { edmontonTodayKey, edmontonWallString, parseAnyTimestamp } from './albertaTime';
import { isAppOwner } from './userRoles';
import setDriverStatusFn from '@/functions/setDriverStatus';

/**
 * autoIdleDetector — automatic break / off-duty detection (owner spec Nov 6 2026)
 * ══════════════════════════════════════════════════════════════════════════
 * TEST GATE: runs ONLY for the App Owner. Everyone else: the component mounts
 * and does nothing (see the early return below). Remove the gate once the
 * owner has watched it behave.
 *
 * The rules, exactly as the owner spec'd them:
 *
 *  1. PARKED = every fix within 150 m of the anchor AND speed under ~2 km/h.
 *     Parked for 30 min while on duty with ACTIVE stops  -> ask about a break.
 *     Parked for 30 min while on duty with NO active stops -> ask about off duty.
 *  2. Being parked AT one of the driver's own active (non-terminal) stops
 *     suppresses detection entirely. Cycling markers do NOT suppress, and
 *     sitting long at a FINISHED stop does NOT suppress.
 *  3. Answer window: 5 minutes. Silence applies the toggle automatically.
 *     'No' on the break ask re-asks after 30 min if still parked.
 *  4. Movement inside the 5-minute window cancels the pending toggle and the
 *     detector goes back to waiting for movement.
 *  5. The toggle is BACKDATED to the 5-minute mark after the last stop's own
 *     finish time (seconds stripped, rounded UP; if it is already on a mark it
 *     stays put). Never backdated to now-35 — it is tied to the stop.
 *  6. actual_delivery_time is only rounded when the toggle happened after the
 *     LAST finished stop. With stops still remaining the stop times are
 *     untouched.
 *  7. Leaving the finished last stop while still on duty: immediately off duty
 *     plus an INFORMATIONAL push (no buttons). The off-duty time and that
 *     stop's actual_delivery_time become the same value: the stop's finish
 *     time rounded UP to the next 5-minute mark.
 *  8. Resume: once a toggle was applied by this detector, moving past the parks
 *     radius asks "I've detected significant movement, are you back on duty?".
 *     5 minutes of silence -> on duty, backdated to the movement time ROUNDED
 *     DOWN to the 5-minute mark.
 */

const TICK_MS = 60 * 1000;
const PARK_RADIUS_M = 150;
const STOP_RADIUS_M = 100;
const PARK_TRIGGER_MS = 30 * 60 * 1000;
const ANSWER_WINDOW_MS = 5 * 60 * 1000;
const REASK_MS = 30 * 60 * 1000;
const SLOW_KMH = 2;
const STATE_KEY = 'rxdeliver_auto_idle_v1';
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

const nowMs = () => Date.now();
const kmhBetween = (a, b, dtMs) => {
  if (!a || !b || !dtMs) return 0;
  const m = haversineMeters(a.latitude, a.longitude, b.latitude, b.longitude);
  return (m / (dtMs / 1000)) * 3.6;
};
const hasCoords = (o) => Number.isFinite(Number(o?.latitude)) && Number.isFinite(Number(o?.longitude));
const distTo = (a, b) => (hasCoords(a) && hasCoords(b)
  ? haversineMeters(Number(a.latitude), Number(a.longitude), Number(b.latitude), Number(b.longitude))
  : Infinity);

const isCyclingStop = (d) => !!(d?.is_cycling_marker ||
  /cycling route (start|end)/i.test(String(d?.delivery_notes || '')));

const log = (...args) => console.log('[AutoIdle]', ...args);

const loadState = () => {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || typeof s !== 'object') return null;
    return s;
  } catch { return null; }
};
const saveState = (s) => {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
};

export default function AutoIdleDetector({ currentUser, enabled = true }) {
  const [prompt, setPrompt] = useState(null); // { kind, question, askedAt, deadline }
  const stateRef = useRef({
    status: null,            // last known driver_status for this driver
    appUserRecordId: null,
    window: null,            // { anchor:{lat,lng}, startedAt }
    pending: null,           // { kind:'break'|'offduty'|'resume', mark, askedAt, deadline, anchor }
    applied: null,           // { kind:'break'|'offduty', at, anchor }
    reaskAt: 0,
    lastStatus: null,         // duty status seen on the previous tick
    lastFix: null,
    departedStopId: null,
    coordsCache: new Map(),
    coordsCacheAt: 0,
  });
  const timerRef = useRef(null);
  const busyRef = useRef(false);

  const allowed = enabled && isAppOwner(currentUser);

  // ── identity + status bootstrap ───────────────────────────────────────────
  useEffect(() => {
    if (!allowed) return;
    const saved = loadState();
    if (saved) {
      stateRef.current.window = saved.window || null;
      stateRef.current.pending = saved.pending || null;
      stateRef.current.applied = saved.applied || null;
      stateRef.current.reaskAt = saved.reaskAt || 0;
      if (saved.pending) {
        setPrompt({
          kind: saved.pending.kind,
          question: saved.pending.question,
          askedAt: saved.pending.askedAt,
          deadline: saved.pending.deadline,
        });
      }
    }
    (async () => {
      try {
        const rows = await Promise.race([
          offlineDB.getAll(offlineDB.STORES.APP_USERS),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
        ]);
        const mine = (rows || []).find((au) => au?.user_id === currentUser?.id);
        if (mine) {
          stateRef.current.appUserRecordId = mine.id;
          stateRef.current.status = mine.driver_status || null;
          log('boot: status =', mine.driver_status, 'record =', mine.id);
        }
      } catch (e) {
        log('boot: could not read AppUser', e?.message);
      }
    })();
  }, [allowed, currentUser?.id]);

  const persist = useCallback(() => {
    const s = stateRef.current;
    saveState({ window: s.window, pending: s.pending, applied: s.applied, reaskAt: s.reaskAt });
  }, []);

  // ── data helpers ──────────────────────────────────────────────────────────
  const readStatus = useCallback(async () => {
    const s = stateRef.current;
    if (!s.appUserRecordId) return s.status;
    try {
      const rec = await offlineDB.getById(offlineDB.STORES.APP_USERS, s.appUserRecordId);
      if (rec?.driver_status) {
        s.status = rec.driver_status;
      }
    } catch { /* keep last known */ }
    return s.status;
  }, []);

  const resolveStopPoint = useCallback(async (d) => {
    const s = stateRef.current;
    if (!d) return null;
    const key = d.patient_id || d.store_id || d.id;
    const cached = s.coordsCache.get(key);
    if (cached && nowMs() - (cached.at || 0) < 5 * 60 * 1000) return cached.point;
    let point = null;
    try {
      if (isCyclingStop(d) && hasCoords({ latitude: d.cycling_latitude, longitude: d.cycling_longitude })) {
        point = { latitude: Number(d.cycling_latitude), longitude: Number(d.cycling_longitude) };
      } else if (d.patient_id) {
        const p = await offlineDB.getById(offlineDB.STORES.PATIENTS, d.patient_id);
        if (hasCoords(p)) point = { latitude: Number(p.latitude), longitude: Number(p.longitude) };
      } else if (d.store_id) {
        const st = await offlineDB.getById(offlineDB.STORES.STORES, d.store_id);
        if (hasCoords(st)) point = { latitude: Number(st.latitude), longitude: Number(st.longitude) };
      }
    } catch { /* no coords */ }
    s.coordsCache.set(key, { point, at: nowMs() });
    return point;
  }, []);

  const readTodayStops = useCallback(async (driverId) => {
    const today = edmontonTodayKey();
    let rows = [];
    try {
      rows = await Promise.race([
        offlineDB.getDeliveriesByDateRange(today, today),
        new Promise((_, rej) => setTimeout(() => rej(new Error('idb timeout')), 6000)),
      ]);
    } catch (e) {
      log('readTodayStops failed', e?.message);
      return { active: [], lastFinished: null };
    }
    const mine = (rows || []).filter((d) => d && d.driver_id === driverId);
    const active = mine.filter((d) => d && !TERMINAL.has(d.status));
    const finished = mine.filter((d) => d && TERMINAL.has(d.status) && d.actual_delivery_time);
    finished.sort((a, b) => String(a.actual_delivery_time).localeCompare(String(b.actual_delivery_time)));
    return { active, lastFinished: finished[finished.length - 1] || null };
  }, []);

  // ── writes ────────────────────────────────────────────────────────────────
  const applyStatus = useCallback(async (newStatus, anchorMs, reason, opts = {}) => {
    const s = stateRef.current;
    const anchorIso = new Date(anchorMs).toISOString();
    log(`APPLY ${newStatus} anchored ${edmontonWallString(new Date(anchorMs))} (${reason})`);
    try {
      await setDriverStatusFn({
        newStatus,
        anchorTime: anchorIso,
        previousStatus: s.status || undefined,
      });
      s.status = newStatus;
      if (opts.trackApplied === false) {
        // the departure rule writes off_duty without arming the resume question
        persist();
        return true;
      }
      if (newStatus === 'on_break' || newStatus === 'off_duty') {
        s.applied = {
          kind: newStatus === 'on_break' ? 'break' : 'offduty',
          at: anchorMs,
          anchor: s.window?.anchor || s.lastFix || null,
        };
      } else if (newStatus === 'on_duty') {
        s.applied = null;
        s.reaskAt = 0;
      }
      persist();
      return true;
    } catch (e) {
      log('status write FAILED', e?.message || e);
      return false;
    }
  }, [persist]);

  const stampStopTime = useCallback(async (stop, markMs) => {
    if (!stop?.id) return;
    const wall = edmontonWallString(new Date(markMs));
    log('stamp stop', stop.delivery_id || stop.id, '->', wall);
    try {
      await updateDeliveryLocal(stop.id, { actual_delivery_time: wall });
    } catch (e) {
      log('stop stamp failed', e?.message || e);
    }
  }, []);

  const push = useCallback(async ({ title, body, actions = null, tag, data = {} }) => {
    if (!currentUser?.id) return;
    try {
      await base44.functions.invoke('sendPushNotification', {
        user_id: currentUser.id,
        title,
        body,
        tag: tag || 'rxdeliver_auto_idle',
        url: '/',
        requireInteraction: true,
        ...(actions ? { actions } : {}),
        data,
      });
      log('push sent:', title);
    } catch (e) {
      log('push failed', e?.message || e);
    }
  }, [currentUser?.id]);

  // ── ask / answer plumbing ─────────────────────────────────────────────────
  const askQuestion = useCallback(async (kind, mark, question, extra = {}) => {
    const s = stateRef.current;
    const deadline = nowMs() + ANSWER_WINDOW_MS;
    const requestId = `${kind}-${mark}-${nowMs()}`;
    s.pending = { kind, mark, askedAt: nowMs(), deadline, question, requestId, ...extra };
    persist();
    setPrompt({ kind, question, askedAt: nowMs(), deadline });
    await push({
      title: kind === 'resume' ? 'Back on duty?' : 'RxDeliver',
      body: question,
      tag: `rxdeliver_auto_idle_${kind}`,
      actions: [
        { action: 'auto_idle_yes', title: kind === 'resume' ? 'Yes, on duty' : 'Yes' },
        { action: 'auto_idle_no', title: 'No' },
      ],
      data: { auto_idle_kind: kind, request_id: requestId },
    });
  }, [persist, push]);

  const finishPending = useCallback(async (answer) => {
    const s = stateRef.current;
    const p = s.pending;
    if (!p) return;
    s.pending = null;
    setPrompt(null);
    persist();

    const status = await readStatus();

    if (p.kind === 'resume') {
      if (answer === 'yes') {
        const moveAt = p.movementAt || nowMs();
        await applyStatus('on_duty', roundInstantToFiveMin(moveAt, 'floor'), 'resume answered/auto');
      } else {
        log('resume declined — staying', status);
        s.reaskAt = nowMs() + REASK_MS;
        persist();
      }
      return;
    }

    if (answer === 'yes' || answer === 'timeout') {
      const target = p.kind === 'break' ? 'on_break' : 'off_duty';
      const ok = await applyStatus(target, p.mark, answer === 'timeout' ? 'silence' : 'answered yes');
      // Only the off-duty case touches the deal: it happens after the last stop.
      if (ok && p.kind === 'offduty' && p.lastStop) {
        await stampStopTime(p.lastStop, p.mark);
      }
      if (p.kind === 'offduty') {
        await push({
          title: 'RxDeliver',
          body: `You were set off duty at ${hhmm(p.mark)} since you were parked with no stops left.`,
          tag: 'rxdeliver_auto_idle_applied',
        });
      }
    } else {
      log('declined', p.kind, '— re-ask in 30 min if still parked');
      s.reaskAt = nowMs() + REASK_MS;
      persist();
    }
  }, [applyStatus, persist, push, readStatus, stampStopTime]);

  // Deadline timer: the 5-minute window closes on the dot, not on the next tick.
  useEffect(() => {
    if (!allowed || !prompt) return undefined;
    const ms = Math.max(0, prompt.deadline - Date.now());
    const id = setTimeout(() => { finishPending('timeout'); }, ms + 500);
    return () => clearTimeout(id);
  }, [allowed, prompt, finishPending]);

  // answer from the in-app banner OR a notification action button
  useEffect(() => {
    if (!allowed) return undefined;
    const onMessage = (event) => {
      const d = event?.data;
      if (!d || d.type !== 'notification_action') return;
      if (d.action === 'auto_idle_yes') finishPending('yes');
      if (d.action === 'auto_idle_no') finishPending('no');
    };
    navigator.serviceWorker?.addEventListener?.('message', onMessage);
    return () => navigator.serviceWorker?.removeEventListener?.('message', onMessage);
  }, [allowed, finishPending]);

  // ── the tick ──────────────────────────────────────────────────────────────
  const tick = useCallback(async () => {
    const s = stateRef.current;
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const status = await readStatus();
      const pos = locationTracker.getCachedPosition();
      if (!pos) { log('no fix — skip'); return; }

      // OWNER REPORT (Nov 9 2026): 45 minutes on break, set back on duty, and the
      // break ask fired immediately because the parked window opened BEFORE the
      // break and kept aging (the on-break ticks returned early and never closed
      // it). Break / off-duty time is not parked-on-duty time: close the window
      // and clear the re-ask clock whenever the driver is not on duty, and start a
      // fresh window the moment they come back on duty.
      if (status !== 'on_duty') {
        if (s.window) { log('not on duty — parked window closed'); s.window = null; persist(); }
        s.reaskAt = 0;
        s.lastStatus = status;
      } else if (s.lastStatus && s.lastStatus !== 'on_duty') {
        log('back on duty from', s.lastStatus, '— parked window restarts now');
        s.window = null;
        s.reaskAt = 0;
        s.lastStatus = status;
        persist();
      } else {
        s.lastStatus = status;
      }

      const prev = s.lastFix;
      s.lastFix = { latitude: pos.latitude, longitude: pos.longitude, at: nowMs() };
      const speed = prev ? kmhBetween(prev, s.lastFix, s.lastFix.at - prev.at) : 0;
      const t = nowMs();

      // pending question: timeout or cancel on movement
      if (s.pending) {
        if (t >= s.pending.deadline) {
          log('answer window expired — applying');
          await finishPending('timeout');
          return;
        }
        const movedFrom = s.pending.anchor;
        if (movedFrom && distTo(movedFrom, s.lastFix) > PARK_RADIUS_M) {
          log('movement detected inside the answer window — cancelling pending toggle');
          s.pending = null;
          s.window = null;
          setPrompt(null);
          persist();
          return;
        }
        return; // waiting on the answer
      }

      const { active, lastFinished } = await readTodayStops(currentUser.id);

      // suppression: parked at one of our own ACTIVE stops (cycling stops excluded)
      let atActiveStop = false;
      for (const d of active) {
        if (isCyclingStop(d)) continue;
        const pt = await resolveStopPoint(d);
        if (pt && distTo(pt, s.lastFix) <= STOP_RADIUS_M) { atActiveStop = true; break; }
      }
      if (atActiveStop) {
        if (s.window) log('suppressed — parked at an active stop');
        s.window = null;
        persist();
        return;
      }

      if (status !== 'on_duty') {
        // resume detection only applies when WE put them on break / off duty
        if (s.applied && s.applied.anchor) {
          const moved = distTo(s.applied.anchor, s.lastFix);
          if (moved > PARK_RADIUS_M && t >= (s.reaskAt || 0)) {
            log('resume detected, moved', Math.round(moved), 'm');
            await askQuestion('resume', null, "I've detected significant movement, are you back on duty?", {
              movementAt: t,
              anchor: s.lastFix,
            });
          }
        }
        return;
      }

      // parked-window bookkeeping
      if (!s.window) {
        if (speed <= SLOW_KMH) {
          s.window = { anchor: { latitude: pos.latitude, longitude: pos.longitude }, startedAt: t };
          log('window opened, speed', speed.toFixed(1), 'km/h');
          persist();
        }
        return;
      }

      if (distTo(s.window.anchor, s.lastFix) > PARK_RADIUS_M) {
        log('moved away from the park anchor — window reset');
        s.window = null;
        persist();
        return;
      }

      const parkedFor = t - s.window.startedAt;

      // 8. left the finished last stop while still on duty -> off duty, informational push
      if (!active.length) {
        const leftStop = lastFinished && s.departedStopId !== lastFinished.id
          ? await (async () => {
            const pt = await resolveStopPoint(lastFinished);
            return pt ? { stop: lastFinished, moved: distTo(pt, s.lastFix) } : null;
          })()
          : null;
        if (leftStop && leftStop.moved > PARK_RADIUS_M) {
          const stopTime = parseAnyTimestamp(leftStop.stop.actual_delivery_time);
          const mark = roundInstantToFiveMin(stopTime ? stopTime.getTime() : t, 'ceil');
          log('driver left the finished last stop while on duty — off duty at', hhmm(mark));
          const ok = await applyStatus('off_duty', mark, 'left finished last stop', { trackApplied: false });
          if (ok) {
            s.departedStopId = leftStop.stop.id;
            await stampStopTime(leftStop.stop, mark);
            await push({
              title: 'RxDeliver',
              body: `You are still on duty — you were just set off duty at ${hhmm(mark)}.`,
              tag: 'rxdeliver_auto_idle_left_stop',
            });
          }
          return;
        }
      }

      if (parkedFor < PARK_TRIGGER_MS) return;
      if (t < (s.reaskAt || 0)) return;

      const mark = lastFinished
        ? (() => {
          const stopTime = parseAnyTimestamp(lastFinished.actual_delivery_time);
          return roundInstantToFiveMin(stopTime ? stopTime.getTime() : t, 'ceil');
        })()
        : roundInstantToFiveMin(t, 'ceil');

      if (active.length > 0) {
        await askQuestion('break', mark, `Parked 30 min. Start your break at ${hhmm(mark)}?`, {
          anchor: s.window.anchor,
        });
      } else {
        await askQuestion('offduty', mark, `Parked 30 min with no stops left. Go off duty at ${hhmm(mark)}?`, {
          anchor: s.window.anchor,
          lastStop: lastFinished || null,
        });
      }
    } catch (e) {
      log('tick error', e?.message || e);
    } finally {
      busyRef.current = false;
    }
  }, [applyStatus, askQuestion, currentUser?.id, finishPending, persist, push, readStatus, readTodayStops, resolveStopPoint, stampStopTime]);

  useEffect(() => {
    if (!allowed) return undefined;
    log('detector armed for the App Owner');
    timerRef.current = setInterval(() => { tick(); }, TICK_MS);
    const first = setTimeout(() => { tick(); }, 8000);
    return () => {
      clearInterval(timerRef.current);
      clearTimeout(first);
      log('detector stopped');
    };
  }, [allowed, tick]);

  if (!allowed) return null;

  // in-app answer banner (the push can be missed; this always works)
  if (!prompt) return null;
  return (
    <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[10050] w-[92vw] max-w-sm rounded-xl border border-amber-300 bg-amber-50 shadow-xl p-3 dark:bg-amber-950 dark:border-amber-700">
      <div className="text-sm font-semibold text-amber-900 dark:text-amber-100">{prompt.question}</div>
      <div className="text-[11px] text-amber-700 dark:text-amber-300 mt-1">
        Auto-applies in {Math.max(0, Math.ceil((prompt.deadline - Date.now()) / 60000))} min if you don't answer.
      </div>
      <div className="flex gap-2 mt-2">
        <button
          type="button"
          onClick={() => finishPending('yes')}
          className="flex-1 h-9 rounded-md bg-emerald-600 text-white text-sm font-semibold">
          Yes
        </button>
        <button
          type="button"
          onClick={() => finishPending('no')}
          className="flex-1 h-9 rounded-md bg-slate-200 text-slate-800 text-sm font-semibold dark:bg-slate-700 dark:text-slate-100">
          No
        </button>
      </div>
    </div>
  );
}

function hhmm(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
