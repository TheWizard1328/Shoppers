import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';

const AUTO_HIDE_MS = 10000;
const BALLOON_WIDTH = 250;

/**
 * UpdateInfoBalloon — animated info balloon pinned to an update-arrow button.
 *
 * Expands into view (scale + fade, transform-origin at the tail) the moment an
 * update flag turns true — in lockstep with the UpdateArrow badge on the same
 * button. Auto-hides after 10s (same rhythm as ShiftCoverageBalloon).
 *
 * Props:
 *   active:         update-available flag (balloon fires on the false→true
 *                   transition, or on mount if already true — once per mount)
 *   anchorSelector: CSS selector for the anchor button (must be visible)
 *   direction:      'up'   → balloon sits ABOVE the anchor (bottom nav, tail
 *                            points down at the button, expands upward)
 *                   'down' → balloon sits BELOW the anchor (header menu
 *                            button, tail points up, expands downward)
 *   accent:         accent color (green #10b981 web / blue #2563EB apk)
 *   icon:           leading emoji/glyph for the title line
 *   title:           bold headline
 *   message:         explanation line
 *   cta:             short call-to-action hint (e.g. 'Tap to update')
 *   onClick:         action fired when the balloon is tapped
 *
 * Rendering uses createPortal to document.body with z-index 11000 — outside
 * the nav/header stacking contexts, so nothing (stop cards included) covers it.
 */
function UpdateInfoBalloon({ active, anchorSelector, direction = 'up', accent = '#2563EB', icon = '⬆️', title, message, cta, onClick }) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState(null); // { left, main (top|bottom), tailLeft }
  const shownRef = useRef(false);

  const dismiss = useCallback((act = false) => {
    setVisible(false);
    if (act && onClick) onClick();
  }, [onClick]);

  // Placement + show — fires once per mount when the update flag is/becomes true
  useEffect(() => {
    if (!active || shownRef.current) return;
    shownRef.current = true;
    let cancelled = false;
    let attempts = 0;
    let retryTimer = null;
    const place = () => {
      if (cancelled) return;
      const anchor = document.querySelector(anchorSelector);
      if (!anchor || !anchor.getBoundingClientRect) {
        // Anchor not rendered yet (sidebar open / mid transition) — keep
        // trying for up to ~6s, then give up quietly.
        if (attempts++ < 20) retryTimer = setTimeout(place, 300);
        return;
      }
      const r = anchor.getBoundingClientRect();
      const anchorCenterX = r.left + r.width / 2;
      let left = anchorCenterX - BALLOON_WIDTH / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - BALLOON_WIDTH - 8));
      // Tail: anchor center minus the (possibly clamped) box left, re-clamped
      // to stay inside the box — so the tail always points at the anchor.
      const TAIL_HALF = 6; // half of the 12px diamond
      let tailLeft = anchorCenterX - left - TAIL_HALF;
      tailLeft = Math.max(10, Math.min(tailLeft, BALLOON_WIDTH - 10 - TAIL_HALF * 2));
      const main = direction === 'up'
        ? { bottom: Math.max(window.innerHeight - r.top + 8, 8) }
        : { top: r.bottom + 8 };
      setPos({ left, main, tailLeft });
      setVisible(true);
    };
    // Small delay so the balloon expands in lockstep with the arrow's pulse-in
    const t = setTimeout(place, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [active, anchorSelector, direction]);

  // Auto-hide
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => setVisible(false), AUTO_HIDE_MS);
    return () => clearTimeout(t);
  }, [visible]);

  if (!visible || !pos) return null;

  return createPortal(
    <div
      role="status"
      onClick={(e) => { e.stopPropagation(); dismiss(true); }}
      className="update-info-balloon fixed cursor-pointer"
      style={{
        left: `${pos.left}px`,
        ...pos.main,
        width: `${BALLOON_WIDTH}px`,
        zIndex: 11000,
        background: '#1f2937',
        color: '#fff',
        borderRadius: '10px',
        padding: '10px 12px 11px',
        boxShadow: '0 6px 20px rgba(0,0,0,0.28)',
        fontSize: '13px',
        lineHeight: 1.35,
        // Expand from the tail side so the balloon grows out of the button
        transformOrigin: direction === 'up' ? 'center bottom' : 'center top',
        animation: `update-balloon-expand-${direction === 'up' ? 'up' : 'down'} 0.45s cubic-bezier(0.16, 1, 0.3, 1) both`,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: accent, fontSize: 14 }}>{icon}</span>
        <span>{title}</span>
      </div>
      <div style={{ color: '#d1d5db', fontSize: '12.5px' }}>{message}</div>
      <div style={{ marginTop: 6, color: accent, fontWeight: 600, fontSize: '12px', display: 'flex', alignItems: 'center', gap: 4 }}>
        {cta} <span style={{ fontSize: 13 }}>›</span>
      </div>

      {/* tail — points at the anchored button */}
      <div
        className="absolute"
        style={{
          ...(direction === 'up' ? { bottom: '-6px' } : { top: '-6px' }),
          left: `${pos.tailLeft}px`,
          width: '12px',
          height: '12px',
          background: '#1f2937',
          transform: 'rotate(45deg)',
          borderRadius: '2px',
        }}
      />

      <style>{`
        @keyframes update-balloon-expand-up {
          0%   { opacity: 0; transform: translateY(6px) scale(0.7); }
          70%  { opacity: 1; transform: translateY(0) scale(1.04); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes update-balloon-expand-down {
          0%   { opacity: 0; transform: translateY(-6px) scale(0.7); }
          70%  { opacity: 1; transform: translateY(0) scale(1.04); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>,
    document.body,
  );
}

export default UpdateInfoBalloon;
