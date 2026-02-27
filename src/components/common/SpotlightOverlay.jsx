import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

export default function SpotlightOverlay({ targetRef, text, visible, onClose, durationMs = 15000 }) {
  const [rect, setRect] = useState(null);
  const lastRectRef = useRef(null);

  // Recalculate target rect on resize/scroll/visibility (viewport coords for fixed overlay)
  const updateRect = () => {
    const el = targetRef?.current;
    if (!el) return setRect(null);
    const r = el.getBoundingClientRect();
    const cs = window.getComputedStyle(el);
    const br = parseFloat(cs.borderRadius || '0') || 0;
    // Round to whole pixels to avoid subpixel misalignment at various zoom levels
    const newRect = {
      top: Math.round(r.top),
      left: Math.round(r.left),
      width: Math.round(r.width),
      height: Math.round(r.height),
      radius: br,
    };
    const prev = lastRectRef.current;
    if (!prev || prev.top !== newRect.top || prev.left !== newRect.left || prev.width !== newRect.width || prev.height !== newRect.height) {
      lastRectRef.current = newRect;
      setRect(newRect);
    }
  };

  useLayoutEffect(() => {
    if (!visible) return;
    updateRect();
  }, [visible, targetRef]);

  useEffect(() => {
    if (!visible) return;
    const onResize = () => updateRect();
    const onScroll = () => updateRect();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    const obs = new ResizeObserver(() => updateRect());
    if (targetRef?.current) obs.observe(targetRef.current);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
      try { obs.disconnect(); } catch {}
    };
  }, [visible, targetRef]);

  // Smooth rAF tracking for continuous alignment during layout shifts
  useEffect(() => {
    if (!visible) return;
    let rafId;
    const loop = () => {
      updateRect();
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [visible, targetRef]);

  // Auto-dismiss after duration
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => {
      onClose?.();
    }, durationMs);
    return () => clearTimeout(t);
  }, [visible, durationMs, onClose]);

  // Close overlay on any click (including clicking the + button). Use capture phase so it doesn't block underlying handlers.
  useEffect(() => {
    if (!visible) return;
    const handleAnyClick = () => {
      onClose?.();
    };
    window.addEventListener('click', handleAnyClick, true);
    return () => window.removeEventListener('click', handleAnyClick, true);
  }, [visible, onClose]);

  if (!visible || !rect) return null;

  const pad = 5; // expanded padding around the highlight square
  const radius = 0;

  return (
    <div className="fixed inset-0 z-[2147483647]" aria-hidden style={{ pointerEvents: 'none' }}>
      {/* Dimming backdrops (capture clicks outside highlight) */}
      <div
        className="absolute"
        style={{ top: 0, left: 0, right: 0, height: Math.max(0, rect.top - pad), backgroundColor: 'rgba(0,0,0,0.4)', pointerEvents: 'auto', zIndex: 1 }}
        onClick={onClose}
      />
      <div
        className="absolute"
        style={{ top: rect.top - pad, left: 0, width: Math.max(0, rect.left - pad), height: rect.height + pad * 2, backgroundColor: 'rgba(0,0,0,0.4)', pointerEvents: 'auto', zIndex: 1 }}
        onClick={onClose}
      />
      <div
        className="absolute"
        style={{ top: rect.top - pad, left: rect.left + rect.width + pad, right: 0, height: rect.height + pad * 2, backgroundColor: 'rgba(0,0,0,0.4)', pointerEvents: 'auto', zIndex: 1 }}
        onClick={onClose}
      />
      <div
        className="absolute"
        style={{ top: rect.top + rect.height + pad, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.4)', pointerEvents: 'auto', zIndex: 1 }}
        onClick={onClose}
      />
      {/* Dim via outer shadow at 40%; no hover fade changes */}

      {/* Highlight ring around target */}
      <div
        className="absolute pointer-events-none shadow-[0_0_0_3px_#fff]"
        style={{
          top: rect.top - pad,
          left: rect.left - pad,
          width: rect.width + pad * 2,
          height: rect.height + pad * 2,
          borderRadius: radius,
          backgroundColor: "transparent",
          border: "3px solid #fff",
          boxShadow: "0 4px 12px rgba(0,0,0,0.08)", zIndex: 2,
        }}
      />

      {/* Bubble card near the target (prefer above; fallback below) */}
      {(() => {
        const baseMaxWidth = 320; // max bubble width
        const gap = 12; // distance below header/target
        const top = rect.top + rect.height + gap;

        // Find nearest ancestor container to align with (Stats card container)
        let node = targetRef?.current;
        let anchorEl = null;
        let anchorRect = null;
        while (node && node !== document.body) {
          const br = node.getBoundingClientRect();
          const cs = window.getComputedStyle(node);
          const wideEnough = br.width > rect.width + 120;
          const centered = (cs.marginLeft === 'auto' && cs.marginRight === 'auto');
          if (node.hasAttribute('data-spotlight-anchor') || wideEnough || centered) {
            anchorEl = node;
            anchorRect = br;
            break;
          }
          node = node.parentElement;
        }

        // Compute left/right bounds using the container's paddings, and center within it
        const padL = anchorEl ? parseFloat(window.getComputedStyle(anchorEl).paddingLeft || '0') : 12;
        const padR = anchorEl ? parseFloat(window.getComputedStyle(anchorEl).paddingRight || '0') : 12;

        const contentLeft = anchorRect ? (anchorRect.left + padL) : 12;
        const contentRight = anchorRect ? (anchorRect.right - padR) : (window.innerWidth - 12);
        const availableWidth = Math.max(180, contentRight - contentLeft);
        const bubbleWidth = Math.min(baseMaxWidth, availableWidth);
        const contentCenterX = (contentLeft + contentRight) / 2;

        const unclampedLeft = contentCenterX - bubbleWidth / 2;
        const left = Math.min(Math.max(contentLeft, unclampedLeft), contentRight - bubbleWidth);

        // Arrow on top-right corner
        const arrowTop = -6;
        const arrowRight = 12;
        const arrowClasses = 'border-t border-r';
        return (
          <div
            className="absolute bg-white text-slate-800 rounded-lg shadow-xl border border-slate-200 p-4 opacity-100"
            style={{ top, left, width: bubbleWidth, maxWidth: 'calc(100vw - 24px)', zIndex: 3 }}
          >
            <div className="text-sm font-medium">Add deliveries here</div>
            <p className="text-xs mt-1 leading-relaxed">
              Start here to add new stop locations to your driver(s).
            </p>
            {/* Arrow pointing to target */}
            <div
              className={`absolute w-3 h-3 bg-white rotate-45 ${arrowClasses}`}
              style={{
                top: arrowTop,
                right: arrowRight,
              }}
            />
          </div>
        );
      })()}

      {/* Click to dismiss hint */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-[11px] text-white/80">
        Click anywhere to dismiss • Auto-hides in {Math.round(durationMs / 1000)}s
      </div>
    </div>
  );
}