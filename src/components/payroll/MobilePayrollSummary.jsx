import React from "react";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";

export default function MobilePayrollSummary({ periodLabel, totalNetPay, totalDeliveries, onPrev, onNext }) {
  const net = Number(totalNetPay || 0);
  const deliveries = Number(totalDeliveries || 0);
  const money = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'CAD', maximumFractionDigits: 2 }).format(net);

  return (
    <div className="lg:hidden sticky top-16 z-10 mb-3 bg-white/95 dark:bg-slate-900/85 backdrop-blur border border-slate-200 dark:border-slate-700 rounded-xl p-3 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button size="icon" variant="outline" onClick={onPrev} className="h-8 w-8">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="text-sm font-medium truncate" title={periodLabel}>{periodLabel || 'Current Period'}</div>
          <Button size="icon" variant="outline" onClick={onNext} className="h-8 w-8">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-[11px] text-slate-500 dark:text-slate-400 leading-tight">Net Pay</div>
            <div className="text-base font-semibold leading-tight">{money}</div>
          </div>
          <div className="h-8 w-px bg-slate-200 dark:bg-slate-700" />
          <div className="text-right">
            <div className="text-[11px] text-slate-500 dark:text-slate-400 leading-tight">Deliveries</div>
            <div className="text-base font-semibold leading-tight">{deliveries}</div>
          </div>
        </div>
      </div>
    </div>
  );
}