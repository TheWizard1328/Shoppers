import React, { useEffect, useState, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { DragDropContext, Droppable, Draggable, useMouseSensor, useKeyboardSensor } from '@hello-pangea/dnd';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { GripVertical } from 'lucide-react';
import { smartRefreshManager } from '../utils/smartRefreshManager';
import { backgroundSyncManager } from '../utils/backgroundSyncManager';
import { isInterStoreDelivery, resolveInterStoreFromName } from '../utils/interStoreDisplayName';
import { getCyclingMarkerDisplayInfo } from '../utils/deliveryTypeUtils';
import useSloppyTouchSensor from './useSloppyTouchSensor';
import { pauseDeferredReoptimization, resumeDeferredReoptimization } from '../utils/deferredRouteReoptimization';

// Portal element mounted once at body level to avoid remounting during drag
let portalEl = null;
const getPortalEl = () => {
  if (!portalEl) {
    portalEl = document.createElement('div');
    portalEl.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:99999;';
    document.body.appendChild(portalEl);
  }
  return portalEl;
};

// Pure display-name resolver (no `this`/closure state) so names can be
// precomputed ONCE per data change instead of O(patients) per row on EVERY
// render frame of the drag.
const resolveStopName = (delivery, patients, stores, interStoreNames) => {
  // Cycling Start/End markers (owner report Oct 9 2026): they carry no
  // patient_id, so they fell through to the store-pickup label. Use the
  // canonical marker classifier (delivery_notes, then transport_mode).
  const cyc = getCyclingMarkerDisplayInfo(delivery);
  if (cyc.isCyclingMarker) return cyc.cyclingName;
  // ISP/ISD inter-store deliveries
  if (isInterStoreDelivery(delivery.delivery_id)) {
    if (interStoreNames[delivery.id]) return interStoreNames[delivery.id];
    const upper = String(delivery.delivery_id).toUpperCase();
    const suffix = upper.startsWith('ISD-') ? '(ISD)' : '(ISP)';
    return `Inter-Store${suffix}`;
  }
  if (delivery.patient_id) {
    const patient = patients.find((p) => p && p.id === delivery.patient_id);
    return patient?.full_name || 'Unknown';
  }
  const store = stores.find((s) => s && s.id === delivery.store_id);
  return `${store?.name || 'Store'} Pickup`;
};

// Memoized stop row. @hello-pangea/dnd re-renders EVERY Draggable on every
// pointer-move frame of a drag; on touch devices with a live route this
// rebuilt the whole panel per frame (owner report Oct 22 2026: dragged card
// lagged behind the finger, falling further behind the longer the drag ran).
// The memo + primitive-only props mean a frame only re-renders rows whose
// visible inputs actually changed; unchanged rows skip their JSX build and
// DOM diff entirely. dnd's internal Draggable registration stays correct
// because `index` (and every other re-render trigger) is part of the
// comparator — nothing is suppressed, only unchanged output is reused.
const StopRow = React.memo(function StopRow({
  deliveryId,
  stopName,
  isNext,
  originalOrder,
  index
}) {
  return (
    <Draggable draggableId={deliveryId} index={index}>
      {(provided, snapshot) => {
        const card = (
          <div
            ref={provided.innerRef}
            {...provided.draggableProps}
            className="flex items-center gap-2 p-2 rounded-lg border select-none"
            style={{
              ...provided.draggableProps.style,
              background: snapshot.isDragging ?
                'var(--bg-slate-100)' :
                isNext ? 'rgba(16,185,129,0.1)' : 'var(--bg-white)',
              borderColor: isNext ? '#6ee7b7' : 'var(--border-slate-200)',
              boxShadow: snapshot.isDragging ? '0 8px 24px rgba(0,0,0,0.35)' : undefined,
              userSelect: 'none',
              pointerEvents: 'auto',
              WebkitUserSelect: 'none',
              WebkitTouchCallout: 'none'
            }}
          >
            {/* DRAG HANDLE (owner report Oct 9 2026): the list now scrolls, so
                only the grip starts a drag — swiping anywhere else on the row
                scrolls the list. Wide touch target + touch-action:none on the
                handle only. */}
            <div
              {...provided.dragHandleProps}
              className="flex items-center justify-center self-stretch -my-2 -ml-2 pl-2 pr-2 cursor-grab active:cursor-grabbing flex-shrink-0"
              style={{ touchAction: 'none', minWidth: 32 }}
              aria-label="Drag to reorder"
            >
              <GripVertical className="w-4 h-4" style={{ color: 'var(--text-slate-400)' }} />
            </div>
            <div className="flex-1 min-w-0 flex items-center gap-2">
              <span className="text-xs font-bold flex-shrink-0" style={{ color: 'var(--text-slate-400)' }}>#{originalOrder}</span>
              <span className="text-sm font-medium truncate flex-1 text-body">{stopName}</span>
              {isNext && <Badge className="bg-emerald-500 text-white text-[9px] px-1.5 flex-shrink-0">NEXT</Badge>}
              <span className="text-xs font-bold flex-shrink-0 ml-auto text-body-2">→#{index + 1}</span>
            </div>
          </div>
        );

        return snapshot.isDragging ? createPortal(card, getPortalEl()) : card;
      }}
    </Draggable>
  );
}, (a, b) =>
  a.deliveryId === b.deliveryId &&
  a.stopName === b.stopName &&
  a.isNext === b.isNext &&
  a.originalOrder === b.originalOrder &&
  a.index === b.index
);

export default function QuickRouteAdjustments({
  deliveries,
  patients,
  stores,
  onReoptimize,
  onCancel
}) {
  const [isOptimizing, setIsOptimizing] = useState(false);

  // Owner spec (Sep 24 2026): PAUSE the deferred 5s window-edit reoptimization
  // countdown while this panel is open; restart the full 5s when it closes.
  useEffect(() => {
    const token = pauseDeferredReoptimization('quick_route_adjustments');
    return () => resumeDeferredReoptimization(token);
  }, []);

  // CRITICAL: Pause background sync while panel is open
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('pauseBackgroundSync'));
    return () => {
      window.dispatchEvent(new CustomEvent('resumeBackgroundSync'));
    };
  }, []);

  const getActive = () =>
  deliveries.
  filter((d) => d && (d.status === 'in_transit' || d.status === 'en_route')).
  sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

  const [localOrder, setLocalOrder] = useState(getActive);
  const [originalOrders, setOriginalOrders] = useState(() => {
    const active = getActive();
    return Object.fromEntries(active.map((d) => [d.id, d.stop_order || '?']));
  });

  const activeIdsKeyRef = useRef(null);
  // While a drag is ACTIVE, live-route WS/smart-refresh echoes of the
  // `deliveries` prop must NOT re-render the list — dnd rebuilds every row on
  // every move frame, so a prop update mid-drag stalls the drag animation
  // (owner report Oct 22 2026: the dragged card fell further and further
  // behind the finger). The latest deliveries are buffered and applied on
  // drag end instead.
  const dragActiveRef = useRef(false);
  const pendingDeliveriesRef = useRef(null);

  const applyDeliveriesSync = (latestDeliveries) => {
    const active = latestDeliveries
      .filter((d) => d && (d.status === 'in_transit' || d.status === 'en_route'))
      .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
    const idsKey = active.map((d) => d.id).sort().join('|');

    if (idsKey === activeIdsKeyRef.current) {
      // Same SET of active stops as before — this prop change is just a WS/
      // smart-refresh echo carrying updated fields (patient name, COD, ETA,
      // isNextDelivery, etc.) on the SAME stops, not a real add/remove. Merge
      // the fresh field data into the existing (possibly user-reordered)
      // localOrder WITHOUT touching positions, so an in-progress or completed
      // drag reorder is never silently reverted while this dialog is open.
      const freshById = new Map(active.map((d) => [d.id, d]));
      setLocalOrder((prev) => prev.map((d) => freshById.get(d.id) || d));
      return;
    }

    // The active set genuinely changed (a stop completed/failed and dropped out,
    // or a new stop became active) — this IS a legitimate reason to resync order.
    activeIdsKeyRef.current = idsKey;
    setLocalOrder(active);
    setOriginalOrders(Object.fromEntries(active.map((d) => [d.id, d.stop_order || '?'])));
  };

  useEffect(() => {
    if (dragActiveRef.current) {
      pendingDeliveriesRef.current = deliveries;
      return; // applied on drag end — no mid-drag re-render
    }
    applyDeliveriesSync(deliveries);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deliveries]);

  // Resolve ISP/ISD names async — stored in a map keyed by delivery id
  const [interStoreNames, setInterStoreNames] = useState({});

  useEffect(() => {
    const pending = localOrder.filter((d) => isInterStoreDelivery(d.delivery_id));
    if (pending.length === 0) return;
    pending.forEach((d) => {
      const upper = String(d.delivery_id).toUpperCase();
      const suffix = upper.startsWith('ISD-') ? '(ISD)' : '(ISP)';
      resolveInterStoreFromName(d.delivery_id).then((storeName) => {
        if (storeName) {
          setInterStoreNames((prev) => ({ ...prev, [d.id]: `${storeName}${suffix}` }));
        }
      });
    });
  }, [localOrder]);

  // Precomputed per-stop display names — recomputed only when the data
  // actually changes, never per drag frame. Each row render is then a pure
  // lookup instead of an O(patients) find.
  const nameMap = useMemo(() => {
    const map = {};
    localOrder.forEach((d) => { map[d.id] = resolveStopName(d, patients, stores, interStoreNames); });
    return map;
  }, [localOrder, patients, stores, interStoreNames]);

  const dragStartRef = useRef(null);

  const handleDragStart = () => {
    dragActiveRef.current = true;
    // Pause sync managers immediately when drag starts
    window.dispatchEvent(new CustomEvent('pauseBackgroundSync'));
    smartRefreshManager.pause();
    backgroundSyncManager.pause();
    dragStartRef.current = Date.now();
  };

  const handleDragEnd = (result) => {
    dragActiveRef.current = false;

    if (!result.destination || result.destination.index === result.source.index) {
      // Resume sync if drop position didn't change
      window.dispatchEvent(new CustomEvent('resumeBackgroundSync'));
      smartRefreshManager.resume();
      backgroundSyncManager.resume();
      dragStartRef.current = null;
      // A live-route delivery echo may have arrived mid-drag — apply it now.
      if (pendingDeliveriesRef.current) {
        const buffered = pendingDeliveriesRef.current;
        pendingDeliveriesRef.current = null;
        applyDeliveriesSync(buffered);
      }
      return;
    }
    const updated = [...localOrder];
    const [moved] = updated.splice(result.source.index, 1);
    updated.splice(result.destination.index, 0, moved);
    setLocalOrder(updated);
    // Apply any deliveries echo buffered during the drag AFTER the user's new
    // order is committed, so the merge path (same ids) preserves positions.
    if (pendingDeliveriesRef.current) {
      const buffered = pendingDeliveriesRef.current;
      pendingDeliveriesRef.current = null;
      // Defer to the next tick so setLocalOrder above is committed first.
      setTimeout(() => applyDeliveriesSync(buffered), 0);
    }
  };

  const handleReoptimize = async () => {
    setIsOptimizing(true);
    try {
      // Pass delivery IDs in their new dragged order
      const reorderPayload = localOrder.map((delivery) => ({
        id: delivery.id
      }));
      await onReoptimize(reorderPayload);
    } finally {
      setIsOptimizing(false);
    }
  };

  if (localOrder.length === 0) return (
    <p className="text-sm py-4 text-soft">No active stops to adjust</p>);


  return (
    <div className="flex flex-col gap-3 min-h-0">
      {/* SCROLLABLE LIST (owner report Oct 9 2026): with many stops the
          Reoptimize/Cancel buttons were pushed off the dialog (the dialog is
          overflow-hidden). The stop list now scrolls inside its own region
          and the footer below stays pinned and always reachable. */}
      <div
        className="overflow-y-auto overscroll-contain pr-0.5"
        style={{ maxHeight: 'calc(80vh - 150px)', WebkitOverflowScrolling: 'touch' }}
      >
      <DragDropContext
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        sensors={[useMouseSensor, useKeyboardSensor, useSloppyTouchSensor]}
        enableDefaultSensors={false}
      >

        <Droppable droppableId="route-stops">
          {(provided) =>
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className="space-y-1">

              {localOrder.map((delivery, index) => (
                <StopRow
                  key={delivery.id}
                  deliveryId={delivery.id}
                  stopName={nameMap[delivery.id] || '…'}
                  isNext={delivery.isNextDelivery === true}
                  originalOrder={originalOrders[delivery.id] ?? '?'}
                  index={index}
                />
              ))}
              {provided.placeholder}
            </div>
          }
        </Droppable>
      </DragDropContext>
      </div>

      <div className="flex gap-2 pt-2 border-t pb-2 border-surface flex-shrink-0">
        <Button variant="outline" className="flex-1" onClick={onCancel} disabled={isOptimizing}>Cancel</Button>
        <Button
          className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-60 disabled:cursor-not-allowed"
          onClick={handleReoptimize}
          disabled={isOptimizing}
        >
          {isOptimizing ? '⏳ Optimizing...' : 'Reoptimize'}
        </Button>
      </div>
    </div>);
}
