import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useUser } from '../utils/UserContext';

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
  currentPeriod = null,
  bonusAmount = 0,
  appFeeAmount = 0,
  appFeePercent = 0,
  ytdDataByDriver = {},
  isPeriodEndOfMonth = false,
  onDeductionsClick,
  onBonusClick,
  onAppFeeClick,
  onNotesClick
}) {
  const [expandedSection, setExpandedSection] = useState(null);
  const { currentUser } = useUser();
  const [payrollRecordId, setPayrollRecordId] = useState(null);
  const [payrollRecord, setPayrollRecord] = useState(null);
  const [adminNotes, setAdminNotes] = useState('');
  const [driverNotes, setDriverNotes] = useState('');
  const [isSavingAdmin, setIsSavingAdmin] = useState(false);
  const [isSavingDriver, setIsSavingDriver] = useState(false);

    const toLocalYMD = (d) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const da = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${da}`;
    };

    React.useEffect(() => {
    if (!currentPeriod || !data?.driver?.id) return;
    const startStr = toLocalYMD(currentPeriod.start);
    const endStr = toLocalYMD(currentPeriod.end);
    (async () => {
      try {
        const list = await base44.entities.Payroll.filter({ driver_id: data.driver.id, pay_period_start: startStr, pay_period_end: endStr }, '-updated_date', 1);
        const rec = Array.isArray(list) ? list[0] : list;
        if (rec) {
          setPayrollRecordId(rec.id);
          setPayrollRecord(rec);
          setAdminNotes(rec.admin_notes || '');
          setDriverNotes(rec.driver_notes || '');
        } else {
          setPayrollRecordId(null);
          setPayrollRecord(null);
          setAdminNotes('');
          setDriverNotes('');
        }
      } catch (_) { /* no-op */ }
    })();
  }, [currentPeriod?.start, currentPeriod?.end, data?.driver?.id]);

  const canEditDriverNotes = isAdmin || (currentUser?.id === data.driver.id);
  const canEditAdminNotes = !!isAdmin;

  const saveAdminNotes = async (value) => {
    if (!payrollRecordId || !canEditAdminNotes) return;
    setIsSavingAdmin(true);
    try { await base44.entities.Payroll.update(payrollRecordId, { admin_notes: value }); }
    finally { setIsSavingAdmin(false); }
  };

  const saveDriverNotes = async (value) => {
    if (!payrollRecordId || !canEditDriverNotes) return;
    setIsSavingDriver(true);
    try { await base44.entities.Payroll.update(payrollRecordId, { driver_notes: value }); }
    finally { setIsSavingDriver(false); }
  };

  const toggleSection = (section) => {
    setExpandedSection(expandedSection === section ? null : section);
  };

  // Calculate YTD totals from deliveries
  const calculateYTDTotals = () => {
    if (!currentPeriod || !deliveries.length) {
      return { ytdGrossPay: 0, ytdNetPay: 0, ytdTaxAmount: 0, ytdDeductions: 0, ytdBonusPay: 0, ytdAppFeeAmount: 0 };
    }

    const yearStart = new Date(currentPeriod.start.getFullYear(), 0, 1);
    const ytdDeliveries = deliveries.filter((d) => {
      if (!d || d.driver_id !== data.driver.id) return false;
      const validStatus = (d.status === 'completed' || d.status === 'failed' || (d.status === 'cancelled' && d.after_hours_pickup));
      if (!validStatus) return false;
      const deliveryDate = new Date(d.delivery_date + 'T00:00:00');
      return deliveryDate >= yearStart && deliveryDate <= currentPeriod.end;
    });

    const ytdTotalDeliveries = ytdDeliveries.length;
    const ytdTotalBasePay = ytdTotalDeliveries * data.payRate;

    const ytdExtraKm = ytdDeliveries.reduce((sum, d) => {
      const patient = patients?.find((p) => p?.id === d.patient_id);
      if (!patient?.distance_from_store) return sum;
      const distance = d.paid_km_override ?? patient.distance_from_store;
      const extraKm = Math.max(0, distance - data.extraKmLimit);
      return sum + extraKm;
    }, 0);
    const ytdExtraKmPay = ytdExtraKm * data.extraKmRate;

    const ytdOversizedCount = ytdDeliveries.filter((d) => d.oversized).length;
    const ytdOversizedPay = ytdOversizedCount * data.oversizedRate;

    const ytdGrossPay = ytdTotalBasePay + ytdExtraKmPay + ytdOversizedPay;
    const ytdTaxAmount = data.taxRate ? ytdGrossPay * data.taxRate : 0;
    const ytdDeductions = data.totalDeductions || 0;
    const ytdBonusPay = data.bonusPay || 0;
    const ytdAppFeeAmount = data.appFeeAmount || 0;
    const ytdNetPay = ytdGrossPay - ytdTaxAmount - ytdDeductions + ytdBonusPay + ytdAppFeeAmount;

    return { ytdGrossPay, ytdNetPay, ytdTaxAmount, ytdDeductions, ytdBonusPay, ytdAppFeeAmount };
  };

  const ytdTotals = calculateYTDTotals();

  // Period values aligned with desktop with 2-decimal rounding per component to avoid penny drift
  const r2 = (n) => Math.round((n || 0) * 100) / 100;
  const periodGross = r2(data?.grandTotal || 0);
  const periodTax = r2(data?.taxAmount || 0);
  const periodDeductions = r2(payrollRecord?.total_deductions ?? (data?.deductions || data?.total_deductions || data?.totalDeductions || 0));
  const periodBonus = r2(bonusAmount || 0);
  const periodAppFee = r2(appFeeAmount || 0);
  const periodNet = r2(periodGross + periodTax - periodDeductions + periodBonus + periodAppFee);



  return (
    <div className="p-4 rounded-lg space-y-3 bg-white dark:bg-slate-800/50 w-full max-w-full overflow-hidden">
      {/* Driver Name Header */}
      <div className="flex items-center justify-between">
        <h3 className="font-semibold flex items-center gap-2" style={{ color: 'var(--text-slate-900)' }}>
          {data.driver.user_name || data.driver.full_name}
          {showBadge &&
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500"
          title={isAdmin ? 'Driver confirmed' : 'Admin finalized'}>
              <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
            </span>
          }
        </h3>
        {canShowConfirmButton &&
        <button
          onClick={onConfirmClick}
          disabled={isFinalizing}
          className="px-3 py-1.5 rounded text-xs font-medium gap-1 bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors">

            {isFinalizing ? 'Confirming...' : 'Confirm'}
          </button>
        }
      </div>

      {/* Deliveries Section - Collapsible */}
      <div className="border rounded" style={{ borderColor: 'var(--border-slate-200)' }}>
        <button
          onClick={() => toggleSection('deliveries')}
          className="w-full px-3 py-2 flex items-center justify-between hover:bg-slate-200 transition-colors"
          style={{ background: 'var(--bg-white)' }}>

          <span className="text-xs font-semibold" style={{ color: 'var(--text-slate-700)' }}>Deliveries</span>
          <ChevronDown
            className="w-4 h-4 transition-transform"
            style={{
              transform: expandedSection === 'deliveries' ? 'rotate(180deg)' : 'rotate(0deg)',
              color: 'var(--text-slate-500)'
            }} />

        </button>
        {expandedSection === 'deliveries' &&
        <div className="px-3 py-2 text-xs font-mono flex flex-col justify-between overflow-x-hidden w-full" style={{ background: 'var(--bg-white)', borderTop: '1px solid var(--border-slate-200)', minHeight: '120px' }}>
            {/* 5-column grid layout */}
            <div className="space-y-1" style={{ display: 'grid', gridTemplateColumns: '1fr 0.5fr 0.8fr 0.35fr 1fr', columnGap: '0.25rem', fontSize: '0.75rem', fontFamily: 'monospace', minWidth: 0, width: '100%' }}>
              {/* Total */}
              <span style={{ color: 'var(--text-slate-600)' }}>Total:</span>
              <span className="font-semibold text-right" style={{ color: 'var(--text-slate-900)' }}>{data.totalDeliveries}x</span>
              <span className="text-right" style={{ color: 'var(--text-slate-600)' }}>@ {formatCurrency(data.payRate)}</span>
              <span style={{ color: 'var(--text-slate-600)' }}>= $</span>
              <span className="font-semibold text-right" style={{ color: 'var(--text-slate-900)' }}>{data.totalBasePay.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>

              {/* Extra KM */}
              <span style={{ color: 'var(--text-slate-600)', display: data.totalExtraKm > 0 ? 'block' : 'none' }}>Extra KM:</span>
              <span className="font-semibold text-right" style={{ color: 'var(--text-slate-900)', display: data.totalExtraKm > 0 ? 'block' : 'none' }}>{data.totalExtraKm.toFixed(2)}km</span>
              <span className="text-right" style={{ color: 'var(--text-slate-600)', display: data.totalExtraKm > 0 ? 'block' : 'none' }}>@ {formatCurrency(data.extraKmRate, 3)}</span>
              <span style={{ color: 'var(--text-slate-600)', display: data.totalExtraKm > 0 ? 'block' : 'none' }}>= $</span>
              <span className="font-semibold text-right" style={{ color: 'var(--text-slate-900)', display: data.totalExtraKm > 0 ? 'block' : 'none' }}>{data.totalExtraKmPay.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>

              {/* Oversized */}
              <span style={{ color: 'var(--text-slate-600)', display: data.oversizedCount > 0 ? 'block' : 'none' }}>Oversized:</span>
              <span className="font-semibold text-right" style={{ color: 'var(--text-slate-900)', display: data.oversizedCount > 0 ? 'block' : 'none' }}>{data.oversizedCount}x</span>
              <span className="text-right" style={{ color: 'var(--text-slate-600)', display: data.oversizedCount > 0 ? 'block' : 'none' }}>@ {formatCurrency(data.oversizedRate)}</span>
              <span style={{ color: 'var(--text-slate-600)', display: data.oversizedCount > 0 ? 'block' : 'none' }}>= $</span>
              <span className="font-semibold text-right" style={{ color: 'var(--text-slate-900)', display: data.oversizedCount > 0 ? 'block' : 'none' }}>{data.totalOversizedPay.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>

            {/* Failed & Returns counts */}
            <div className="flex items-center gap-3 pt-1 border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
              {(data.failedCount > 0 || data.returnsCount > 0) &&
            <>
                  <span style={{ color: 'var(--text-red-600)' }}>Failed: <span className="font-semibold">{data.failedCount}</span></span>
                  <span style={{ color: 'var(--text-orange-600)' }}>Returns: <span className="font-semibold">{data.returnsCount}</span></span>
                </>
            }
            </div>
          </div>
        }
      </div>

      {/* Pay Summary - Table Layout with Aligned Columns */}
      {currentPeriod && (
      <div className="p-3 rounded-lg border w-full overflow-x-hidden" style={{
        background: 'var(--bg-white)',
        borderColor: 'var(--border-slate-200)',
        fontVariantNumeric: 'tabular-nums'
      }}>
        <div className="text-xs font-mono" style={{ color: 'var(--text-slate-900)', minWidth: 0, width: '100%' }}>
          {/* Header Row */}
          <div className="grid gap-1 mb-2 font-semibold pb-1 border-b" style={{ 
            gridTemplateColumns: '1fr 22px 60px 22px 60px',
            borderColor: 'var(--border-slate-200)', 
            color: 'var(--text-slate-700)' 
          }}>
            <div></div>
            <div></div>
            <div className="text-right">Period</div>
            <div></div>
            <div className="text-right">YTD</div>
          </div>

          {/* Net */}
          <div className="grid gap-1" style={{ gridTemplateColumns: '1fr 22px 60px 22px 60px' }}>
            <div className="text-left" style={{ color: 'var(--text-slate-600)' }}>Gross:</div>
            <div className="text-right pr-0.5" style={{ color: 'var(--text-slate-600)' }}>$</div>
            <div className="text-right font-semibold">{periodGross.toFixed(2)}</div>
            <div className="text-right pr-0.5" style={{ color: 'var(--text-slate-600)' }}>$</div>
            <div className="text-right font-semibold">{(ytdDataByDriver[data.driver.id]?.ytdGrossPay || 0).toFixed(2)}</div>
          </div>

          {/* Tax (if any) */}
          {((data.taxAmount || 0) > 0 || (ytdDataByDriver[data.driver.id]?.ytdTaxAmount || 0) > 0) &&
          <div className="grid gap-1" style={{ gridTemplateColumns: '1fr 22px 60px 22px 60px' }}>
            <div className="text-left" style={{ color: 'var(--text-slate-600)' }}>Tax:</div>
            <div className="text-right pr-0.5" style={{ color: 'var(--text-slate-600)' }}>$</div>
            <div className="text-right font-semibold">{periodTax.toFixed(2)}</div>
            <div className="text-right pr-0.5" style={{ color: 'var(--text-slate-600)' }}>$</div>
            <div className="text-right font-semibold">{(ytdDataByDriver[data.driver.id]?.ytdTaxAmount || 0).toFixed(2)}</div>
          </div>
          }

          {/* Deductions (if any) */}
          {(isAdmin || ((data.deductions || data.total_deductions || data.totalDeductions || 0) > 0 || (ytdDataByDriver[data.driver.id]?.ytdDeductionsAmount || 0) > 0)) &&
          <div className="grid gap-1 text-red-700" style={{ gridTemplateColumns: '1fr 22px 60px 22px 60px' }}>
            <div className="text-left">
              {isAdmin && onDeductionsClick ? (
                <button onClick={() => onDeductionsClick(data.driver.id)} className="text-blue-600 hover:text-blue-700 font-medium">
                  Deductions:
                </button>
              ) : (
                'Deductions:'
              )}
            </div>
            <div className="text-right pr-0.5">-$</div>
            <div className="text-right font-semibold">{(periodDeductions).toFixed(2)}</div>
            <div className="text-right pr-0.5">-$</div>
            <div className="text-right font-semibold">{(ytdDataByDriver[data.driver.id]?.ytdDeductionsAmount || 0).toFixed(2)}</div>
          </div>
          }

          {/* Bonus (if any) */}
          {(isAdmin || ((bonusAmount || 0) > 0 || (ytdDataByDriver[data.driver.id]?.ytdBonusAmount || 0) > 0)) &&
          <div className="grid gap-1" style={{ gridTemplateColumns: '1fr 22px 60px 22px 60px', color: 'var(--text-blue-700)' }}>
              <div className="text-left">
                {isAdmin && onBonusClick ? (
                  <button onClick={() => onBonusClick(data.driver.id)} className="text-blue-600 hover:text-blue-700 font-medium">
                    Bonus:
                  </button>
                ) : (
                  'Bonus:'
                )}
              </div>
              <div className="text-right pr-0.5">+$</div>
              <div className="text-right font-semibold">{(bonusAmount || 0).toFixed(2)}</div>
              <div className="text-right pr-0.5">+$</div>
              <div className="text-right font-semibold">{(ytdDataByDriver[data.driver.id]?.ytdBonusAmount || 0).toFixed(2)}</div>
            </div>
          }

          {/* App Fee (if any) */}
          {isAdmin && (isPeriodEndOfMonth || ((appFeeAmount || 0) > 0 || (ytdDataByDriver[data.driver.id]?.ytdAppFeeAmount || 0) > 0)) &&
          <div className="grid gap-1" style={{ gridTemplateColumns: '1fr 22px 60px 22px 60px', color: 'var(--text-purple-700)' }}>
              <div className="text-left">
                {onAppFeeClick ? (
                  <button onClick={() => onAppFeeClick(data.driver.id)} className="text-blue-600 hover:text-blue-700 font-medium">
                    App Fee %:
                  </button>
                ) : (
                  'App Fee %:'
                )}
              </div>
              <div className="text-right pr-0.5">+$</div>
              <div className="text-right font-semibold">{(appFeeAmount || 0).toFixed(2)}</div>
              <div className="text-right pr-0.5">+$</div>
              <div className="text-right font-semibold">{(ytdDataByDriver[data.driver.id]?.ytdAppFeeAmount || 0).toFixed(2)}</div>
            </div>
          }

          {/* Gross (bold, divider) */}
          <div className="grid gap-1 pt-1 border-t font-bold" style={{ 
            gridTemplateColumns: '1fr 22px 60px 22px 60px',
            borderColor: 'var(--border-slate-200)', 
            color: '#10b981' 
          }}>
            <div className="text-left">Net:</div>
            <div className="text-right pr-0.5">$</div>
            <div className="text-right">{periodNet.toFixed(2)}</div>
            <div className="text-right pr-0.5">$</div>
            <div className="text-right">{(ytdDataByDriver[data.driver.id]?.ytdNetPay || 0).toFixed(2)}</div>
          </div>

          {/* Inline Notes (hidden from exports) */}
          <div data-notes-section="true" className="mt-3 space-y-3">
            {isAdmin && (
              <div>
                <div className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">Admin Notes</div>
                <textarea
                  value={adminNotes}
                  onChange={(e) => setAdminNotes(e.target.value)}
                  onBlur={() => saveAdminNotes(adminNotes)}
                  disabled={!canEditAdminNotes || !payrollRecordId}
                  className="w-full min-h-[64px] text-xs p-2 rounded border border-slate-200 bg-white text-slate-900 placeholder-slate-400 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100 dark:placeholder-slate-500 disabled:opacity-60"
                  placeholder={payrollRecordId ? "Private notes (admins only)" : "Notes unavailable (no record yet)"}
                />
                {isSavingAdmin && <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">Saving...</div>}
              </div>
            )}
            <div>
              <div className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">Driver Notes</div>
              <textarea
                value={driverNotes}
                onChange={(e) => setDriverNotes(e.target.value)}
                onBlur={() => saveDriverNotes(driverNotes)}
                disabled={!canEditDriverNotes || !payrollRecordId}
                className="w-full min-h-[64px] text-xs p-2 rounded border border-slate-200 bg-white text-slate-900 placeholder-slate-400 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100 dark:placeholder-slate-500 disabled:opacity-60"
                placeholder={payrollRecordId ? "Visible to driver + admins" : "Notes unavailable (no record yet)"}
              />
              {isSavingDriver && <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">Saving...</div>}
            </div>
          </div>
        </div>
      </div>
      )}
    </div>);

}