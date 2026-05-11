import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { GripVertical } from 'lucide-react';

// Renders the dragging clone into document.body to escape dialog transform context
const PortalAwareDraggable = ({ provided, snapshot, children }) => {
  const child = (
    <div
      ref={provided.innerRef}
      {...provided.draggableProps}
      {...provided.dragHandleProps}
      style={provided.draggableProps.style}
    >
      {children}
    </div>
  );

  if (snapshot.isDragging) {
    return createPortal(child, document.body);
  }
  return child;
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

  useEffect(() => {
    setLocalOrder(getActive());
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
                    {(provided, snapshot) => (
                      <PortalAwareDraggable provided={provided} snapshot={snapshot}>
                        <div
                          className="flex items-center gap-2 p-2 rounded-lg border cursor-grab active:cursor-grabbing"
                          style={{
                            background: snapshot.isDragging
                              ? 'var(--bg-slate-100)'
                              : isNext ? 'rgba(16,185,129,0.1)' : 'var(--bg-white)',
                            borderColor: isNext ? '#6ee7b7' : 'var(--border-slate-200)',
                            boxShadow: snapshot.isDragging ? '0 8px 24px rgba(0,0,0,0.35)' : undefined,
                            userSelect: 'none',
                          }}
                        >
                          <GripVertical className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-slate-400)' }} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold" style={{ color: 'var(--text-slate-500)' }}>#{index + 1}</span>
                              <span className="text-sm font-medium truncate" style={{ color: 'var(--text-slate-900)' }}>{getStopName(delivery)}</span>
                              {isNext && <Badge className="bg-emerald-500 text-white text-[9px] px-1.5">NEXT</Badge>}
                            </div>
                            <span className="text-xs capitalize" style={{ color: 'var(--text-slate-500)' }}>{delivery.status.replace('_', ' ')}</span>
                          </div>
                        </div>
                      </PortalAwareDraggable>
                    )}
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