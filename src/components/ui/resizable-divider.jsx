import React, { useState, useEffect, useRef } from 'react';

export function ResizableDivider({ 
  storageKey, 
  defaultWidth = 240, 
  minWidth = 200, 
  maxWidth = 400,
  onWidthChange,
  side = 'left' // 'left' or 'right'
}) {
  const [isDragging, setIsDragging] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(defaultWidth);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e) => {
      const deltaX = e.clientX - startXRef.current;
      // For right side, invert the delta (dragging left increases width)
      const adjustedDelta = side === 'right' ? -deltaX : deltaX;
      let newWidth = startWidthRef.current + adjustedDelta;
      
      // Clamp to min/max
      newWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
      
      if (onWidthChange) {
        onWidthChange(newWidth);
      }
      
      // Save to localStorage
      if (storageKey) {
        localStorage.setItem(storageKey, newWidth.toString());
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, minWidth, maxWidth, onWidthChange, storageKey, side]);

  const handleMouseDown = (e) => {
    e.preventDefault();
    setIsDragging(true);
    startXRef.current = e.clientX;
    
    // Get current width from stored value or default
    const stored = storageKey ? localStorage.getItem(storageKey) : null;
    startWidthRef.current = stored ? parseInt(stored, 10) : defaultWidth;
  };

  return (
    <div
      className="relative w-[1px] bg-slate-200 cursor-col-resize hover:bg-emerald-500 transition-colors flex-shrink-0"
      onMouseDown={handleMouseDown}
      style={{
        userSelect: 'none',
        touchAction: 'none',
        zIndex: 10
      }}
    >
      {/* Wider hit area for easier grabbing */}
      <div 
        className="absolute inset-y-0 -left-2 -right-2"
        style={{ cursor: 'col-resize' }}
      />
      
      {/* Touch-friendly gripper for mobile */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 hidden md:flex flex-col gap-0.5">
        <div className="w-1 h-1 rounded-full bg-slate-400 hover:bg-emerald-500"></div>
        <div className="w-1 h-1 rounded-full bg-slate-400 hover:bg-emerald-500"></div>
        <div className="w-1 h-1 rounded-full bg-slate-400 hover:bg-emerald-500"></div>
      </div>
      
      {/* Visual indicator when dragging */}
      {isDragging && (
        <div className="absolute inset-y-0 left-0 w-[2px] bg-emerald-500" />
      )}
    </div>
  );
}