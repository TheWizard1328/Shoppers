import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { GripVertical } from 'lucide-react';

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

export default function QuickRouteAdjustments({
  deliveries,
  patients,
  stores,
  onReoptimize,
  onCancel,
}) {
  const getActive = () =>
    deliveries
      .filter(d => d && (d.status === 'in_transit' || d.status === 'en_route'))
      .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

  const [localOrder, setLocalOrder] = useState(getActive);
  const [originalOrders, setOriginalOrders] = useState(() => {
    const active = getActive();
    return Object.fromEntries(active.map(d => [d.id, d.stop_order || '?']));
  });

  useEffect(() => {
    const active = getActive();
    setLocalOrder(active);
    setOriginalOrders(Object.fromEntries(active.map(d => [d.id, d.stop_order || '?'])));
  }, [deliveries]);

  const handleDragEnd = (result) => {
    if (!result.destination || result.destination.index === result.source.index) return;
    const updated = [...localOrder];
    const [moved] = updated.splice(result.source.index, 1);
    updated.splice(result.destination.index, 0, moved);
    setLocalOrder(updated);
  };

  const handleReoptimize = () => {
    const originalOrders = getActive().map(d => d.stop_order || 0).sort((a, b) => a - b);
    const reorderPayload = localOrder.map((delivery, i) => ({
      id: delivery.id,
      stop_order: originalOrders[i],
    }));
    onReoptimize(reorderPayload);
  };

  const getStopName = (delivery) => {
    if (delivery.patient_id) {
      const patient = patients.find(p => p && p.id === delivery.patient_id);
      return patient?.full_name || 'Unknown';
    }
    const store = stores.find(s => s && s.id === delivery.store_id);
    return `${store?.name || 'Store'} Pickup`;
  };

  if (localOrder.length === 0) return (
    <p className="text-sm py-4" style={{ color: 'var(--text-slate-500)' }}>No active stops to adjust</p>
  );

  return (
    <div className="flex flex-col gap-3">
      <DragDropContext onDragEnd={handleDragEnd}>
        <Droppable droppableId="route-stops">
          {(provided) => (
            <div
              ref={provided.innerRef}
              {...provided.droppableProps}
              className="space-y-1"
            >
              {localOrder.map((delivery, index) => {
                const isNext = delivery.isNextDelivery === true;
                return (
                  <Draggable key={delivery.id} draggableId={delivery.id} index={index}>
                    {(provided, snapshot) => {
                      const card = (
                        <div
                          ref={provided.innerRef}
                          {...provided.draggableProps}
                          {...provided.dragHandleProps}
                          className="flex items-center gap-2 p-2 rounded-lg border cursor-grab active:cursor-grabbing"
                          style={{
                            ...provided.draggableProps.style,
                            background: snapshot.isDragging
                              ? 'var(--bg-slate-100)'
                              : isNext ? 'rgba(16,185,129,0.1)' : 'var(--bg-white)',
                            borderColor: isNext ? '#6ee7b7' : 'var(--border-slate-200)',
                            boxShadow: snapshot.isDragging ? '0 8px 24px rgba(0,0,0,0.35)' : undefined,
                            userSelect: 'none',
                            pointerEvents: 'auto',
                          }}
                        >
                          <GripVertical className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-slate-400)' }} />
                          <div className="flex-1 min-w-0 flex items-center gap-2">
                            <span className="text-xs font-bold flex-shrink-0" style={{ color: 'var(--text-slate-400)' }}>#{originalOrders[delivery.id] ?? '?'}</span>
                            <span className="text-sm font-medium truncate flex-1" style={{ color: 'var(--text-slate-900)' }}>{getStopName(delivery)}</span>
                            {isNext && <Badge className="bg-emerald-500 text-white text-[9px] px-1.5 flex-shrink-0">NEXT</Badge>}
                            <span className="text-xs font-bold flex-shrink-0 ml-auto" style={{ color: 'var(--text-slate-700)' }}>→#{index + 1}</span>
                          </div>
                        </div>
                      );
                      return snapshot.isDragging ? createPortal(card, getPortalEl()) : card;
                    }}
                  </Draggable>
                );
              })}
              {provided.placeholder}
            </div>
          )}
        </Droppable>
      </DragDropContext>

      <div className="flex gap-2 pt-2 border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
        <Button variant="outline" className="flex-1" onClick={onCancel}>Cancel</Button>
        <Button className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white" onClick={handleReoptimize}>Reoptimize</Button>
      </div>
    </div>
  );
}