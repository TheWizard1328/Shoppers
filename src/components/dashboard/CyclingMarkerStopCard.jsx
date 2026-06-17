import React, { useState, useRef, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { Pencil, Trash2, CheckCircle2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const getCyclingType = (delivery) => {
  const notes = (delivery?.delivery_notes || '').trim().toLowerCase();
  if (notes.includes('end')) return 'end';
  return 'start';
};

const START_COLOR = '#16a34a';
const END_COLOR = '#dc2626';
const WHITE = '#FFFFFF';

// Portal menu rendered at document.body to escape all overflow/z-index stacking contexts
function PortalMenu({ anchorRef, open, onClose, onEdit, onDelete, onComplete, cyclingType, isCompleted }) {
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const menuWidth = 170;

  useEffect(() => {
    if (!open || !anchorRef.current) return;

    const measure = () => {
      const rect = anchorRef.current.getBoundingClientRect();
      setPos({
        top: rect.top,               // viewport top of pin
        left: rect.left + rect.width / 2, // viewport horizontal center of pin
      });
    };

    measure();
  }, [open, anchorRef]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (!e.target.closest('[data-cycling-menu]')) onClose();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [open, onClose]);

  if (!open) return null;

  return ReactDOM.createPortal(
    <AnimatePresence>
      <motion.div
        data-cycling-menu="true"
        initial={{ opacity: 0, y: 6, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 6, scale: 0.95 }}
        transition={{ duration: 0.15 }}
        style={{
          position: 'fixed',
          top: `${pos.top}px`,
          left: `${pos.left}px`,
          transform: 'translate(-50%, calc(-100% - 8px))',
          zIndex: 99999,
          background: 'white',
          borderRadius: '10px',
          boxShadow: '0 8px 30px rgba(0,0,0,0.22)',
          border: '1px solid #e2e8f0',
          padding: '4px',
          minWidth: `${menuWidth}px`,
          whiteSpace: 'nowrap',
          pointerEvents: 'auto',
        }}
      >
        {/* Caret pointing down */}
        <div style={{
          position: 'absolute',
          bottom: '-6px',
          left: '50%',
          transform: 'translateX(-50%)',
          width: 0, height: 0,
          borderLeft: '6px solid transparent',
          borderRight: '6px solid transparent',
          borderTop: '6px solid white',
          filter: 'drop-shadow(0 2px 2px rgba(0,0,0,0.08))'
        }} />

        {!isCompleted && (
          <button
            onClick={(e) => { e.stopPropagation(); onComplete(); }}
            style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              width: '100%', padding: '9px 14px', borderRadius: '7px',
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: '13px', fontWeight: 500, color: '#16a34a', textAlign: 'left'
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#f0fdf4'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
          >
            <CheckCircle2 size={14} color="#16a34a" />
            {cyclingType === 'end' ? 'End Cycling Route' : 'Start Cycling Route'}
          </button>
        )}

        <button
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
          style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            width: '100%', padding: '9px 14px', borderRadius: '7px',
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: '13px', fontWeight: 500, color: '#1e293b', textAlign: 'left'
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = '#f1f5f9'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
        >
          <Pencil size={14} color="#64748b" />
          Edit Marker
        </button>

        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            width: '100%', padding: '9px 14px', borderRadius: '7px',
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: '13px', fontWeight: 500, color: '#dc2626', textAlign: 'left'
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = '#fef2f2'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
        >
          <Trash2 size={14} color="#dc2626" />
          Delete Marker
        </button>
      </motion.div>
    </AnimatePresence>,
    document.body
  );
}

export default function CyclingMarkerStopCard({ delivery, stopOrder, onEdit, onDelete, onComplete }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const pinRef = useRef(null);

  const type = getCyclingType(delivery);
  const isCompleted = delivery?.status === 'completed';

  const handleComplete = () => {
    setMenuOpen(false);
    if (!delivery?.id) return;
    const now = new Date();
    // Local time in YYYY-MM-DDTHH:MM:SS format (no timezone suffix, matches how other stops record it)
    const pad = (n) => String(n).padStart(2, '0');
    const localNow = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    onComplete?.(delivery.id, 'completed', { actual_delivery_time: localNow, arrival_time: localNow });
  };

  const pinColor = type === 'end' ? END_COLOR : START_COLOR;
  const outerRingBorder = isCompleted ? START_COLOR : '#cbd5e1';
  const stopNum = delivery?.stop_order || stopOrder || '?';
  const label = delivery?.delivery_notes || (type === 'end' ? 'Cycling Route End' : 'Cycling Route Start');

  // Pin SVG dimensions — 4x the map marker size
  const circleSize = Math.round(24 * 0.80 * 0.80 * 4);
  const pinHeight = Math.round(circleSize * 0.80);
  const totalH = circleSize + pinHeight;
  const cx = circleSize / 2;
  const cy = circleSize / 2;
  const outerR = cx - 2;
  const innerR = outerR - 5;
  const ringStroke = 4;

  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        flexShrink: 0,
        width: `${circleSize + 16}px`,
      }}
    >
      <PortalMenu
        anchorRef={pinRef}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        onEdit={() => { setMenuOpen(false); onEdit?.(delivery); }}
        onDelete={() => { setMenuOpen(false); onDelete?.(delivery.id); }}
        onComplete={handleComplete}
        cyclingType={type}
        isCompleted={isCompleted}
      />

      {/* The large cycling pin */}
      <div
        ref={pinRef}
        onClick={() => {
          setMenuOpen((v) => !v);
          window.dispatchEvent(new CustomEvent('centerStopCard', { detail: { deliveryId: delivery?.id } }));
        }}
        title={label}
        style={{ cursor: 'pointer', width: `${circleSize}px`, height: `${totalH}px`, position: 'relative' }}
      >
        <svg width={circleSize} height={totalH} viewBox={`0 0 ${circleSize} ${totalH}`} xmlns="http://www.w3.org/2000/svg">
          {/* Pin stick */}
          <line
            x1={cx} y1={circleSize - 2} x2={cx} y2={totalH}
            stroke={pinColor} strokeWidth="4" strokeLinecap="round"
            style={{ filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.25))' }}
          />
          {/* Outer ring */}
          <circle
            cx={cx} cy={cy} r={outerR}
            fill={isCompleted ? START_COLOR : WHITE}
            stroke={outerRingBorder}
            strokeWidth={ringStroke}
            style={{ filter: 'drop-shadow(0 2px 5px rgba(0,0,0,0.3))' }}
          />
          {/* Inner coloured circle */}
          <circle cx={cx} cy={cy} r={innerR} fill={pinColor} />
          {/* Stop number */}
          <text
            x={cx} y={cy + 1}
            textAnchor="middle" dominantBaseline="middle"
            fontSize={Math.max(10, Math.round(innerR * 0.9))}
            fontWeight="700"
            fontFamily="system-ui, -apple-system, sans-serif"
            fill={WHITE}
          >
            {stopNum}
          </text>
        </svg>
      </div>

      {/* Label below */}
      <div style={{
        fontSize: '10px', fontWeight: 600, color: pinColor,
        marginTop: '2px', textAlign: 'center', lineHeight: 1.2,
        maxWidth: `${circleSize + 12}px`, wordBreak: 'break-word'
      }}>
        {label}
      </div>
    </div>
  );
}