import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { isAppOwner } from '../utils/userRoles';
import { sendPushForNotification } from '../utils/deliveryMessaging';
import { BALANCE_LEVELS } from './useSquareBalancesSummary';

/**
 * SquareLowBalanceAlert — owner-only "card is running low" alert.
 *
 * Fires when one of the Square cards can no longer comfortably cover a typical
 * day of CODs (card estimate < that card's 7-day average daily COD total —
 * the same yardstick the sidebar badge and Square Balances page color-code
 * with green/yellow/red).
 *
 * Owner spec (Oct 2 2026):
 *   1. Info balloon on the OWNER's devices:
 *      - Phone: pops out from the bottom-left of the screen, above the side
 *        panel (hamburger) button — i.e. where the Square Balances link lives
 *        inside the sidebar the button opens.
 *      - Desktop/tablet: pops out from the Square Balances link on the sidebar,
 *        whenever the sidebar is open and a card is low.
 *      Tapping the balloon opens the Square Balances page. The X dismisses the
 *      balloon for the current low-state fingerprint (until the state worsens —
 *      a further ≥$25 drop or a newly-low card — or 24h pass).
 *   2. One push notification per low-state change, sent to the owner himself,
 *      deduped across his devices via a shared AppSettings record so a low
 *      card doesn't trigger a push from every logged-in device at once.
 *      Owner spec Oct 13 2026: pushes are PER-CARD and DOWNWARD-ONLY — a
 *      newly-low card (first detection) or a ≥$5 DROP since that card's last
 *      push, with a minimum 1-hour gap per card. Unchanged and RISING
 *      balances never push, and a failed dedup-record read ABORTS the send
 *      (a restart with no readable record used to re-push). A random boot
 *      stagger makes one owner device claim the send; the rest stay silent.
 *
 * Data comes in as props from AppSidebar (which already mounts
 * useSquareBalancesSummary) — no second fetch pipeline here.
 */

const DISMISS_KEY = 'rxdeliver_sq_lowbal_dismiss';
const PUSH_DEDUP_KEY = 'square_low_balance_alert';
const DISMISS_TTL_MS = 24 * 60 * 60 * 1000;   // dismissal lasts a day (or until the state worsens)
const PUSH_CARD_COOLDOWN_MS = 60 * 60 * 1000; // min gap between pushes for one card (owner spec Oct 13 2026)
const PUSH_BALANCE_CHANGE_MIN = 5;            // $ — DOWNWARD drop that warrants a push (jitter never fires)
const PUSH_STAGGER_MAX_MS = 15000;            // random boot stagger so only ONE owner device claims a send
const RESHOW_MS_MOBILE = 60 * 60 * 1000;      // mobile re-pop while the state stays low (owner spec Oct 13 2026)
const AUTO_HIDE_MS = 12000;
const BALLOON_WIDTH = 262;
// Fingerprint bucket: re-alert when a card drops another $25 or a new card
// goes low — cents-level jitter does not re-fire anything.
const FP_BUCKET = 25;

export function computeLowBalanceCards(byLocId) {
  if (!byLocId || typeof byLocId.entries !== 'function') return [];
  const out = [];
  for (const [locId, row] of byLocId.entries()) {
    if (!row) continue;
    const bal = Number(row.cardEstimate);
    const avg = Number(row.codAvg);
    if (!Number.isFinite(bal)) continue;
    // Low = the card can't cover a typical day of CODs for its location.
    // (No 7-day average yet → we can't judge "low" against need; skip.)
    if (!Number.isFinite(avg) || avg <= 0 || bal >= avg) continue;
    out.push({
      locId,
      name: row.name || locId,
      balance: Math.round(bal * 100) / 100,
      codAvg: Math.round(avg * 100) / 100,
      level: row.level || 'red',
    });
  }
  return out.sort((a, b) => a.balance - b.balance);
}

export function lowBalanceFingerprint(lowCards) {
  return (lowCards || [])
    .map((c) => `${c.locId}:${Math.floor(Math.max(0, c.balance) / FP_BUCKET)}`)
    .sort()
    .join('|');
}

