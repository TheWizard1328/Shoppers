import React from "react";
import DriverNotesInline from "./DriverNotesInline";

export default function LeftStatsAndNotes({
  data,
  formatCurrency,
  isAdmin,
  isDriver,
  currentUser,
  driverKey,
  setDeductionOverlayDriverId,
  setBonusOverlayDriverId,
  getDriverPayrollRecord,
  savePayrollChanges,
}) {
  return (
    <div className="flex flex-col">
      {/* Left: 8 Stats in 4 columns x 2 rows with fixed column widths */}
      <div
        className="grid text-xs"
        style={{ gridTemplateColumns: '150px 140px 140px 120px', gap: '1rem 1rem', rowGap: '0.125rem' }}
      >
        {/* Row 1: Rates */}
        <div className="flex items-center">
          <span className="w-10 text-right pr-1" style={{ color: 'var(--text-slate-500)' }}>Rate:</span>
          <span className="px-2 py-0.5 rounded text-[11px]" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-700)' }}>{formatCurrency(data.payRate)}</span>
        </div>
        <div className="flex items-center">
          <span className="w-8 text-right pr-1" style={{ color: 'var(--text-slate-500)' }}>KM:</span>
          <span className="px-2 py-0.5 rounded text-[11px]" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-700)' }}>{formatCurrency(data.extraKmRate, 3)}/km</span>
        </div>
        <div className="flex items-center">
          <span className="w-8 text-right pr-1" style={{ color: 'var(--text-slate-500)' }}>OS:</span>
          <span className="px-2 py-0.5 rounded text-[11px]" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-700)' }}>{formatCurrency(data.oversizedRate)}</span>
        </div>
        <div className="flex items-center">
          <span className="w-12 text-right pr-1" style={{ color: 'var(--text-slate-500)' }}>Failed:</span>
          <span className="bg-red-100 text-red-700 px-2 py-0.5 rounded text-[11px]">{data.failedCount}</span>
        </div>
        {/* Row 2: Totals */}
        <div className="flex items-center">
          <span className="w-10 text-right pr-1" style={{ color: 'var(--text-slate-500)' }}>Del:</span>
          <span className="px-2 py-0.5 rounded text-[11px] whitespace-nowrap" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-700)' }}>{data.totalDeliveries} = {formatCurrency(data.totalBasePay)}</span>
        </div>
        <div className="flex items-center">
          <span className="w-8 text-right pr-1" style={{ color: 'var(--text-slate-500)' }}>KM:</span>
          <span className="px-2 py-0.5 rounded text-[11px] whitespace-nowrap" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-700)' }}>{data.totalExtraKm.toFixed(2)} = {formatCurrency(data.totalExtraKmPay)}</span>
        </div>
        <div className="flex items-center">
          <span className="w-8 text-right pr-1" style={{ color: 'var(--text-slate-500)' }}>OS:</span>
          <span className="px-2 py-0.5 rounded text-[11px] whitespace-nowrap" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-700)' }}>{data.oversizedCount} = {formatCurrency(data.totalOversizedPay)}</span>
        </div>
        <div className="flex items-center">
          <span className="w-12 text-right pr-1" style={{ color: 'var(--text-slate-500)' }}>Returns:</span>
          <span className="bg-orange-100 text-orange-700 px-2 py-0.5 rounded text-[11px]">{data.storeReturnCount || 0}</span>
        </div>
      </div>

      {/* Desktop-only notes under the left block */}
      <div className="hidden md:block mt-2" data-notes-desktop-left>
        <DriverNotesInline
          showAdmin={isAdmin}
          canEditAdmin={isAdmin}
          canEditDriver={isAdmin || (isDriver && currentUser?.id === driverKey)}
          initialAdminNotes={getDriverPayrollRecord(driverKey)?.admin_notes || ''}
          initialDriverNotes={getDriverPayrollRecord(driverKey)?.driver_notes || ''}
          onSaveAdmin={(val) => savePayrollChanges(driverKey, { admin_notes: val })}
          onSaveDriver={(val) => savePayrollChanges(driverKey, { driver_notes: val })}
        />
      </div>
    </div>
  );
}