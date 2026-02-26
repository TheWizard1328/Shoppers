import React, { useEffect, useLayoutEffect, useMemo, useState } from "react";

export default function SpotlightOverlay({ targetRef, text, visible, onClose, durationMs = 15000 }) {
  const [rect, setRect] = useState(null);

  // Recalculate target rect on resize/scroll/visibility (viewport coords for fixed overlay)
  const updateRect = () => {
    const el = targetRef?.current;
    if (!el) return setRect(null);
    const r = el.getBoundingClientRect();
    const cs = window.getComputedStyle(el);
    const br = parseFloat(cs.borderRadius || '0') || 0;
    setRect({
      top: r.top,
      left: r.left,
      width: r.width,
      height: r.height,
      radius: br,
    });
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

  // Auto-dismiss after duration
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => {
      onClose?.();
    }, durationMs);
    return () => clearTimeout(t);
  }, [visible, durationMs, onClose]);

  if (!visible || !rect) return null;

  const pad = 8; // padding around the highlight
  const radius = rect.radius ?? 10;

  return (
    <div className="fixed inset-0 z-[2147483647]" aria-hidden onClick={onClose}>
      {/* Dim background */}
      <div className="absolute inset-0 bg-black/15" />

      {/* Highlight ring around target */}
      <div
        className="absolute pointer-events-none shadow-[0_0_0_3px_#fff]"
        style={{
          top: rect.top - pad,
          left: rect.left - pad,
          width: rect.width + pad * 2,
          height: rect.height + pad * 2,
          borderRadius: radius,
          boxShadow: "0 0 0 9999px rgba(0,0,0,1), 0 0 0 3px #fff",
        }}
      />

      {/* Bubble card near the target (prefer above; fallback below) */}
      {(() => {
        const bubbleWidth = 320;
        const bubbleHeight = 84;
        const spaceAbove = rect.top;
        const placeAbove = spaceAbove >= bubbleHeight + 16;
        const top = placeAbove ? rect.top - bubbleHeight - 12 : rect.top + rect.height + 12;
        const left = Math.min(
          Math.max(12, rect.left + rect.width / 2 - bubbleWidth / 2),
          window.innerWidth - bubbleWidth - 12
        );
        const arrowTop = placeAbove ? bubbleHeight - 6 : -6;
        const arrowClasses = placeAbove ? 'border-l border-t' : 'border-r border-b';
        return (
          <div
            className="absolute bg-white text-slate-800 rounded-lg shadow-xl border border-slate-200 p-4 max-w-xs"
            style={{ top, left, width: bubbleWidth }}
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
                left: bubbleWidth / 2 - 6,
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