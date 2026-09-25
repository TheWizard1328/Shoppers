/**
 * Hey Doc on/off toggle — lives in the stats panel between the error
 * flag indicator and the date selector. Green background when
 * actively listening, plain icon (no background) when off.
 */
import React from 'react';
import { Mic } from 'lucide-react';

export default function HeyDocToggleButton({ armed, onToggle }) {
  return (
    <button
      type="button"
      data-heydoc-toggle="true"
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); onToggle?.(e); }}
      title={armed ? 'Hey Doc is listening — tap to turn off' : 'Hey Doc — tap to start hands-free listening'}
      aria-label="Hey Doc voice assistant"
      className={`w-7 h-7 min-w-7 min-h-7 aspect-square rounded-full flex shrink-0 items-center justify-center transition-colors duration-200 hover:scale-110 ${
        armed ? 'bg-emerald-500 text-white shadow-lg' : 'text-body'
      }`}
      style={{ touchAction: 'manipulation' }}
    >
      <Mic className={`w-3.5 h-3.5 ${armed ? 'animate-pulse' : ''}`} />
    </button>
  );
}
