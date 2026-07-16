import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';

/**
 * Temporary debug overlay — visible to App Owners on mobile only.
 * Shows the live values from buildMapPadding to help diagnose immersive-mode padding issues.
 *
 * Positioned as an absolutely-placed sibling of the stats panel wrapper:
 *   - Non-immersive: sits just below the stats card container
 *   - Immersive:     slides up to just below the ImmersiveMapTopOverlay
 */
export default function MapPaddingDebugOverlay({ currentUser, isMobile, debugValues, immersiveHidden, statsCardBaseHeight }) {
  const [isOwner, setIsOwner] = useState(false);

  useEffect(() => {
    if (!currentUser) return;
    base44.auth.me().then((u) => setIsOwner(u?.role === 'admin')).catch(() => {});
  }, [currentUser?.id]);

  if (!isMobile) return null;
  if (!isOwner) return null;
  if (!debugValues) return null;

  const {
    isImmersiveModeOn,
    paddingBuffer,
    immersivePadding,
    stopCardsHeight,
    cardsArePresent,
    rawBottomPadding,
    topPadding,
    bottomPadding,
  } = debugValues;

  const fmt = (v) => v === undefined || v === null ? '–' : String(v);

  const rows = [
    ['isImmersiveModeOn', fmt(isImmersiveModeOn), 'cardsArePresent',  fmt(cardsArePresent)],
    ['paddingBuffer',     fmt(paddingBuffer),      'rawBottomPadding', fmt(rawBottomPadding)],
    ['immersivePadding',  fmt(immersivePadding),   'topPadding',       fmt(topPadding)],
    ['stopCardsHeight',   fmt(stopCardsHeight),    'bottomPadding',    fmt(bottomPadding)],
  ];

  // When immersive: slide up to ~70px (just below ImmersiveMapTopOverlay card)
  // When non-immersive: sit just below the stats card container
  const top = immersiveHidden ? 70 : (statsCardBaseHeight || 75) + 4;

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top,
        zIndex: 225,
        transition: 'top 0.5s ease-in-out',
        background: 'rgba(0,0,0,0.78)',
        borderRadius: 10,
        padding: '6px 10px',
        margin: '0 4px',
        pointerEvents: 'none',
      }}
    >
      <p style={{ color: '#facc15', fontSize: 10, fontWeight: 700, marginBottom: 4, fontFamily: 'monospace' }}>
        🛠 MAP PADDING DEBUG
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 8px' }}>
        {rows.map(([k1, v1, k2, v2], i) => (
          <div key={i} style={{ display: 'contents' }}>
            <span style={{ fontFamily: 'monospace', fontSize: 10, color: '#94a3b8' }}>
              {k1}: <span style={{ color: '#f8fafc' }}>{v1}</span>
            </span>
            <span style={{ fontFamily: 'monospace', fontSize: 10, color: '#94a3b8' }}>
              {k2}: <span style={{ color: '#f8fafc' }}>{v2}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
