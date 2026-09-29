import React, { useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X, Plus, Loader2, CheckCircle, Save } from "lucide-react";
import { userHasRole } from '../utils/userRoles';
import { invalidate } from '../utils/dataManager';
import { smartRefreshManager } from '../utils/smartRefreshManager';
import { performSaveAndCompleteCOD } from './stopCardCodSaveComplete';

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
  hideSaveButtonForFooterSwap = false
}) {
  const codAmountInputRefs = useRef([]);
  const codRefreshPauseRef = useRef(false);

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
        className="overflow-visible rounded-md space-y-2 w-full relative z-[10000] px-3"
        style={{ background: 'var(--bg-slate-50)' }}
        onAnimationStart={() => {
          if (!codRefreshPauseRef.current) {
            smartRefreshManager.pause();
            codRefreshPauseRef.current = true;
          }
        }}
        onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between">
            <span className="text-sm md:text-xs font-semibold text-body-2">Collect COD Payments</span>
            <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={async (e) => {
            if (codRefreshPauseRef.current) {
              smartRefreshManager.resume();
              codRefreshPauseRef.current = false;
            }
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

          <div className="space-y-2 max-h-48 overflow-y-visible">
            {codPayments.map((payment, index) =>
          <div key={index} className="flex items-center gap-2 rounded px-1 bg-surface border-surface" style={{ borderWidth: '1px' }}>
                <Select value={payment.type} onValueChange={(value) => handleCODPaymentChange(index, 'type', value)} onOpenChange={(open) => {if (open) setShowCODCollection(true);}}>
                  <SelectTrigger className="h-7 text-sm md:text-xs w-24" onClick={(e) => e.stopPropagation()} data-cod-select-index={index}>
                    <SelectValue placeholder="Type" />
                  </SelectTrigger>
                  <SelectContent position="item-aligned" side="bottom" onClick={(e) => e.stopPropagation()} className="z-[2147483647] relative">
                    <SelectItem value="Cash">Cash</SelectItem>
                    <SelectItem value="Debit">Debit</SelectItem>
                    <SelectItem value="Credit">Credit</SelectItem>
                    <SelectItem value="Cheque">Cheque</SelectItem>
                  </SelectContent>
                </Select>

                <div className="relative flex-1">
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-sm md:text-xs text-soft">$</span>
                  <input
                ref={(el) => codAmountInputRefs.current[index] = el}
                type="text"
                value={payment.amount > 0 ? payment.amount.toFixed(2) : payment.amount === 0 ? '0.00' : ''}
                onChange={(e) => handleCODPaymentChange(index, 'amount', e.target.value)} className="h-10 w-full pl-5 pr-2 text-sm md:text-xs rounded-md text-body bg-surface" style={{ borderWidth: '1px', borderColor: 'var(--border-slate-300)' }}
                placeholder="0.00"
                onClick={(e) => e.stopPropagation()}
                onFocus={(e) => e.target.select()} />
                </div>

                <Button aria-label="Remove COD payment" size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-600 hover:text-red-800" onClick={(e) => {e.stopPropagation();handleRemoveCODPayment(index);}}>
                  <X className="w-3 h-3" />
                </Button>
              </div>
          )}
          </div>

          <Button size="sm" variant="outline" className="w-full h-7 text-sm md:text-xs" onClick={(e) => {e.stopPropagation();handleAddCODPayment();}}>
            <Plus className="w-3 h-3 mr-1" />
            Add Payment
          </Button>

          <div className="flex items-center justify-between border-surface" style={{ borderTopWidth: '1px' }}>
            <div className="text-sm md:text-xs">
              <span className="text-label">Total: </span>
              <span className="font-bold" style={{ color: isCODComplete ? 'var(--text-emerald-600)' : 'var(--text-amber-600)' }}>
                ${codTotalCollected.toFixed(2)}
              </span>
              <span className="text-label"> / ${codTotalRequired.toFixed(2)}</span>
            </div>

            {/* OWNER DIRECTIVE (Sep 29 2026): while this delivery is the next-delivery
                card (Complete would normally show), the footer swaps in its own
                Save & Complete button in the Complete button's slot and hides
                Complete — hide this in-panel button too, to avoid a duplicate.
                For every other case (e.g. editing COD on an already-completed
                delivery, where no footer Complete button exists to swap with),
                this in-panel button remains the only Save/Save & Complete action. */}
            {!hideSaveButtonForFooterSwap &&
            <Button
            size="sm"
            className="inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 text-primary-foreground shadow rounded-md px-3 h-7 text-sm md:text-xs !text-white bg-emerald-600 hover:bg-emerald-700"
            onClick={(e) => {
              e.stopPropagation();
              performSaveAndCompleteCOD({
                delivery,
                codPayments,
                allDeliveries,
                FINISHED_STATUSES,
                onCODUpdate,
                setShowCODCollection,
                setIsCompleting,
                onSelectionChange,
                onClick,
                codRefreshPauseRef,
              });
            }}
            disabled={codPayments.length === 0 || isCompleting}>
              {isCompleting ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : delivery.status === 'completed' ? <Save className="w-3 h-3 mr-1" /> : <CheckCircle className="w-3 h-3 mr-1" />}
              {delivery.status === 'completed' ? 'Save' : 'Save & Complete'}
            </Button>
            }
          </div>
        </motion.div>
      }
    </AnimatePresence>);

}