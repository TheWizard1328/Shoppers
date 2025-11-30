import React from 'react';

/**
 * Map Crosshair Overlay Component
 * 
 * Renders a fixed crosshair at the visual center of the map area.
 * Adjusts position when stop cards are visible to center in the visible map area.
 * 
 * This is a pure overlay - not part of the map, so it doesn't move when panning.
 */
export default function MapCrosshair({ stopCardsHeight = 0 }) {
  // Calculate vertical offset: when cards are visible, shift up by half the cards height + 10px
  // This centers the crosshair in the VISIBLE map area (above stop cards)
  const verticalOffset = stopCardsHeight > 0 ? (stopCardsHeight / 2) + 10 : 0;

  return (
    <div 
      className="absolute inset-0 pointer-events-none z-[10]"
      style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
        paddingBottom: stopCardsHeight > 0 ? `${verticalOffset * 2}px` : 0
      }}
    >
      {/* Crosshair container */}
      <div className="relative w-6 h-6">
        {/* Horizontal line */}
        <div 
          className="absolute top-1/2 left-0 right-0 h-[2px] bg-slate-800/60 -translate-y-1/2"
          style={{ boxShadow: '0 0 2px rgba(255,255,255,0.8)' }}
        />
        {/* Vertical line */}
        <div 
          className="absolute left-1/2 top-0 bottom-0 w-[2px] bg-slate-800/60 -translate-x-1/2"
          style={{ boxShadow: '0 0 2px rgba(255,255,255,0.8)' }}
        />
        {/* Center dot */}
        <div 
          className="absolute top-1/2 left-1/2 w-2 h-2 bg-slate-800/80 rounded-full -translate-x-1/2 -translate-y-1/2"
          style={{ boxShadow: '0 0 3px rgba(255,255,255,0.9)' }}
        />
      </div>
    </div>
  );
}