import React, { useEffect, useState } from 'react';
import { getCurrentEtaForDelivery, getEtaTrendForDelivery, primeEtaTrendBus } from '../utils/etaTrendBus';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Clock, ArrowUp, ArrowDown, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';

export default function QuickRouteAdjustments({
  deliveries,
  currentUser,
  patients,
  stores,
  onReorder,
  onAddDelay
}) {
  const [showDelayDialog, setShowDelayDialog] = useState(false);
  const [selectedDelivery, setSelectedDelivery] = useState(null);
  const [delayMinutes, setDelayMinutes] = useState(15);

  // Get incomplete deliveries sorted by stop order
  const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned', 'pending'];
  const incompleteDeliveries = deliveries
    .filter(d => d && !finishedStatuses.includes(d.status) && d.driver_id === currentUser?.id)
    .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

  const handleMoveUp = async (delivery, index) => {
    if (index === 0) return;
    
    const prevDelivery = incompleteDeliveries[index - 1];
    
    // Swap stop orders
    await onReorder([
      { id: delivery.id, stop_order: prevDelivery.stop_order },
      { id: prevDelivery.id, stop_order: delivery.stop_order }
    ]);
  };

  const handleMoveDown = async (delivery, index) => {
    if (index === incompleteDeliveries.length - 1) return;
    
    const nextDelivery = incompleteDeliveries[index + 1];
    
    // Swap stop orders
    await onReorder([
      { id: delivery.id, stop_order: nextDelivery.stop_order },
      { id: nextDelivery.id, stop_order: delivery.stop_order }
    ]);
  };

  const handleAddDelay = () => {
    if (!selectedDelivery || !delayMinutes || delayMinutes < 1) return;
    
    onAddDelay(selectedDelivery.id, delayMinutes);
    setShowDelayDialog(false);
    setSelectedDelivery(null);
    setDelayMinutes(15);
  };

  useEffect(() => {
    primeEtaTrendBus(incompleteDeliveries);
    const handleTrendUpdate = () => setDelayMinutes((value) => value);
    window.addEventListener('etaTrendUpdated', handleTrendUpdate);
    return () => window.removeEventListener('etaTrendUpdated', handleTrendUpdate);
  }, [incompleteDeliveries]);

  const getStopName = (delivery) => {
    if (delivery.patient_id) {
      const patient = patients.find(p => p && p.id === delivery.patient_id);
      return patient?.full_name || delivery.patient_name || 'Unknown';
    } else {
      const store = stores.find(s => s && s.id === delivery.store_id);
      return `${store?.name || 'Store'} Pickup`;
    }
  };

  if (incompleteDeliveries.length === 0) return null;

  return (
    <>
      <div className="space-y-1">
        {incompleteDeliveries.map((delivery, index) => {
          const isNext = delivery.isNextDelivery === true;
          const canMoveUp = index > 0;
          const canMoveDown = index < incompleteDeliveries.length - 1;
          const etaTrend = getEtaTrendForDelivery(delivery.id);
          const etaDisplay = getCurrentEtaForDelivery(delivery.id, delivery.delivery_time_eta || delivery.delivery_time_start || '--:--');
          const etaColorClass = etaTrend?.trend === 'improved'
            ? 'text-green-600'
            : etaTrend?.trend === 'delayed'
              ? 'text-red-600'
              : 'text-slate-500';

          return (
            <motion.div
              key={delivery.id}
              layout
              className={`flex items-center gap-2 p-2 rounded-lg border ${
                isNext ? 'bg-emerald-50 border-emerald-300' : 'bg-white border-slate-200'
              }`}
            >
              <div className="flex flex-col gap-1 flex-shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleMoveUp(delivery, index)}
                  disabled={!canMoveUp}
                  className="h-6 w-6 p-0"
                >
                  <ArrowUp className="w-3 h-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleMoveDown(delivery, index)}
                  disabled={!canMoveDown}
                  className="h-6 w-6 p-0"
                >
                  <ArrowDown className="w-3 h-3" />
                </Button>
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-slate-500">#{delivery.display_stop_order || index + 1}</span>
                  <span className="text-sm font-medium text-slate-900 truncate">{getStopName(delivery)}</span>
                  {isNext && <Badge className="bg-emerald-500 text-white text-[9px] px-1.5">NEXT</Badge>}
                </div>
                <div className={`text-xs ${etaColorClass}`}>
                  ETA: {etaDisplay}
                </div>
              </div>

              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSelectedDelivery(delivery);
                  setShowDelayDialog(true);
                }}
                className="h-8 w-8 p-0 flex-shrink-0"
                title="Add delay"
              >
                <Plus className="w-3 h-3" />
              </Button>
            </motion.div>
          );
        })}
      </div>

      <Dialog open={showDelayDialog} onOpenChange={setShowDelayDialog}>
        <DialogContent className="max-w-sm z-[10001]">
          <DialogHeader>
            <DialogTitle>Add Delay</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <p className="text-sm text-slate-600 mb-1">Stop:</p>
              <p className="font-medium">{selectedDelivery && getStopName(selectedDelivery)}</p>
            </div>
            <div>
              <label className="text-sm text-slate-600 mb-2 block">Delay (minutes)</label>
              <Input
                type="number"
                min="1"
                max="180"
                value={delayMinutes}
                onChange={(e) => setDelayMinutes(parseInt(e.target.value) || 0)}
                className="w-full"
              />
              <div className="flex gap-2 mt-2">
                {[5, 10, 15, 30, 60].map(minutes => (
                  <Button
                    key={minutes}
                    variant="outline"
                    size="sm"
                    onClick={() => setDelayMinutes(minutes)}
                    className="flex-1"
                  >
                    {minutes}m
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setShowDelayDialog(false);
                  setSelectedDelivery(null);
                }}
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                onClick={handleAddDelay}
                disabled={!delayMinutes || delayMinutes < 1}
                className="flex-1 bg-emerald-600 hover:bg-emerald-700"
              >
                Add Delay
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}