// ── Balloon (modeled on UpdateInfoBalloon: portal + anchor + expand) ────────

function LowBalanceBalloon({ active, anchorSelector, direction, title, lines, cta, onClick, onDismiss, reshowMs = 0 }) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState(null);
  const shownRef = useRef(false);
  const navigate = useNavigate();

  const dismiss = useCallback((act = false) => {
    setVisible(false);
    if (act) {
      onDismiss?.();
      onClick?.();
    }
  }, [onClick, onDismiss]);

  useEffect(() => {
    if (!active) {
      shownRef.current = false; // next low state starts fresh with a quick show
      setVisible(false);
      return;
    }
    let cancelled = false;
    let attemptTimer = null;

    if (!visible) {
      // First appearance rides in ~400ms after the state turns low; repeats
      // (mobile only) wait reshowMs. reshowMs = 0 → no repeat loop.
      const delay = shownRef.current ? reshowMs : 400;
      if (delay <= 0) return undefined;
      const showTimer = setTimeout(() => {
        if (cancelled) return;
        let attempts = 0;
        const place = () => {
          if (cancelled) return;
          const anchor = document.querySelector(anchorSelector);
          if (!anchor || !anchor.getBoundingClientRect) {
            // Anchor not rendered yet — keep trying ~6s, then give up quietly.
            if (attempts++ < 20) attemptTimer = setTimeout(place, 300);
            return;
          }
          const r = anchor.getBoundingClientRect();
          let left;
          let main;
          let tail;
          if (direction === 'up') {
            left = Math.max(8, Math.min(r.left, window.innerWidth - BALLOON_WIDTH - 8));
            main = { left: `${left}px`, bottom: Math.max(window.innerHeight - r.top + 8, 8) };
            const TAIL_HALF = 6;
            let tailLeft = r.left + r.width / 2 - left - TAIL_HALF;
            tailLeft = Math.max(10, Math.min(tailLeft, BALLOON_WIDTH - 10 - TAIL_HALF * 2));
            tail = { left: `${tailLeft}px`, bottom: '-6px', transform: 'rotate(45deg)' };
          } else {
            // 'right' — out from the sidebar link, tail on the left edge.
            const top = r.top + r.height / 2;
            main = { left: r.right + 8, top: `${top}px`, transform: 'translateY(-50%)' };
            left = null;
            tail = { left: '-6px', top: '50%', transform: 'translateY(-50%) rotate(45deg)' };
          }
          setPos({ main, tail, left });
          setVisible(true);
          shownRef.current = true;
        };
        place();
      }, delay);
      return () => {
        cancelled = true;
        clearTimeout(showTimer);
        if (attemptTimer) clearTimeout(attemptTimer);
      };
    }

    // Visible → auto-hide; the reshow branch above re-arms when needed.
    const hideTimer = setTimeout(() => setVisible(false), AUTO_HIDE_MS);
    return () => { cancelled = true; clearTimeout(hideTimer); };
  }, [active, visible, anchorSelector, direction, reshowMs]);

  if (!visible || !pos) return null;

  const dark = '#1f2937';
  return createPortal(
    <div
      role="status"
      onClick={(e) => { e.stopPropagation(); dismiss(true); }}
      className="low-balance-balloon fixed cursor-pointer select-none"
      style={{
        ...pos.main,
        width: `${BALLOON_WIDTH}px`,
        zIndex: 11000,
        background: dark,
        color: '#fff',
        borderRadius: '10px',
        padding: '10px 12px 11px',
        boxShadow: '0 6px 20px rgba(0,0,0,0.28)',
        fontSize: '13px',
        lineHeight: 1.35,
        transformOrigin: direction === 'right' ? 'center left' : 'center bottom',
        animation: `low-balloon-expand-${direction} 0.45s cubic-bezier(0.16, 1, 0.3, 1) both`,
      }}
    >
      <div className="relative">
        <button
          type="button"
          aria-label="Dismiss"
          onClick={(e) => { e.stopPropagation(); dismiss(false); }}
          className="absolute -top-1 -right-1 p-1 rounded-md text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
          style={{ width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M1 1l8 8M9 1l-8 8" /></svg>
        </button>
        <div style={{ fontWeight: 600, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6, paddingRight: 18 }}>
          <span style={{ color: '#f59e0b', fontSize: 14 }}>⚠️</span>
          <span>{title}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {lines.map((l) => (
            <div key={l.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: '12.5px' }}>
              <span style={{ color: '#e5e7eb', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                <span style={{ color: l.color, fontWeight: 600 }}>${Math.round(l.balance).toLocaleString()}</span>
                <span style={{ color: '#9ca3af' }}> · needs ~${Math.round(l.codAvg).toLocaleString()}</span>
              </span>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 7, color: '#f59e0b', fontWeight: 600, fontSize: '12px', display: 'flex', alignItems: 'center', gap: 4 }}>
          {cta} <span style={{ fontSize: 13 }}>›</span>
        </div>
      </div>

      {/* tail — points at the anchor */}
      <div
        className="absolute"
        style={{ ...pos.tail, width: '12px', height: '12px', background: dark, borderRadius: '2px' }}
      />

      <style>{`
        @keyframes low-balloon-expand-up {
          0%   { opacity: 0; transform: translateY(6px) scale(0.7); }
          70%  { opacity: 1; transform: translateY(0) scale(1.04); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes low-balloon-expand-right {
          0%   { opacity: 0; transform: translate(-6px, -50%) scale(0.7); }
          70%  { opacity: 1; transform: translate(0, -50%) scale(1.04); }
          100% { opacity: 1; transform: translate(0, -50%) scale(1); }
        }
      `}</style>
    </div>,
    document.body,
  );
}

// ── Owner alert: state, dismissal, push ─────────────────────────────────────

const cardBucket = (b) => Math.floor(Math.max(0, b) / FP_BUCKET);

function readDismissed() {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISS_KEY) || 'null');
    if (!raw || !raw.fp) return { fp: '', at: 0, buckets: null };
    // A dismissal ages out after a day — a still-low card re-alerts tomorrow.
    if (Date.now() - Number(raw.at || 0) > DISMISS_TTL_MS) return { fp: '', at: 0, buckets: null };
    return { fp: raw.fp, at: raw.at, buckets: raw.buckets || null };
  } catch (_) {
    return { fp: '', at: 0, buckets: null };
  }
}

