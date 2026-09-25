/**
 * Hey Doc on/off toggle — lives in the stats panel between the error
 * flag indicator and the date selector. Green background when
 * actively listening, plain icon (no background) when off.
 *
 * LIVE MIC METER: while armed, a tiny level bar under the mic icon shows
 * what the mic hears (0-100%). It listens to the 'heydoc-miclevel' window
 * event published by the VAD standby and updates its DOM directly — no
 * React re-renders. Absent on engine paths without a stream (native APK,
 * desktop web), where the bar simply stays hidden.
 */
import React, { useEffect, useRef } from 'react';
import { Mic } from 'lucide-react';

export default function HeyDocToggleButton({ armed, onToggle }) {
  const fillRef = useRef(null);

  useEffect(() => {
    if (!armed || !fillRef.current) return undefined;
    const onLevel = (e) => {
      if (!fillRef.current) return;
      const level = Math.max(0, Math.min(1, Number(e?.detail) || 0));
      fillRef.current.style.width = `${Math.round(level * 100)}%`;
    };
    window.addEventListener('heydoc-miclevel', onLevel);
    if (fillRef.current) fillRef.current.style.width = '0%';
    return () => window.removeEventListener('heydoc-miclevel', onLevel);
  }, [armed]);

  return (
    <button
      type="button"
      data-heydoc-toggle="true"
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); onToggle?.(e); }}
      title={armed ? 'Hey Doc is listening — tap to turn off' : 'Hey Doc — tap to start hands-free listening'}
      aria-label="Hey Doc voice assistant"
      className={`relative w-7 h-7 min-w-7 min-h-7 rounded-full flex shrink-0 flex-col items-center justify-center transition-colors duration-200 hover:scale-110 ${
        armed ? 'bg-emerald-500 text-white shadow-lg' : 'text-body'
      }`}
      style={{ touchAction: 'manipulation' }}
    >
      <Mic className={`w-3 h-3 ${armed ? 'animate-pulse' : ''}`} />
      {armed && (
        <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 h-[3px] w-5 rounded-full bg-emerald-200/50 overflow-hidden">
          <span ref={fillRef} className="block h-full w-0 rounded-full bg-white transition-[width] duration-150" />
        </span>
      )}
    </button>
  );
}
