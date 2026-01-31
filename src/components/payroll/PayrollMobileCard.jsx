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

      {/* Pay Summary - Period vs YTD Side by Side */}
      {hasYTD ? (
        <div className="p-3 rounded-lg border" style={{ 
          background: 'var(--bg-white)', 
          borderColor: 'var(--border-slate-200)',
          fontVariantNumeric: 'tabular-nums'
        }}>
          <div className="flex gap-4 mb-2">
            <h4 className="text-xs font-semibold flex-1" style={{ color: 'var(--text-slate-700)' }}>Period</h4>
            <h4 className="text-xs font-semibold flex-1" style={{ color: 'var(--text-slate-700)' }}>YTD</h4>
          </div>
          <div className="space-y-1.5 text-xs">
            <div className="flex gap-4">
              <div className="flex-1">
                <div className="flex justify-between">
                  <span style={{ color: 'var(--text-slate-600)' }}>Net:</span>
                  <span className="font-semibold">{formatCurrency(data.grandTotal || 0)}</span>
                </div>
              </div>
              <div className="flex-1">
                <div className="flex justify-between">
                  <span style={{ color: 'var(--text-slate-600)' }}>Net:</span>
                  <span className="font-semibold">{formatCurrency(data.ytd_net_pay || data.ytdNetPay || 0)}</span>
                </div>
              </div>
            </div>
            <div className="flex gap-4">
              <div className="flex-1">
                <div className="flex justify-between">
                  <span style={{ color: 'var(--text-slate-600)' }}>Tax:</span>
                  <span className="font-semibold">{formatCurrency(data.taxAmount || 0)}</span>
                </div>
              </div>
              <div className="flex-1">
                <div className="flex justify-between">
                  <span style={{ color: 'var(--text-slate-600)' }}>Tax:</span>
                  <span className="font-semibold">{formatCurrency(data.ytd_tax_amount || data.ytdTaxAmount || 0)}</span>
                </div>
              </div>
            </div>
            <div className="flex gap-4">
              <div className="flex-1">
                <div className="flex justify-between text-red-700">
                  <span>Deductions:</span>
                  <span className="font-semibold">-{formatCurrency(data.total_deductions || data.totalDeductions || 0)}</span>
                </div>
              </div>
              <div className="flex-1">
                <div className="flex justify-between text-red-700">
                  <span>Deductions:</span>
                  <span className="font-semibold">-{formatCurrency(data.ytd_deductions || data.ytdDeductions || 0)}</span>
                </div>
              </div>
            </div>
            {(data.bonus_pay || data.bonusPay || data.ytd_bonus_pay || data.ytdBonusPay) > 0 && (
              <div className="flex gap-4 text-blue-700">
                <div className="flex-1">
                  <div className="flex justify-between">
                    <span>Bonus:</span>
                    <span className="font-semibold">{formatCurrency(data.bonus_pay || data.bonusPay || 0)}</span>
                  </div>
                </div>
                <div className="flex-1">
                  <div className="flex justify-between">
                    <span>Bonus:</span>
                    <span className="font-semibold">{formatCurrency(data.ytd_bonus_pay || data.ytdBonusPay || 0)}</span>
                  </div>
                </div>
              </div>
            )}
            <div className="pt-1.5 border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
              <div className="flex gap-4">
                <div className="flex-1">
                  <div className="flex justify-between font-bold" style={{ color: '#10b981' }}>
                    <span>Gross:</span>
                    <span>{formatCurrency(data.grossPay || data.gross_pay || 0)}</span>
                  </div>
                </div>
                <div className="flex-1">
                  <div className="flex justify-between font-bold" style={{ color: '#10b981' }}>
                    <span>Gross:</span>
                    <span>{formatCurrency(data.ytd_gross_pay || data.ytdGrossPay || 0)}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="p-3 rounded-lg border" style={{ 
          background: 'var(--bg-white)', 
          borderColor: 'var(--border-slate-200)',
          fontVariantNumeric: 'tabular-nums'
        }}>
          <h4 className="text-xs font-semibold mb-2" style={{ color: 'var(--text-slate-700)' }}>Pay Summary</h4>
          <div className="space-y-1.5 text-xs">
            <div className="flex justify-between">
              <span style={{ color: 'var(--text-slate-600)' }}>Net:</span>
              <span className="font-semibold">{formatCurrency(data.grandTotal || 0)}</span>
            </div>
            {data.taxAmount > 0 && (
              <div className="flex justify-between">
                <span style={{ color: 'var(--text-slate-600)' }}>Tax:</span>
                <span className="font-semibold">{formatCurrency(data.taxAmount)}</span>
              </div>
            )}
            {data.deductions > 0 && (
              <div className="flex justify-between text-red-700">
                <span>Deductions:</span>
                <span className="font-semibold">-{formatCurrency(data.deductions)}</span>
              </div>
            )}
            <div className="pt-1.5 border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
              <div className="flex justify-between text-sm font-bold" style={{ color: '#10b981' }}>
                <span>Gross:</span>
                <span>{formatCurrency(data.grossPay || 0)}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}