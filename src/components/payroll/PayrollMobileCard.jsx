import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * Mobile-friendly payroll card for displaying driver payroll
 * Collapses stats into expandable sections and stacks pay summary vertically
 */
export default function PayrollMobileCard({ 
  data,
  isAdmin,
  driverHasConfirmed,
  adminHasFinalized,
  showBadge,
  canShowConfirmButton,
  onConfirmClick,
  isFinalizing,
  formatCurrency,
  deliveries = [],
  patients = [],
  currentPeriod = null
}) {
  const [expandedSection, setExpandedSection] = useState(null);

  const toggleSection = (section) => {
    setExpandedSection(expandedSection === section ? null : section);
  };

  // Calculate YTD totals from deliveries
  const calculateYTDTotals = () => {
    if (!currentPeriod || !deliveries.length) {
      return { ytdGrossPay: 0, ytdNetPay: 0, ytdTaxAmount: 0, ytdDeductions: 0, ytdBonusPay: 0 };
    }

    const yearStart = new Date(currentPeriod.start.getFullYear(), 0, 1);
    const ytdDeliveries = deliveries.filter(d => {
      if (!d || d.driver_id !== data.driver.id) return false;
      const validStatus = d.status === 'completed' || d.status === 'failed' || (d.status === 'cancelled' && d.after_hours_pickup);
      if (!validStatus) return false;
      const deliveryDate = new Date(d.delivery_date + 'T00:00:00');
      return deliveryDate >= yearStart && deliveryDate <= currentPeriod.end;
    });

    const ytdTotalDeliveries = ytdDeliveries.length;
    const ytdTotalBasePay = ytdTotalDeliveries * data.payRate;
    
    const ytdExtraKm = ytdDeliveries.reduce((sum, d) => {
      const patient = patients?.find(p => p?.id === d.patient_id);
      if (!patient?.distance_from_store) return sum;
      const distance = d.paid_km_override ?? patient.distance_from_store;
      const extraKm = Math.max(0, distance - data.extraKmLimit);
      return sum + extraKm;
    }, 0);
    const ytdExtraKmPay = ytdExtraKm * data.extraKmRate;
    
    const ytdOversizedCount = ytdDeliveries.filter(d => d.oversized).length;
    const ytdOversizedPay = ytdOversizedCount * data.oversizedRate;
    
    const ytdGrossPay = ytdTotalBasePay + ytdExtraKmPay + ytdOversizedPay;
    const ytdTaxAmount = data.taxRate ? ytdGrossPay * data.taxRate : 0;
    const ytdDeductions = data.totalDeductions || 0;
    const ytdBonusPay = data.bonusPay || 0;
    const ytdNetPay = ytdGrossPay - ytdTaxAmount - ytdDeductions + ytdBonusPay;

    return { ytdGrossPay, ytdNetPay, ytdTaxAmount, ytdDeductions, ytdBonusPay };
  };

  const ytdTotals = calculateYTDTotals();



  return (
    <div className="p-4 rounded-lg space-y-3" style={{ background: 'var(--bg-slate-50)' }}>
      {/* Driver Name Header */}
      <div className="flex items-center justify-between">
        <h3 className="font-semibold flex items-center gap-2" style={{ color: 'var(--text-slate-900)' }}>
          {data.driver.user_name || data.driver.full_name}
          {showBadge && (
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500" 
              title={isAdmin ? 'Driver confirmed' : 'Admin finalized'}>
              <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
            </span>
          )}
        </h3>
        {canShowConfirmButton && (
          <button 
            onClick={onConfirmClick}
            disabled={isFinalizing}
            className="px-3 py-1.5 rounded text-xs font-medium gap-1 bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isFinalizing ? 'Confirming...' : 'Confirm'}
          </button>
        )}
      </div>

      {/* Rates Section - Collapsible */}
      <div className="border rounded" style={{ borderColor: 'var(--border-slate-200)' }}>
        <button
          onClick={() => toggleSection('rates')}
          className="w-full px-3 py-2 flex items-center justify-between hover:bg-slate-200 transition-colors"
          style={{ background: 'var(--bg-white)' }}
        >
          <span className="text-xs font-semibold" style={{ color: 'var(--text-slate-700)' }}>Pay Rates</span>
          <ChevronDown 
            className="w-4 h-4 transition-transform" 
            style={{ 
              transform: expandedSection === 'rates' ? 'rotate(180deg)' : 'rotate(0deg)',
              color: 'var(--text-slate-500)'
            }} 
          />
        </button>
        {expandedSection === 'rates' && (
          <div className="px-3 py-2 space-y-1.5 text-xs" style={{ background: 'var(--bg-white)', borderTop: '1px solid var(--border-slate-200)' }}>
            <div className="flex justify-between">
              <span style={{ color: 'var(--text-slate-600)' }}>Per Delivery:</span>
              <span className="font-semibold" style={{ color: 'var(--text-slate-900)' }}>{formatCurrency(data.payRate)}</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: 'var(--text-slate-600)' }}>Extra KM:</span>
              <span className="font-semibold" style={{ color: 'var(--text-slate-900)' }}>{formatCurrency(data.extraKmRate, 3)}/km</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: 'var(--text-slate-600)' }}>Oversized:</span>
              <span className="font-semibold" style={{ color: 'var(--text-slate-900)' }}>{formatCurrency(data.oversizedRate)}</span>
            </div>
            {data.extraKmLimit > 0 && (
              <div className="flex justify-between text-[11px]" style={{ color: 'var(--text-slate-500)' }}>
                <span>KM Limit:</span>
                <span>{data.extraKmLimit}km</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Deliveries Section - Collapsible */}
      <div className="border rounded" style={{ borderColor: 'var(--border-slate-200)' }}>
        <button
          onClick={() => toggleSection('deliveries')}
          className="w-full px-3 py-2 flex items-center justify-between hover:bg-slate-200 transition-colors"
          style={{ background: 'var(--bg-white)' }}
        >
          <span className="text-xs font-semibold" style={{ color: 'var(--text-slate-700)' }}>Deliveries</span>
          <ChevronDown 
            className="w-4 h-4 transition-transform" 
            style={{ 
              transform: expandedSection === 'deliveries' ? 'rotate(180deg)' : 'rotate(0deg)',
              color: 'var(--text-slate-500)'
            }} 
          />
        </button>
        {expandedSection === 'deliveries' && (
          <div className="px-3 py-2 space-y-1.5 text-xs" style={{ background: 'var(--bg-white)', borderTop: '1px solid var(--border-slate-200)' }}>
            <div className="flex justify-between">
              <span style={{ color: 'var(--text-slate-600)' }}>Total:</span>
              <span className="font-semibold" style={{ color: 'var(--text-slate-900)' }}>
                {data.totalDeliveries}x @ {formatCurrency(data.payRate)}
              </span>
            </div>
            <div className="flex justify-between" style={{ color: 'var(--text-slate-900)' }}>
              <span style={{ color: 'var(--text-slate-600)' }}>Subtotal:</span>
              <span className="font-semibold">{formatCurrency(data.totalBasePay)}</span>
            </div>
            {data.totalExtraKm > 0 && (
              <div className="flex justify-between">
                <span style={{ color: 'var(--text-slate-600)' }}>Extra KM:</span>
                <span className="font-semibold" style={{ color: 'var(--text-slate-900)' }}>
                  {data.totalExtraKm.toFixed(2)}km = {formatCurrency(data.totalExtraKmPay)}
                </span>
              </div>
            )}
            {data.oversizedCount > 0 && (
              <div className="flex justify-between">
                <span style={{ color: 'var(--text-slate-600)' }}>Oversized:</span>
                <span className="font-semibold" style={{ color: 'var(--text-slate-900)' }}>
                  {data.oversizedCount}x = {formatCurrency(data.totalOversizedPay)}
                </span>
              </div>
            )}
            {data.failedCount > 0 && (
              <div className="flex justify-between text-red-700">
                <span>Failed:</span>
                <span className="font-semibold">{data.failedCount}</span>
              </div>
            )}
            {data.returnsCount > 0 && (
              <div className="flex justify-between text-orange-700">
                <span>Returns:</span>
                <span className="font-semibold">{data.returnsCount}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Pay Summary - 3 Columns: Labels | Period | YTD */}
      <div style={{ display: !currentPeriod || !(data.ytd_gross_pay || data.ytdGrossPay) ? 'none' : 'block' }} className="p-3 rounded-lg border" style={{ 
        background: 'var(--bg-white)', 
        borderColor: 'var(--border-slate-200)',
        fontVariantNumeric: 'tabular-nums'
      }}>
        <div className="space-y-1 text-xs font-mono">
          {/* Header */}
          <div className="flex gap-2 mb-2 font-semibold pb-1 border-b" style={{ borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-700)' }}>
            <div className="flex-1"></div>
            <div className="w-24 text-right">Period</div>
            <div className="w-24 text-right">YTD</div>
          </div>

          {/* Net */}
          <div className="flex gap-2">
            <div className="flex-1 text-left" style={{ color: 'var(--text-slate-600)' }}>Net</div>
            <div className="w-24 text-right">{formatCurrency(data.grandTotal || 0)}</div>
            <div className="w-24 text-right">{formatCurrency(data.ytd_net_pay || data.ytdNetPay || 0)}</div>
          </div>

          {/* Tax */}
          <div className="flex gap-2">
            <div className="flex-1 text-left" style={{ color: 'var(--text-slate-600)' }}>Tax</div>
            <div className="w-24 text-right">{formatCurrency(data.taxAmount || 0)}</div>
            <div className="w-24 text-right">{formatCurrency(data.ytd_tax_amount || data.ytdTaxAmount || 0)}</div>
          </div>

          {/* Deductions */}
          <div className="flex gap-2 text-red-700">
            <div className="flex-1 text-left">Deductions</div>
            <div className="w-24 text-right">-{formatCurrency(data.total_deductions || data.totalDeductions || 0)}</div>
            <div className="w-24 text-right">-{formatCurrency(data.ytd_deductions || data.ytdDeductions || 0)}</div>
          </div>

          {/* Bonus (if any) */}
          {(data.bonus_pay || data.bonusPay || data.ytd_bonus_pay || data.ytdBonusPay) > 0 && (
            <div className="flex gap-2 text-blue-700">
              <div className="flex-1 text-left">Bonus</div>
              <div className="w-24 text-right">{formatCurrency(data.bonus_pay || data.bonusPay || 0)}</div>
              <div className="w-24 text-right">{formatCurrency(data.ytd_bonus_pay || data.ytdBonusPay || 0)}</div>
            </div>
          )}

          {/* Gross (bold, divider) */}
          <div className="flex gap-2 pt-1 border-t font-bold" style={{ borderColor: 'var(--border-slate-200)', color: '#10b981' }}>
            <div className="flex-1 text-left">Gross</div>
            <div className="w-24 text-right">{formatCurrency(data.grossPay || data.gross_pay || 0)}</div>
            <div className="w-24 text-right">{formatCurrency(data.ytd_gross_pay || data.ytdGrossPay || 0)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}