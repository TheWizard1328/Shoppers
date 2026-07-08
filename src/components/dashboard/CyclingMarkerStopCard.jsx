import React, { useState, useRef, useEffect } from 'react';
import { Pencil, Trash2, CheckCircle2, Bike, RotateCcw, Play } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Badge } from '@/components/ui/badge';

const getCyclingType = (delivery) => {
  const notes = (delivery?.delivery_notes || '').trim().toLowerCase();
  if (notes.includes('end')) return 'end';
  return 'start';
};

const START_COLOR = '#16a34a';
const END_COLOR = '#dc2626';

export default function CyclingMarkerStopCard({ delivery, stopOrder, onEdit, onDelete, onComplete }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const cardRef = useRef(null);
  const wrapperRef = useRef(null);
  const btnRef = useRef(null);
  const [matchedHeight, setMatchedHeight] = useState(null);

  const [locationName, setLocationName] = useState(null);

  // Load the CyclingLocation name if a library entry is linked
  useEffect(() => {
    const locId = delivery?.cycling_location_id;
    if (!locId) {setLocationName(null);return;}
    import('@/api/base44Client').then(({ base44 }) =>
    base44.entities.CyclingLocation.filter({ id: locId }).
    then((results) => {
      const name = results?.[0]?.name || null;
      setLocationName(name);
    }).
    catch(() => null)
    );
  }, [delivery?.cycling_location_id]);

  const type = getCyclingType(delivery);
  const isCompleted = delivery?.status === 'completed';
  const isInTransit = delivery?.status === 'in_transit' || delivery?.status === 'en_route';
  const accentColor = type === 'end' ? END_COLOR : START_COLOR;
  const stopNum = delivery?.stop_order ?? stopOrder ?? '?';
  const cyclingLabel = type === 'end' ? 'Cycling End' : 'Cycling Start';
  const markerName = locationName || cyclingLabel;

  // Status label
  const statusLabel = isCompleted ? 'Done' : isInTransit ? 'In Transit' : 'Pending';
  const statusBg = isCompleted ? '#16a34a' : isInTransit ? '#2563eb' : accentColor + '22';
  const statusColor = isCompleted || isInTransit ? 'white' : accentColor;

  // Action button: only one shows at a time
  // completed → no action button | pending → Start/Complete | in_transit → Complete | can restart if completed
  const actionLabel = isCompleted ?
  'Restart' :
  isInTransit ?
  'Complete' :
  type === 'end' ? 'Complete' : 'Start';
  const actionIcon = isCompleted ? RotateCcw : isInTransit ? CheckCircle2 : Play;
  const ActionIcon = actionIcon;

  const handleAction = (e) => {
    e.stopPropagation();
    if (!delivery?.id) return;
    const now = new Date(),pad = (n) => String(n).padStart(2, '0');
    const localNow = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    if (isCompleted) {
      // Restart → back to pending
      onComplete?.(delivery.id, 'pending', {});
    } else {
      onComplete?.(delivery.id, 'completed', { actual_delivery_time: localNow, arrival_time: localNow });
    }
  };

  // Match height to adjacent sibling card
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    const getSiblingHeight = () => {
      const parent = el.parentElement;
      if (!parent) return null;
      const siblings = Array.from(parent.children).filter((c) => c !== el);
      // Prefer left sibling, fall back to right
      const elIdx = Array.from(parent.children).indexOf(el);
      const leftSibling = siblings.filter((_, i) => Array.from(parent.children).indexOf(siblings[i]) < elIdx).pop();
      const rightSibling = siblings.find((_, i) => Array.from(parent.children).indexOf(siblings[i]) > elIdx);
      const target = leftSibling || rightSibling;
      return target ? target.offsetHeight : null;
    };

    const update = () => {
      const h = getSiblingHeight();
      if (h && h > 0) setMatchedHeight(h);
    };

    update();
    const observer = new ResizeObserver(update);
    const parent = el.parentElement;
    if (parent) {
      Array.from(parent.children).forEach((child) => {
        if (child !== el) observer.observe(child);
      });
    }
    return () => observer.disconnect();
  }, []);

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
      ref={wrapperRef}
      style={{
        width: '200px',
        flexShrink: 0,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        height: matchedHeight ? `${matchedHeight}px` : undefined,
        alignSelf: matchedHeight ? undefined : 'stretch'
      }}>
      
      {/* Card */}
      <div
        ref={cardRef}
        className="rounded-xl cursor-pointer select-none"
        style={{
          background: isCompleted ? '#f0fdf4' : 'var(--bg-white, white)',
          border: `2.5px solid ${accentColor}`,
          boxShadow: '0 2px 10px rgba(0,0,0,0.13)',
          padding: '8px 10px 8px',
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          position: 'relative',
          overflow: 'visible'
        }}
        onClick={() => {
          setMenuOpen((v) => !v);
          window.dispatchEvent(new CustomEvent('centerStopCard', { detail: { deliveryId: delivery?.id } }));
        }}>
        
        {/* Row 1: Stop # (top-left) | Cycling Start/End (center) | Status (top-right) */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '4px', marginBottom: '6px' }}>
          {/* Stop number badge - top left */}
          <Badge
            className="text-xs font-bold px-1.5 py-0.5 rounded-full shrink-0"
            style={{ backgroundColor: accentColor, color: 'white', border: 'none', fontSize: '11px' }}>
            
            #{stopNum}
          </Badge>

          {/* Cycling label - center */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '3px', flex: 1, justifyContent: 'center' }}>
            
            <span style={{ fontSize: '11px', fontWeight: 700, color: accentColor, whiteSpace: 'nowrap' }}>
              {cyclingLabel}
            </span>
          </div>

          {/* Status badge - top right */}
          <Badge
            className="text-xs font-bold px-1.5 py-0.5 rounded-full shrink-0"
            style={{
              backgroundColor: statusBg,
              color: statusColor,
              border: `1px solid ${accentColor}55`,
              fontSize: '10px'
            }}>
            
            {statusLabel}
          </Badge>
        </div>

        {/* Row 2: Marker name - center */}
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          fontSize: '12px',
          fontWeight: 600,
          color: '#1e293b',
          lineHeight: 1.3,
          padding: '2px 0'
        }}>
          {markerName}
        </div>

        {/* Bottom row: Action button - bottom right */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '6px' }}>
          <button
            ref={btnRef}
            onClick={handleAction}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold"
            style={{
              backgroundColor: isCompleted ? '#f1f5f9' : accentColor,
              color: isCompleted ? '#64748b' : 'white',
              border: isCompleted ? '1px solid #e2e8f0' : 'none',
              cursor: 'pointer',
              whiteSpace: 'nowrap'
            }}>
            
            <ActionIcon size={12} />
            {actionLabel}
          </button>
        </div>
      </div>

      {/* Dropdown menu — anchored above the action button */}
      <AnimatePresence>
        {menuOpen &&
        <motion.div
          initial={{ opacity: 0, y: 4, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 4, scale: 0.96 }}
          transition={{ duration: 0.13 }}
          style={{
            position: 'absolute',
            bottom: '44px', // just above the action button area
            right: '8px',
            zIndex: 99999,
            background: 'white',
            borderRadius: '10px',
            boxShadow: '0 8px 30px rgba(0,0,0,0.22)',
            border: '1px solid #e2e8f0',
            padding: '4px',
            minWidth: '160px',
            whiteSpace: 'nowrap'
          }}
          onClick={(e) => e.stopPropagation()}>
          
            {/* Caret pointing down toward button */}
            <div style={{
            position: 'absolute', bottom: '-6px', right: '18px',
            width: 0, height: 0,
            borderLeft: '6px solid transparent', borderRight: '6px solid transparent',
            borderTop: '6px solid white',
            filter: 'drop-shadow(0 2px 2px rgba(0,0,0,0.08))'
          }} />

            <button
            onClick={() => {setMenuOpen(false);onEdit?.(delivery);}}
            className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-left text-sm font-medium hover:bg-slate-50"
            style={{ color: '#1e293b', background: 'none', border: 'none', cursor: 'pointer' }}>
            
              <Pencil size={13} color="#64748b" />
              Edit Marker
            </button>

            <button
            onClick={() => {setMenuOpen(false);onDelete?.(delivery.id);}}
            className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-left text-sm font-medium hover:bg-red-50"
            style={{ color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer' }}>
            
              <Trash2 size={13} />
              Delete Marker
            </button>
          </motion.div>
        }
      </AnimatePresence>
    </div>);

}