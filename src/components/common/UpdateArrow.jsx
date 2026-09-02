import React from 'react';
import { ArrowUp } from 'lucide-react';

/**
 * UpdateArrow — a small directional arrow badge that sits in the top-right
 * corner of a parent button. Purely a visual indicator, no tap handler.
 *
 * Props:
 *   type: 'web' (green, #10b981) | 'apk' (blue, #2563EB)
 *   size: px size of the arrow icon (default 10)
 *
 * The parent button must have `position: relative` (or be a button with
 * relative positioning). The arrow is absolutely positioned.
 *
 * A subtle pulse animation plays for the first ~3 seconds after mount to
 * draw the eye, then settles to a static arrow.
 */
export default function UpdateArrow({ type = 'web', size = 10 }) {
  const color = type === 'apk' ? '#2563EB' : '#10b981';
  const bg = type === 'apk' ? '#DBEAFE' : '#D1FAE5';

  return (
    <span
      className="update-arrow-indicator absolute -top-1 -right-1 flex items-center justify-center rounded-full"
      style={{
        width: `${size + 6}px`,
        height: `${size + 6}px`,
        background: bg,
        border: `1.5px solid ${color}`,
        zIndex: 20,
        pointerEvents: 'none',
        animation: 'update-arrow-pulse 1.5s ease-in-out 3',
      }}
    >
      <ArrowUp
        style={{ color, width: `${size}px`, height: `${size}px`, strokeWidth: 3 }}
      />
      <style>{`
        @keyframes update-arrow-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.6; transform: scale(1.15); }
        }
      `}</style>
    </span>
  );
}
