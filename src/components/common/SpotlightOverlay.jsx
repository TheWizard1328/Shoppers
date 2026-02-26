import React, { useEffect, useLayoutEffect, useMemo, useState } from "react";

export default function SpotlightOverlay({ targetRef, text, visible, onClose, durationMs = 15000 }) {
  const [rect, setRect] = useState(null);

  // Recalculate target rect on resize/scroll/visibility
  const updateRect = () => {
    const el = targetRef?.current;
    if (!el) return setRect(null);
    const r = el.getBoundingClientRect();
    setRect({
      top: r.top + window.scrollY,
      left: r.left + window.scrollX,
      width: r.width,
      height: r.height,
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
  const radius = 10;

  return (
    <div className="fixed inset-0 z-[10000]" aria-hidden onClick={onClose}>
      {/* Dim background */}
      <div className="absolute inset-0 bg-black/60" />

      {/* Highlight ring around target */}
      <div
        className="absolute pointer-events-none shadow-[0_0_0_3px_#fff]"
        style={{
          top: rect.top - pad,
          left: rect.left - pad,
          width: rect.width + pad * 2,
          height: rect.height + pad * 2,
          borderRadius: radius,
          boxShadow: "0 0 0 9999px rgba(0,0,0,0.6), 0 0 0 3px #fff",
        }}
      />

      {/* Bubble card near the target (top by default) */}
      <div
        className="absolute bg-white text-slate-800 rounded-lg shadow-xl border border-slate-200 p-4 max-w-xs"
        style={{
          top: Math.max(12, rect.top - 12 - 80),
          left: Math.min(
            rect.left,
            Math.max(12, rect.left + rect.width / 2 - 160)
          ),
        }}
      >
        <div className="text-sm font-medium">Add deliveries here</div>
        <p className="text-xs mt-1 leading-relaxed">
          Start here to add new stop locations to your driver(s).
        </p>
        {/* Arrow pointing down to target */}
        <div
          className="absolute w-3 h-3 bg-white border-l border-t border-slate-200 rotate-45"
          style={{
            top: "100%",
            left: rect.width / 2 - 8,
          }}
        />
      </div>

      {/* Click to dismiss hint */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-[11px] text-white/80">
        Click anywhere to dismiss • Auto-hides in {Math.round(durationMs / 1000)}s
      </div>
    </div>
  );
}