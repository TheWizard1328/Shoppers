/**
 * Temporary debug overlay — visible on mobile only.
 * Shows the live values from buildMapPadding to help diagnose immersive-mode padding issues.
 */
export default function MapPaddingDebugOverlay({ currentUser, isMobile, debugValues }) {
  if (!isMobile) return null;
  if (!currentUser) return null;
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

  return (
    <div
      style={{
        background: 'rgba(0,0,0,0.78)',
        borderRadius: 10,
        padding: '6px 10px',
        marginTop: 4,
        pointerEvents: 'none',
        width: '100%',
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