// Owner spec Oct 13 2026: an in-app balloon dismissal survives RISING and
// unchanged balances — it only re-arms on a genuinely WORSE state: a card
// that newly went low, or a card that dropped another $25+ since dismissal.
export function isBalloonDismissed(lowCards, dismissed) {
  if (!dismissed?.fp || !dismissed.at) return false;
  if (Date.now() - Number(dismissed.at || 0) > DISMISS_TTL_MS) return false;
  if (!dismissed.buckets) return dismissed.fp === lowBalanceFingerprint(lowCards); // legacy record: exact fingerprint
  for (const c of lowCards || []) {
    const saved = dismissed.buckets[c.locId];
    if (saved == null) return false;                  // newly-low card → re-alert
    if (cardBucket(c.balance) < saved) return false;  // dropped another $25+ → re-alert
  }
  return true; // unchanged or improved → stay dismissed
}

// Owner spec Oct 13 2026 — the push decision, as a pure function so it can be
// unit-tested: a card pushes when it's newly low (first detection) or when it
// DROPPED ≥$5 since its last push with a ≥1h gap. Unchanged and RISING
// balances never push. Returns which cards to push plus the next dedup
// record (every low card's current balance; pushed cards claim a fresh
// sentAt, others keep their last push time).
export function computeLowBalancePushes(cards, prevCards, now = Date.now()) {
  const list = cards || [];
  const pushCards = list.filter((c) => {
    const prev = prevCards?.[c.locId] || null;
    if (!prev) return true; // first detection of this low card
    const drop = Number(prev.balance) - Number(c.balance);
    if (drop < PUSH_BALANCE_CHANGE_MIN) return false; // unchanged or rising
    return now - Number(prev.sentAt || 0) >= PUSH_CARD_COOLDOWN_MS;
  });
  const nextCards = {};
  for (const c of list) {
    const prev = prevCards?.[c.locId] || null;
    const pushed = pushCards.some((pc) => pc.locId === c.locId);
    nextCards[c.locId] = { balance: Math.round(Number(c.balance) * 100) / 100, sentAt: pushed ? now : Number(prev?.sentAt || 0) };
  }
  return { pushCards, nextCards };
}

