import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { offlineDB } from '@/components/utils/offlineDatabase';

const COOLDOWN_MS = 3 * 60 * 60 * 1000; // once every few hours
const AUTO_HIDE_MS = 10000;
// v2: key renamed 2026-09-04 — the pre-portal builds burned the cooldown while the
// balloon rendered invisibly behind stop cards. The rename gives every device a
// one-time fresh cooldown so the fixed balloon can be verified immediately.
const LAST_SHOWN_KEY = 'rxdeliver_shifts_balloon_last_shown_v2';
const BALLOON_WIDTH = 240;

/**
 * Message balloon pinned above the Schedule button on the mobile bottom nav.
 *
 * Informs drivers (anyone with the driver role — including admins who also
 * drive) that shifts are looking for coverage (booked off by another driver,
 * or by an admin on a driver's behalf). Auto-hides after 10s.
 *
 * Showing rules: while the driver's route is NOT started (no finished stops
 * today) the balloon shows on every app refresh/restart. Once the route is
 * started (>=1 finished stop today) the 3h cooldown applies — at most one
 * mid-route nag every few hours — unless a shift was booked off within the
 * last 15 minutes (fresh-coverage pass-through).
 *
 * Exclusion rule: records whose booked_off_driver_id matches the current driver
 * are skipped — the driver whose shift was booked off doesn't get told about
 * their own shift (but will still see the balloon if OTHER drivers have shifts
 * booked off).
 */
function ShiftCoverageBalloon({ currentUser, records, anchorSelector, onGoToSchedule }) {
  const [visible, setVisible] = useState(false);
  const [left, setLeft] = useState(null);
  const [bottomOffset, setBottomOffset] = useState(null);
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
        // 1. Determine route state first. A route counts as STARTED only when
        // the driver has at least one FINISHED stop today — merely having
        // en_route pickups or the first stop set in_transit at route creation
        // is NOT a started route (every driver has those right after Accept All).
        const now = new Date();
        const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        let allDeliveries = [];
        try {
          allDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES) || [];
        } catch (_) { /* offline DB unavailable — proceed */ }
        const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];
        const routeStarted = allDeliveries.some((d) =>
          d?.driver_id === currentUser.id &&
          d?.delivery_date === todayStr &&
          FINISHED_STATUSES.includes(d?.status)
        );

        // 2. Cooldown rules (per Robert, 2026-09-04):
        //    - Route NOT started: the balloon shows on EVERY app refresh /
        //      restart (once per session). The 3h cooldown does NOT apply and
        //      is NOT burned.
        //    - Route started (>=1 finished stop): the 3h cooldown governs and
        //      is burned on show — mid-route drivers get nagged at most once
        //      every few hours.
        //    - Pass-through: a book-off within the last 15 minutes bypasses
        //      the cooldown mid-route — fresh coverage opportunities shouldn't
        //      wait for the cooldown or the route to finish.
        const lastShown = parseInt(localStorage.getItem(LAST_SHOWN_KEY) || '0', 10);
        const cooldownActive = Date.now() - lastShown < COOLDOWN_MS;
        const RECENT_BOOKOFF_MS = 15 * 60 * 1000;
        const hasRecentBookOff = eligible.some((r) => {
          const t = Date.parse(r?.updated_date || r?.created_date || '') || 0;
          return t > 0 && (Date.now() - t) < RECENT_BOOKOFF_MS;
        });
        if (routeStarted && cooldownActive && !hasRecentBookOff) return;

        // 3. Anchor must be visible (Schedule tab button in the nav)
        const anchor = document.querySelector(anchorSelector);
        if (!anchor) return;
        const aRect = anchor.getBoundingClientRect();
        // Viewport-fixed positioning: horizontally centered on the Schedule
        // button, clamped to the screen edges; vertically 6px above its top.
        let l = aRect.left + aRect.width / 2 - BALLOON_WIDTH / 2;
        l = Math.max(8, Math.min(l, window.innerWidth - BALLOON_WIDTH - 8));
        setBottomOffset(Math.max(window.innerHeight - aRect.top + 6, 8));

        // 4. Show. The 3h cooldown is burned ONLY for mid-route shows —
        // pre-route shows happen every launch by design, so they must not
        // poison the cooldown the driver will need later in the day.
        if (routeStarted) {
          localStorage.setItem(LAST_SHOWN_KEY, String(Date.now()));
        }
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

  if (!visible || left == null || bottomOffset == null) return null;

  const n = eligible.length;
  return createPortal(
    <div
      role="status"
      onClick={(e) => { e.stopPropagation(); dismiss(true); }}
      className="fixed cursor-pointer animate-in fade-in slide-in-from-bottom-2 duration-300"
      style={{
        left: `${left}px`,
        bottom: `${bottomOffset}px`,
        width: `${BALLOON_WIDTH}px`,
        // Portal + high z-index: the balloon renders via createPortal to
        // document.body, OUTSIDE the nav's z-150 stacking context, so stop
        // cards (z-10000+) can never cover it.
        zIndex: 11000,
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
    </div>,
    document.body,
  );
}

export default ShiftCoverageBalloon;
