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
      onClick={onToggle}
      title={armed ? 'Hey Doc is listening — tap to turn off' : 'Hey Doc — tap to start hands-free listening'}
      aria-label="Hey Doc voice assistant"
      className={`inline-flex h-6 w-6 items-center justify-center rounded-full transition-colors ${
        armed ? 'bg-emerald-500 text-white' : 'text-body'
      }`}
      style={{ touchAction: 'manipulation' }}
    >
      <Mic className={`w-3.5 h-3.5 ${armed ? 'animate-pulse' : ''}`} />
    </button>
  );
}
