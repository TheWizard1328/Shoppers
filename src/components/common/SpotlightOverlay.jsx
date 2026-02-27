import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

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

  // Close on ANY click anywhere (including + button and the bubble area)
  useEffect(() => {
    if (!visible) return;
    const handleDocClick = () => onClose?.();
    document.addEventListener('click', handleDocClick, true); // capture phase
    return () => document.removeEventListener('click', handleDocClick, true);
  }, [visible, onClose]);

  // Try to locate a stats card anchor to render inside so the overlay moves with it
  const [anchorEl, setAnchorEl] = useState(null);
  useEffect(() => {
    if (!visible) return;
    let n = targetRef?.current;
    let found = null;
    while (n && n !== document.body) {
      if (n.hasAttribute && n.hasAttribute('data-spotlight-anchor')) { found = n; break; }
      n = n.parentElement;
    }
    setAnchorEl(found);
  }, [visible, targetRef]);

  if (!visible || !rect) return null;

  const pad = 5; // expanded padding around the highlight square
  const radius = 0;

  // Try to locate a stats card anchor to render inside so the overlay moves with it
  const [anchorEl, setAnchorEl] = useState(null);
  useEffect(() => {
    if (!visible) return;
    let n = targetRef?.current;
    let found = null;
    while (n && n !== document.body) {
      if (n.hasAttribute && n.hasAttribute('data-spotlight-anchor')) { found = n; break; }
      n = n.parentElement;
    }
    setAnchorEl(found);
  }, [visible, targetRef]);

  const anchorRect = anchorEl ? anchorEl.getBoundingClientRect() : null;
  const anchorStyles = anchorEl ? getComputedStyle(anchorEl) : null;
  const padL = anchorEl ? parseFloat(anchorStyles.paddingLeft || '0') : 12;
  const padR = anchorEl ? parseFloat(anchorStyles.paddingRight || '0') : 12;

  // Use viewport coordinate system for the container; compute positions relative to viewport
  const baseRect = rect;

  const ContainerProps = { className: `fixed inset-0 z-[2147483647]`, 'aria-hidden': true, style: { pointerEvents: 'none' } };

  const overlay = (
    <div {...ContainerProps}>

      {/* Dimming backdrops (capture clicks outside highlight) */}
      <div
        className="absolute"
        style={{ top: 0, left: 0, right: 0, height: Math.max(0, baseRect.top - pad), backgroundColor: 'rgba(0,0,0,0.4)', pointerEvents: 'auto', zIndex: 1 }}
        onClick={onClose}
      />
      <div
        className="absolute"
        style={{ top: baseRect.top - pad, left: 0, width: Math.max(0, baseRect.left - pad), height: baseRect.height + pad * 2, backgroundColor: 'rgba(0,0,0,0.4)', pointerEvents: 'auto', zIndex: 1 }}
        onClick={onClose}
      />
      <div
        className="absolute"
        style={{ top: baseRect.top - pad, left: baseRect.left + baseRect.width + pad, right: 0, height: baseRect.height + pad * 2, backgroundColor: 'rgba(0,0,0,0.4)', pointerEvents: 'auto', zIndex: 1 }}
        onClick={onClose}
      />
      <div
        className="absolute"
        style={{ top: baseRect.top + baseRect.height + pad, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.4)', pointerEvents: 'auto', zIndex: 1 }}
        onClick={onClose}
      />
      {/* Dim via outer shadow at 40%; no hover fade changes */}

      {/* Highlight ring around target */}
      <div
        className="absolute pointer-events-none shadow-[0_0_0_3px_#fff]"
        style={{
          top: baseRect.top - pad,
          left: baseRect.left - pad,
          width: baseRect.width + pad * 2,
          height: baseRect.height + pad * 2,
          borderRadius: radius,
          backgroundColor: "transparent",
          border: "3px solid #fff",
          boxShadow: "0 4px 12px rgba(0,0,0,0.08)", zIndex: 2,
        }}
      />

      {/* Bubble card near the target (prefer above; fallback below) */}
      {(() => {
        const bubbleWidth = 320; // keep current width
        const gap = 12; // distance below header/target
        const top = baseRect.top + baseRect.height + gap;

        // If anchored, compute within the anchor's content box; otherwise fallback to viewport center
        const viewportPadding = 12;
        // If anchored, clamp inside the anchor's viewport box; else use viewport
        const contentLeft = anchorEl ? (anchorRect.left + padL) : viewportPadding;
        const contentRight = anchorEl ? (anchorRect.right - padR) : (window.innerWidth - viewportPadding);
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
            style={{ top, left, width: bubbleWidth, zIndex: 3 }}
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

  // If we have an anchor element, render inside it so overlay moves with stats card
  if (anchorEl) {
    return createPortal(overlay, anchorEl);
  }
  return overlay;
}