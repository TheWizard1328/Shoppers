import React from 'react';

/**
 * Map Crosshair Overlay Component
 * 
 * Renders a fixed crosshair at the visual center of the map area.
 * Adjusts position to account for UI overlays (StatsCard at top, StopCards at bottom).
 * 
 * This is a pure overlay - not part of the map, so it doesn't move when panning.
 */
export default function MapCrosshair({ stopCardsHeight = 75, statsCardHeight = 0, isMobile = false }) {
  const topObscured = isMobile ? statsCardHeight : 0;
  const bottomObscured = stopCardsHeight;
  const verticalShift = topObscured === 0 && bottomObscured === 0
    ? 0
    : Math.round((bottomObscured - topObscured) / 2) + 5;

  return (
    <div 
      className="absolute inset-0 pointer-events-none z-[10]"
      style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center'
      }}
    >
      {/* Crosshair container - shifted to center in visible map area */}
      <div 
        className="relative w-6 h-6"
        style={{
          transform: verticalShift !== 0 ? `translateY(${verticalShift > 0 ? '-' : ''}${Math.abs(verticalShift)}px)` : 'none'
        }}
      >
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