import React, { useState, useRef, useEffect } from 'react';
import { Pencil, Trash2, CheckCircle2, Bike } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Badge } from '@/components/ui/badge';

const getCyclingType = (delivery) => {
  const notes = (delivery?.delivery_notes || '').trim().toLowerCase();
  if (notes.includes('end')) return 'end';
  return 'start';
};

const START_COLOR = '#16a34a';
const END_COLOR  = '#dc2626';

export default function CyclingMarkerStopCard({ delivery, stopOrder, onEdit, onDelete, onComplete }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const cardRef = useRef(null);

  const type       = getCyclingType(delivery);
  const isCompleted = delivery?.status === 'completed';
  const accentColor = type === 'end' ? END_COLOR : START_COLOR;
  const stopNum     = delivery?.stop_order ?? stopOrder ?? '?';
  const label       = type === 'end' ? 'Route End' : 'Route Start';

  const handleComplete = () => {
    setMenuOpen(false);
    if (!delivery?.id) return;
    const now = new Date(), pad = (n) => String(n).padStart(2, '0');
    const localNow = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    onComplete?.(delivery.id, 'completed', { actual_delivery_time: localNow, arrival_time: localNow });
  };

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e) => {
      if (!cardRef.current?.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [menuOpen]);

  return (
    <div
      ref={cardRef}
      style={{ width: '112px', flexShrink: 0, position: 'relative' }}
      onClick={() => {
        setMenuOpen((v) => !v);
        window.dispatchEvent(new CustomEvent('centerStopCard', { detail: { deliveryId: delivery?.id } }));
      }}
    >
      {/* Card — mirrors the rounded-xl border style of regular stop cards */}
      <div
        className="rounded-xl cursor-pointer select-none"
        style={{
          background: isCompleted ? '#f0fdf4' : 'var(--bg-white, white)',
          border: `2.5px solid ${accentColor}`,
          boxShadow: '0 2px 10px rgba(0,0,0,0.13)',
          padding: '8px 6px 7px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '5px',
          minHeight: '90px',
          justifyContent: 'space-between',
        }}
      >
        {/* Stop number badge */}
        <Badge
          className="text-sm font-bold px-2 py-0.5 rounded-full"
          style={{ backgroundColor: accentColor, color: 'white', border: 'none' }}
        >
          #{stopNum}
        </Badge>

        {/* Bike icon */}
        <Bike size={22} color={accentColor} strokeWidth={2.2} />

        {/* Label */}
        <div style={{
          fontSize: '11px',
          fontWeight: 700,
          color: accentColor,
          textAlign: 'center',
          lineHeight: 1.2,
        }}>
          {label}
        </div>

        {/* Status badge */}
        <Badge
          className="text-xs font-bold px-2 py-0.5 rounded-full"
          style={{
            backgroundColor: isCompleted ? '#16a34a' : accentColor + '22',
            color: isCompleted ? 'white' : accentColor,
            border: `1px solid ${accentColor}55`,
          }}
        >
          {isCompleted ? 'Done' : 'Pending'}
        </Badge>
      </div>

      {/* Dropdown menu */}
      <AnimatePresence>
        {menuOpen && (
          <motion.div
            initial={{ opacity: 0, y: 4, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.96 }}
            transition={{ duration: 0.13 }}
            style={{
              position: 'absolute',
              bottom: 'calc(100% + 6px)',
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 99999,
              background: 'white',
              borderRadius: '10px',
              boxShadow: '0 8px 30px rgba(0,0,0,0.22)',
              border: '1px solid #e2e8f0',
              padding: '4px',
              minWidth: '160px',
              whiteSpace: 'nowrap',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Caret */}
            <div style={{
              position: 'absolute', bottom: '-6px', left: '50%', transform: 'translateX(-50%)',
              width: 0, height: 0,
              borderLeft: '6px solid transparent', borderRight: '6px solid transparent',
              borderTop: '6px solid white',
              filter: 'drop-shadow(0 2px 2px rgba(0,0,0,0.08))'
            }} />

            {!isCompleted && (
              <button
                onClick={() => handleComplete()}
                className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-left text-sm font-medium hover:bg-green-50"
                style={{ color: '#16a34a', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                <CheckCircle2 size={13} />
                {type === 'end' ? 'End Cycling' : 'Start Cycling'}
              </button>
            )}

            <button
              onClick={() => { setMenuOpen(false); onEdit?.(delivery); }}
              className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-left text-sm font-medium hover:bg-slate-50"
              style={{ color: '#1e293b', background: 'none', border: 'none', cursor: 'pointer' }}
            >
              <Pencil size={13} color="#64748b" />
              Edit Marker
            </button>

            <button
              onClick={() => { setMenuOpen(false); onDelete?.(delivery.id); }}
              className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-left text-sm font-medium hover:bg-red-50"
              style={{ color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer' }}
            >
              <Trash2 size={13} />
              Delete Marker
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}