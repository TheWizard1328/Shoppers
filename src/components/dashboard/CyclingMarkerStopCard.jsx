import React, { useState, useRef, useEffect } from 'react';
import { Pencil, Trash2, CheckCircle2, RotateCcw, Play } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Badge } from '@/components/ui/badge';

const getCyclingType = (delivery) => {
  const notes = (delivery?.delivery_notes || '').trim().toLowerCase();
  if (notes.includes('end')) return 'end';
  return 'start';
};

const START_COLOR = '#16a34a';
const END_COLOR = '#dc2626';

export default function CyclingMarkerStopCard({ delivery, stopOrder, onEdit, onDelete, onComplete, onRestart, allDeliveries = [], isSelected = false }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const cardRef = useRef(null);
  const wrapperRef = useRef(null);
  const btnRef = useRef(null);
  const [matchedHeight, setMatchedHeight] = useState(null);

  const [locationName, setLocationName] = useState(null);

  // Look up CyclingLocation name by matching GPS coords (lat/lng)
  useEffect(() => {
    const lat = delivery?.cycling_latitude;
    const lng = delivery?.cycling_longitude;
    if (lat == null || lng == null) {setLocationName(null);return;}
    import('@/api/base44Client').then(({ base44 }) =>
    base44.entities.CyclingLocation.list().
    then((results) => {
      // Find closest location within ~50m
      const THRESH = 0.0005; // ~50m in degrees
      const match = (results || []).find((loc) =>
      Math.abs(loc.latitude - lat) < THRESH && Math.abs(loc.longitude - lng) < THRESH
      );
      setLocationName(match?.name || null);
    }).
    catch(() => null)
    );
  }, [delivery?.cycling_latitude, delivery?.cycling_longitude]);

  const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'];
  const isFinishedDelivery = FINISHED_STATUSES.includes(delivery?.status);
  const routeHasIncompleteStops = (allDeliveries || []).some(
    (d) => d && d.driver_id === delivery?.driver_id && d.delivery_date === delivery?.delivery_date &&
    !FINISHED_STATUSES.includes(d.status) && d.status !== 'pending'
  );
  const routeCompleted = (allDeliveries || []).filter(
    (d) => d && d.driver_id === delivery?.driver_id && d.delivery_date === delivery?.delivery_date
  ).every((d) => FINISHED_STATUSES.includes(d.status));
  const shouldFade = isFinishedDelivery && routeHasIncompleteStops && !isSelected && !isHovered;

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

  // Action button: Restart moves to menu when completed; only Start/Complete shown in footer
  const actionLabel = isInTransit ? 'Complete' : type === 'end' ? 'Complete' : 'Start';
  const ActionIcon = isInTransit ? CheckCircle2 : Play;

  const handleAction = (e) => {
    e.stopPropagation();
    if (!delivery?.id) return;
    const now = new Date(),pad = (n) => String(n).padStart(2, '0');
    const localNow = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    onComplete?.(delivery.id, 'completed', { actual_delivery_time: localNow, arrival_time: localNow });
  };

  const handleRestart = (e) => {
    e.stopPropagation();
    if (!delivery?.id) return;
    onComplete?.(delivery.id, 'pending', {});
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
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        width: '250px',
        flexShrink: 0,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        height: matchedHeight ? `${matchedHeight}px` : undefined,
        alignSelf: matchedHeight ? undefined : 'stretch',
        opacity: shouldFade ? 0.4 : 1,
        transition: 'opacity 0.2s ease-in-out'
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
          {/* Stop number badge - matches regular stop card style */}
          <Badge
            variant="secondary"
            className="px-2 py-0.5 text-sm font-bold rounded-full inline-flex items-center border transition-colors justify-center shrink-0"
            style={{ backgroundColor: accentColor, color: 'white', width: '40px' }}>
            #{stopNum}
          </Badge>

          {/* Cycling label - center — matches patient name: text-xl font-semibold */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '3px', flex: 1, justifyContent: 'center' }}>
            <span className="text-xl font-semibold truncate" style={{ color: accentColor }}>
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

        {/* Row 2: Marker name — matches address style: text-xs font-bold */}
        <div className="flex-1 flex items-center justify-center text-center font-bold text-xl" style={{ color: 'var(--text-slate-500)', lineHeight: 1.3, padding: '2px 0' }}>
          {markerName}
        </div>

        {/* Row 3: Time info — matches regular stop card timing layout */}
        {(() => {
          const fmt = (dt) => {
            if (!dt) return null;
            const s = String(dt);
            if (s.includes('T')) return s.substring(11, 16);
            return s.substring(0, 5);
          };
          if (isCompleted) {
            const arrival = fmt(delivery?.arrival_time);
            const completion = fmt(delivery?.actual_delivery_time);
            if (!arrival && !completion) return null;
            return (
              <div className="flex items-center justify-center text-sm font-bold mb-1" style={{ color: 'var(--text-slate-600)' }}>
                {arrival && completion ? `${arrival} → ${completion}` : arrival || completion}
              </div>);

          }
          if (isInTransit) {
            const start = fmt(delivery?.delivery_time_start);
            const end = fmt(delivery?.delivery_time_end);
            if (!start && !end) return null;
            return (
              <div className="flex items-center justify-center text-xs font-bold mb-1" style={{ color: 'var(--text-slate-500)' }}>
                {start && end ? `${start} → ${end}` : start ? `${start} →` : `← ${end}`}
              </div>);

          }
          return null;
        })()}

        {/* Bottom row: action buttons — matches exact same rules as regular stop card */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px', marginTop: '6px' }}>
          {!isCompleted && delivery?.status !== 'cancelled' && (
            <button
              ref={btnRef}
              onClick={handleAction}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold"
              style={{ backgroundColor: accentColor, color: 'white', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}>
              <ActionIcon size={12} />
              {actionLabel}
            </button>
          )}
          {['completed', 'cancelled'].includes(delivery?.status) && onRestart && !routeCompleted && (
            <button
              ref={btnRef}
              onClick={handleRestart}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold"
              style={{ backgroundColor: '#ff0000', color: 'white', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}>
              <RotateCcw size={12} />
              Restart
            </button>
          )}
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