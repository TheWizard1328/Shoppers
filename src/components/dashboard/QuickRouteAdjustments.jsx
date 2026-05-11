import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowUp, ArrowDown } from 'lucide-react';

export default function QuickRouteAdjustments({
  deliveries,
  patients,
  stores,
  onReoptimize,
  onCancel,
}) {
  const activeDeliveries = deliveries
    .filter(d => d && (d.status === 'in_transit' || d.status === 'en_route'))
    .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

  const [localOrder, setLocalOrder] = useState(activeDeliveries);

  useEffect(() => {
    setLocalOrder(
      deliveries
        .filter(d => d && (d.status === 'in_transit' || d.status === 'en_route'))
        .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0))
    );
  }, [deliveries]);

  const handleMoveUp = (index) => {
    if (index === 0) return;
    const updated = [...localOrder];
    [updated[index - 1], updated[index]] = [updated[index], updated[index - 1]];
    setLocalOrder(updated);
  };

  const handleMoveDown = (index) => {
    if (index === localOrder.length - 1) return;
    const updated = [...localOrder];
    [updated[index], updated[index + 1]] = [updated[index + 1], updated[index]];
    setLocalOrder(updated);
  };

  const handleReoptimize = () => {
    // Build reorder payload using the original stop_orders reassigned by new position
    const originalOrders = activeDeliveries.map(d => d.stop_order || 0).sort((a, b) => a - b);
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
      <div className="space-y-1">
        {localOrder.map((delivery, index) => {
          const isNext = delivery.isNextDelivery === true;
          return (
            <motion.div
              key={delivery.id}
              layout
              className="flex items-center gap-2 p-2 rounded-lg border"
              style={{
                background: isNext ? 'rgba(16,185,129,0.1)' : 'var(--bg-white)',
                borderColor: isNext ? '#6ee7b7' : 'var(--border-slate-200)',
              }}
            >
              <div className="flex flex-col gap-1 flex-shrink-0">
                <Button variant="ghost" size="sm" onClick={() => handleMoveUp(index)} disabled={index === 0} className="h-6 w-6 p-0">
                  <ArrowUp className="w-3 h-3" />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => handleMoveDown(index)} disabled={index === localOrder.length - 1} className="h-6 w-6 p-0">
                  <ArrowDown className="w-3 h-3" />
                </Button>
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold" style={{ color: 'var(--text-slate-500)' }}>#{index + 1}</span>
                  <span className="text-sm font-medium truncate" style={{ color: 'var(--text-slate-900)' }}>{getStopName(delivery)}</span>
                  {isNext && <Badge className="bg-emerald-500 text-white text-[9px] px-1.5">NEXT</Badge>}
                </div>
                <span className="text-xs capitalize" style={{ color: 'var(--text-slate-500)' }}>{delivery.status.replace('_', ' ')}</span>
              </div>
            </motion.div>
          );
        })}
      </div>

      <div className="flex gap-2 pt-2 border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
        <Button variant="outline" className="flex-1" onClick={onCancel}>Cancel</Button>
        <Button className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white" onClick={handleReoptimize}>Reoptimize</Button>
      </div>
    </div>
  );
}