// Resilient dedup-record read for the push path (owner spec Oct 13 2026):
// returns ok:false when the record cannot be READ, so the caller ABORTS the
// send — a transient API failure at app boot must never be treated as
// "no record yet" (that was the restart-spam bug). Two attempts, then give up.
async function readPushDedupRecord() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const rows = await base44.entities.AppSettings.filter({ setting_key: PUSH_DEDUP_KEY });
      const sorted = (rows || []).filter((r) => r?.setting_value);
      sorted.sort((a, b) => Number(b.setting_value.updatedAt || b.setting_value.sentAt || 0) - Number(a.setting_value.updatedAt || a.setting_value.sentAt || 0));
      return { ok: true, rec: sorted[0] || null, stale: sorted.slice(1) };
    } catch (e) {
      if (attempt === 0) await new Promise((r) => { setTimeout(r, 1500); });
    }
  }
  return { ok: false, rec: null, stale: [] };
}

export default function SquareLowBalanceAlert({ ready, byLocId, currentUser, sidebarOpen, isMobileLike }) {
  const navigate = useNavigate();
  const isOwner = !!currentUser && isAppOwner(currentUser);

  const lowCards = useMemo(() => (ready ? computeLowBalanceCards(byLocId) : []), [ready, byLocId]);
  const fp = useMemo(() => (lowCards.length > 0 ? lowBalanceFingerprint(lowCards) : ''), [lowCards]);

  const [dismissed, setDismissed] = useState(() => readDismissed());
  const lowCardsRef = useRef(lowCards);
  lowCardsRef.current = lowCards;

  // ── Push (owner spec Oct 13 2026 — restart spam fix): pushes are PER-CARD
  // and DOWNWARD-ONLY — a newly-low card (first detection) or a ≥$5 DROP
  // since that card's last push, with a minimum 1-hour gap per card.
  // Unchanged and RISING balances never push. The dedup record is read
  // resiliently (read failure → ABORT, never "no record → send"), a random
  // boot stagger lets one owner device claim the send, and the claim is
  // written BEFORE the push (rolled back on send failure) so simultaneous
  // owner-device boots can't all push at once.
  const lowCardsKey = useMemo(
    () => (lowCards || []).map((c) => `${c.locId}:${Number(c.balance).toFixed(2)}`).join('|'),
    [lowCards]
  );
  useEffect(() => {
    if (!isOwner || !fp || !currentUser?.id) return undefined;
    let cancelled = false;
    (async () => {
      try {
        // Random stagger: when several owner devices boot together (a preview
        // push restarts them all), the first one claims the send and the rest
        // read its claim and stay silent.
        await new Promise((r) => { setTimeout(r, Math.floor(Math.random() * PUSH_STAGGER_MAX_MS)); });
        if (cancelled) return;
        const { ok, rec, stale } = await readPushDedupRecord();
        if (!ok) return; // unreadable record → never push (restart-spam root cause)
        if (cancelled) return;
        const prevCards = rec?.setting_value?.cards || null;
        const now = Date.now();
        const cards = lowCardsRef.current || [];
        const { pushCards, nextCards } = computeLowBalancePushes(cards, prevCards, now);
        if (cancelled) return;
        const prevSnapshot = prevCards ? JSON.stringify(prevCards) : '';
        if (pushCards.length === 0) {
          // Nothing to push — but persist balance moves (rises included) so
          // the next comparison uses the real value. Write only on change.
          if (rec?.id && prevSnapshot !== JSON.stringify(nextCards)) {
            await base44.entities.AppSettings.update(rec.id, { setting_value: { cards: nextCards, updatedAt: now } }).catch(() => {});
          }
          return;
        }
        let body;
        if (pushCards.length === 1) {
          body = `${pushCards[0].name} card is at $${Math.round(pushCards[0].balance).toLocaleString()} — a day of C.O.D's needs about $${Math.round(pushCards[0].codAvg).toLocaleString()}. Tap to review balances.`;
        } else {
          body = `${pushCards.length} Square cards are low: ${pushCards.slice(0, 3).map((c) => `${c.name} $${Math.round(c.balance).toLocaleString()}`).join(', ')}${pushCards.length > 3 ? '…' : ''}. Tap to review balances.`;
        }
        // Claim BEFORE sending: concurrent owner devices read the claim and
        // stay silent. If the push fails, roll the claim back so the next
        // boot retries instead of being marked done.
        const prevValue = rec?.setting_value || null;
        const payload = { cards: nextCards, updatedAt: now };
        let createdId = null;
        if (rec?.id) await base44.entities.AppSettings.update(rec.id, { setting_value: payload });
        else {
          const created = await base44.entities.AppSettings.create({ setting_key: PUSH_DEDUP_KEY, setting_value: payload });
          createdId = created?.id || null;
        }
        if (cancelled) return;
        const res = await sendPushForNotification({
          receiverId: currentUser.id,
          senderName: 'RxDeliver',
          content: body,
          titleOverride: 'Square Card Low Balance',
          url: '/squarebalances',
          tag: 'square-low-balance',
        }).catch(() => null);
        if (cancelled) return;
        if (res?.sent > 0) {
          // Consolidate duplicate records from the old rows[0] bug (best-effort).
          for (const r of stale) {
            if (r?.id && r.id !== rec?.id) await base44.entities.AppSettings.delete(r.id).catch(() => {});
          }
        } else if (rec?.id) {
          // Failed send — restore the previous record so it retries later.
          await base44.entities.AppSettings.update(rec.id, { setting_value: prevValue }).catch(() => {});
        } else if (createdId) {
          await base44.entities.AppSettings.delete(createdId).catch(() => {});
        }
      } catch (_) { /* fire-and-forget */ }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwner, fp, currentUser?.id, lowCardsKey]);

  if (!isOwner || lowCards.length === 0) return null;

  const isDismissed = !!fp && isBalloonDismissed(lowCards, dismissed);
  const active = !!fp && !isDismissed && (!isMobileLike ? sidebarOpen : true);

  const title = lowCards.length === 1
    ? `${lowCards[0].name} card is running low`
    : `${lowCards.length} Square cards are running low`;
  const lines = lowCards.map((c) => ({
    key: c.locId,
    name: c.name,
    balance: c.balance,
    codAvg: c.codAvg,
    color: BALANCE_LEVELS[c.level]?.border || '#f59e0b',
  }));

  const handleOpen = () => navigate('/squarebalances');
  const handleDismiss = () => {
    const buckets = {};
    for (const c of lowCards) buckets[c.locId] = cardBucket(c.balance);
    const next = { fp, at: Date.now(), buckets };
    setDismissed(next);
    try { localStorage.setItem(DISMISS_KEY, JSON.stringify(next)); } catch (_) {}
  };

  return (
    <LowBalanceBalloon
      active={active}
      anchorSelector={isMobileLike ? '[data-apk-menu-btn]' : '[data-square-balances-link]'}
      direction={isMobileLike ? 'up' : 'right'}
      title={title}
      lines={lines}
      cta={isMobileLike ? 'Tap to open Square Balances' : 'Open Square Balances'}
      reshowMs={isMobileLike ? RESHOW_MS_MOBILE : 0}
      onClick={handleOpen}
      onDismiss={handleDismiss}
    />
  );
}
