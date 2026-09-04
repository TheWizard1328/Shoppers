import React, { useState, useEffect, useRef, useCallback } from 'react';
import { offlineDB } from '@/components/utils/offlineDatabase';

const COOLDOWN_MS = 3 * 60 * 60 * 1000; // once every few hours
const AUTO_HIDE_MS = 10000;
const LAST_SHOWN_KEY = 'rxdeliver_shifts_balloon_last_shown';
const BALLOON_WIDTH = 240;

/**
 * Message balloon pinned above the Schedule button on the mobile bottom nav.
 *
 * Informs drivers (anyone with the driver role — including admins who also
 * drive) that shifts are looking for coverage (booked off by another driver,
 * or by an admin on a driver's behalf). Shows at most once every few
 * hours (localStorage cooldown), auto-hides after 10s, and never shows while
 * the driver has an active route in progress (in_transit / isNextDelivery stops
 * for today in local IDB).
 *
 * Exclusion rule: records whose booked_off_driver_id matches the current driver
 * are skipped — the driver whose shift was booked off doesn't get told about
 * their own shift (but will still see the balloon if OTHER drivers have shifts
 * booked off).
 */
function ShiftCoverageBalloon({ currentUser, records, anchorSelector, onGoToSchedule }) {
  const [visible, setVisible] = useState(false);
  const [left, setLeft] = useState(null);
  const shownThisSessionRef = useRef(false);

  // Eligible records: upcoming booked-off slots (date window already applied by
  // the hook) that don't belong to this driver
  const eligible = (records || []).filter((r) => (r.booked_off_driver_id || null) !== currentUser?.id);

  const dismiss = useCallback((navigate = false) => {
    setVisible(false);
    if (navigate && onGoToSchedule) onGoToSchedule();
  }, [onGoToSchedule]);

  useEffect(() => {
    if (!currentUser?.id || shownThisSessionRef.current || eligible.length === 0) return;

    const maybeShow = async () => {
      try {
        // 1. Cooldown — at most once every few hours
        const lastShown = parseInt(localStorage.getItem(LAST_SHOWN_KEY) || '0', 10);
        if (Date.now() - lastShown < COOLDOWN_MS) return;

        // 2. Never nag mid-route. A route counts as STARTED only when the driver
        // has at least one FINISHED stop today — merely having en_route pickups
        // or the first stop set in_transit at route creation is NOT a started
        // route (every driver has those immediately after Accept All).
        const now = new Date();
        const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        let allDeliveries = [];
        try {
          allDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES) || [];
        } catch (_) { /* offline DB unavailable — proceed */ }
        const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];
        const hasFinishedStopToday = allDeliveries.some((d) =>
          d?.driver_id === currentUser.id &&
          d?.delivery_date === todayStr &&
          FINISHED_STATUSES.includes(d?.status)
        );
        if (hasFinishedStopToday) return;

        // 3. Anchor must be visible (Schedule tab button in the nav)
        const anchor = document.querySelector(anchorSelector);
        if (!anchor) return;
        const nav = anchor.closest('nav');
        if (!nav) return;
        const aRect = anchor.getBoundingClientRect();
        const nRect = nav.getBoundingClientRect();
        let l = aRect.left - nRect.left + aRect.width / 2 - BALLOON_WIDTH / 2;
        l = Math.max(8, Math.min(l, nRect.width - BALLOON_WIDTH - 8));

        // 4. Show — burn the cooldown now so re-renders don't re-show
        localStorage.setItem(LAST_SHOWN_KEY, String(Date.now()));
        shownThisSessionRef.current = true;
        setLeft(l);
        setVisible(true);
      } catch (err) {
        console.warn('[ShiftCoverageBalloon] suppressed:', err?.message);
      }
    };

    const t = setTimeout(maybeShow, 500);
    return () => clearTimeout(t);
  }, [currentUser?.id, eligible.length, anchorSelector]);

  // Auto-hide
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => setVisible(false), AUTO_HIDE_MS);
    return () => clearTimeout(t);
  }, [visible]);

  if (!visible || left == null) return null;

  const n = eligible.length;
  return (
    <div
      role="status"
      onClick={(e) => { e.stopPropagation(); dismiss(true); }}
      className="absolute z-[200] cursor-pointer animate-in fade-in slide-in-from-bottom-2 duration-300"
      style={{
        left: `${left}px`,
        bottom: '100%',
        width: `${BALLOON_WIDTH}px`,
        marginBottom: '6px',
        background: '#1f2937',
        color: '#fff',
        borderRadius: '10px',
        padding: '10px 12px 11px',
        boxShadow: '0 6px 20px rgba(0,0,0,0.28)',
        fontSize: '13px',
        lineHeight: 1.35,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 2 }}>
        🗓️ {n === 1 ? '1 shift is' : `${n} shifts are`} looking for coverage
      </div>
      <div style={{ color: '#d1d5db' }}>Another driver booked off. Tap to view the schedule and pick one up.</div>
      {/* arrow */}
      <div
        className="absolute"
        style={{
          bottom: '-6px',
          left: `${BALLOON_WIDTH / 2 - 6}px`,
          width: '12px',
          height: '12px',
          background: '#1f2937',
          transform: 'rotate(45deg)',
          borderRadius: '2px',
        }}
      />
    </div>
  );
}

export default ShiftCoverageBalloon;
