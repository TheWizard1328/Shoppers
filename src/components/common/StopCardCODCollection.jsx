import React, { useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X, Plus, Loader2, CheckCircle, Save } from "lucide-react";
import { userHasRole } from '../utils/userRoles';
import { generateCompletionTimestamp } from '../utils/timeRoundingHelper';
import { updateDeliveryLocal } from '../utils/offlineMutations';
import { fabControlEvents } from '../utils/fabControlEvents';
import { invalidate } from '../utils/dataManager';

export default function StopCardCODCollection({
  delivery,
  codPayments,
  setCodPayments,
  showCODCollection,
  setShowCODCollection,
  codTotalRequired,
  codTotalCollected,
  isCODComplete,
  isFinishedDelivery,
  isStrippedForDriver,
  currentUser,
  onCODUpdate,
  allDeliveries,
  FINISHED_STATUSES,
  forceRefreshDriverDeliveries,
  isCompleting,
  setIsCompleting,
  onSelectionChange,
  onClick,
}) {
  const codAmountInputRefs = useRef([]);

  const handleCODPaymentChange = (index, field, value) => {
    const newPayments = [...codPayments];
    if (field === 'amount') {
      const cleaned = String(value).replace(/[^\d]/g, '');
      const cents = parseInt(cleaned) || 0;
      newPayments[index] = { ...newPayments[index], [field]: cents / 100 };
    } else if (field === 'type') {
      newPayments[index] = { ...newPayments[index], [field]: value };
      if (newPayments[index].amount === 0) {
        const remainingAmount = codTotalRequired - codTotalCollected;
        newPayments[index].amount = Math.max(0, remainingAmount);
      }
    } else {
      newPayments[index] = { ...newPayments[index], [field]: value };
    }
    setCodPayments(newPayments);
  };

  const handleAddCODPayment = (shouldFocusType = false) => {
    const remainingAmount = codTotalRequired - codTotalCollected;
    const newPayment = { type: 'Cash', amount: Math.max(0, remainingAmount) };
    setCodPayments([...codPayments, newPayment]);

    if (shouldFocusType) {
      setTimeout(() => {
        const lastIndex = codPayments.length;
        const selectTrigger = document.querySelector(`[data-cod-select-index="${lastIndex}"]`);
        if (selectTrigger) selectTrigger.click();
      }, 100);
    } else {
      setTimeout(() => {
        const lastIndex = codPayments.length;
        if (codAmountInputRefs.current[lastIndex]) {
          codAmountInputRefs.current[lastIndex].focus();
          codAmountInputRefs.current[lastIndex].select();
        }
      }, 50);
    }
  };

  const handleRemoveCODPayment = (index) => {
    setCodPayments(codPayments.filter((_, i) => i !== index));
  };

  return (
    <AnimatePresence>
      {showCODCollection && codTotalRequired > 0 && !delivery.patient_id === false && !isStrippedForDriver && (userHasRole(currentUser, 'driver') || userHasRole(currentUser, 'admin')) &&
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.2 }}
          className="overflow-hidden rounded-md p-3 space-y-2 w-full"
          style={{ background: 'var(--bg-slate-50)' }}
          onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm md:text-xs font-semibold" style={{ color: 'var(--text-slate-700)' }}>Collect COD Payments</span>
            <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={async (e) => {
              e.stopPropagation();
              setCodPayments([]);
              if (onCODUpdate) {
                try {
                  await onCODUpdate(delivery.id, [], true);
                } catch (error) {
                  console.error('❌ [COD Clear] Failed:', error);
                }
              }
              setShowCODCollection(false);
            }}>
              <X className="w-3 h-3" />
            </Button>
          </div>

          <div className="space-y-2 max-h-48 overflow-y-auto">
            {codPayments.map((payment, index) =>
              <div key={index} className="flex items-center gap-2 p-2 rounded" style={{ background: 'var(--bg-white)', borderWidth: '1px', borderColor: 'var(--border-slate-200)' }}>
                <Select value={payment.type} onValueChange={(value) => handleCODPaymentChange(index, 'type', value)} onOpenChange={(open) => { if (open) setShowCODCollection(true); }}>
                  <SelectTrigger className="h-7 text-sm md:text-xs w-24" onClick={(e) => e.stopPropagation()} data-cod-select-index={index}>
                    <SelectValue placeholder="Type" />
                  </SelectTrigger>
                  <SelectContent onClick={(e) => e.stopPropagation()} className="z-[500]">
                    <SelectItem value="Cash">Cash</SelectItem>
                    <SelectItem value="Debit">Debit</SelectItem>
                    <SelectItem value="Credit">Credit</SelectItem>
                    <SelectItem value="Check">Check</SelectItem>
                  </SelectContent>
                </Select>

                <div className="relative flex-1">
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-sm md:text-xs" style={{ color: 'var(--text-slate-500)' }}>$</span>
                  <input
                    ref={(el) => codAmountInputRefs.current[index] = el}
                    type="text"
                    value={payment.amount > 0 ? payment.amount.toFixed(2) : payment.amount === 0 ? '0.00' : ''}
                    onChange={(e) => handleCODPaymentChange(index, 'amount', e.target.value)}
                    className="h-7 w-full pl-5 pr-2 text-sm md:text-xs rounded-md"
                    style={{ background: 'var(--bg-white)', borderWidth: '1px', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}
                    placeholder="0.00"
                    onClick={(e) => e.stopPropagation()}
                    onFocus={(e) => e.target.select()} />
                </div>

                <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-600 hover:text-red-800" onClick={(e) => { e.stopPropagation(); handleRemoveCODPayment(index); }}>
                  <X className="w-3 h-3" />
                </Button>
              </div>
            )}
          </div>

          <Button size="sm" variant="outline" className="w-full h-7 text-sm md:text-xs" onClick={(e) => { e.stopPropagation(); handleAddCODPayment(); }}>
            <Plus className="w-3 h-3 mr-1" />
            Add Payment
          </Button>

          <div className="flex items-center justify-between pt-2" style={{ borderTopWidth: '1px', borderColor: 'var(--border-slate-200)' }}>
            <div className="text-sm md:text-xs">
              <span style={{ color: 'var(--text-slate-600)' }}>Total: </span>
              <span className="font-bold" style={{ color: isCODComplete ? 'var(--text-emerald-600)' : 'var(--text-amber-600)' }}>
                ${codTotalCollected.toFixed(2)}
              </span>
              <span style={{ color: 'var(--text-slate-600)' }}> / ${codTotalRequired.toFixed(2)}</span>
            </div>

            <Button
              size="sm"
              className="inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 text-primary-foreground shadow rounded-md px-3 h-7 text-sm md:text-xs !text-white bg-emerald-600 hover:bg-emerald-700"
              onClick={async (e) => {
                e.stopPropagation();
                if (!onCODUpdate) return;
                try {
                  setIsCompleting(true);
                  const isAlreadyCompleted = delivery.status === 'completed';

                  if (isAlreadyCompleted) {
                    await onCODUpdate(delivery.id, codPayments, true);
                    setShowCODCollection(false);
                  } else {
                    fabControlEvents.deactivateFAB();
                    const { driverLocationPoller } = await import('../utils/driverLocationPoller');
                    driverLocationPoller.pause();

                    await onCODUpdate(delivery.id, codPayments, true);
                    setShowCODCollection(false);

                    const localTimeString = generateCompletionTimestamp(delivery, allDeliveries, FINISHED_STATUSES);

                    await updateDeliveryLocal(delivery.id, {
                      status: 'completed',
                      actual_delivery_time: localTimeString,
                      isNextDelivery: false
                    }, { skipSmartRefresh: true });

                    const driverDeliveries = allDeliveries.filter(d =>
                      d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date
                    );
                    const incompleteDeliveries = driverDeliveries.filter(d =>
                      d.id !== delivery.id && !FINISHED_STATUSES.includes(d.status) && d.status !== 'pending'
                    ).sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

                    if (incompleteDeliveries.length > 0) {
                      await updateDeliveryLocal(incompleteDeliveries[0].id, { isNextDelivery: true }, { skipSmartRefresh: true });
                      invalidate('Delivery');
                      await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
                      setTimeout(() => {
                        const nextCardElement = document.getElementById(`stop-card-${incompleteDeliveries[0].id}`);
                        if (nextCardElement) nextCardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                      }, 100);
                    } else {
                      fabControlEvents.notifyDoneButtonClicked();
                      window.dispatchEvent(new CustomEvent('showRouteSummary', {
                        detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
                      }));
                    }

                    window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
                      detail: { triggeredBy: 'complete', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
                    }));

                    if (onSelectionChange) {
                      onSelectionChange(delivery.id, false);
                    } else if (onClick) {
                      onClick(null);
                    }

                    driverLocationPoller.resume();
                    fabControlEvents.reactivateFAB(true);
                  }
                } catch (error) {
                  console.error('❌ Failed to save COD:', error);
                  fabControlEvents.reactivateFAB(true);
                } finally {
                  setIsCompleting(false);
                }
              }}
              disabled={codPayments.length === 0 || isCompleting}>
              {isCompleting ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : delivery.status === 'completed' ? <Save className="w-3 h-3 mr-1" /> : <CheckCircle className="w-3 h-3 mr-1" />}
              {delivery.status === 'completed' ? 'Save' : 'Save & Complete'}
            </Button>
          </div>
        </motion.div>
      }
    </AnimatePresence>
  );
}