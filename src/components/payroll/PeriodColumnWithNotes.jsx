import React from "react";
import DriverNotesInline from "./DriverNotesInline";
import { isAppOwner } from "../utils/userRoles";

export default function PeriodColumnWithNotes({
  data,
  edit,
  isAdmin,
  isDriver,
  currentUser,
  driverKey,
  calculateAppFeeAmount,
  isPeriodEndOfMonth,
  setDeductionOverlayDriverId,
  setBonusOverlayDriverId,
  setAppFeeOverlayDriverId,
  getDriverPayrollRecord,
  savePayrollChanges,
}) {
  return (
    <div className="flex flex-col">
      <div className="font-bold text-center mb-1 pb-1 border-b" style={{ borderColor: 'var(--border-slate-300)' }}>Period</div>
      <table className="border-collapse">
        <tbody>
          <tr style={{ color: 'var(--text-slate-600)' }}>
            <td className="text-left pr-2">Gross:</td>
            <td className="text-right pr-0.5">$</td>
            <td className="text-right font-semibold" style={{ width: '60px' }}>{(data.grandTotal || 0).toFixed(2)}</td>
          </tr>
          <tr style={{ color: 'var(--text-slate-600)' }}>
            <td className="text-left pr-2">Tax:</td>
            <td className="text-right pr-0.5">$</td>
            <td className="text-right font-semibold" style={{ width: '60px' }}>{(data.taxAmount || 0).toFixed(2)}</td>
          </tr>
          <tr style={{ color: 'var(--text-slate-600)' }}>
            <td className="text-left pr-2">
              {isAdmin ? (
                <button onClick={() => setDeductionOverlayDriverId(data.driver.id)} className="text-blue-600 hover:text-blue-700 cursor-pointer font-medium">
                  Deductions:
                </button>
              ) : (
                'Deductions:'
              )}
            </td>
            <td className="text-right pr-0.5">-$</td>
            <td className="text-right font-semibold" style={{ width: '60px' }}>{(edit.deductions?.reduce((sum, d) => sum + (d?.amount || 0), 0) || 0).toFixed(2)}</td>
          </tr>
          <tr style={{ color: 'var(--text-slate-600)' }}>
            <td className="text-left pr-2">
              {isAdmin ? (
                <button onClick={() => setBonusOverlayDriverId(data.driver.id)} className="text-blue-600 hover:text-blue-700 cursor-pointer font-medium">
                  Bonus:
                </button>
              ) : (
                'Bonus:'
              )}
            </td>
            <td className="text-right pr-0.5">+$</td>
            <td className="text-right font-semibold" style={{ width: '60px' }}>{(edit.bonusPay || 0).toFixed(2)}</td>
          </tr>
          {isAdmin && isPeriodEndOfMonth && (isAppOwner(currentUser) || (edit.appFeePercent || 0) > 0) && (
            <tr style={{ color: 'var(--text-slate-600)' }} data-app-fee-row="true">
              <td className="text-left pr-2">
                <button onClick={() => setAppFeeOverlayDriverId(driverKey)} className="text-blue-600 hover:text-blue-700 cursor-pointer font-medium">
                  App Fee %:
                </button>
              </td>
              <td className="text-right pr-0.5">+$</td>
              <td className="text-right font-semibold" style={{ width: '60px' }}>{(edit.appFeeAmount || calculateAppFeeAmount(driverKey, edit.appFeePercent || 0)).toFixed(2)}</td>
            </tr>
          )}
          <tr style={{ borderTop: '1px solid var(--border-slate-300)' }}>
            <td colSpan="3" className="pt-1"></td>
          </tr>
          <tr className="text-lg font-bold text-emerald-600">
            <td className="text-left pr-2">Net:</td>
            <td className="text-right pr-0.5">$</td>
            <td className="text-right" style={{ width: '60px' }}>{(
              Math.round(data.grandTotal * 100) / 100 +
              Math.round(data.taxAmount * 100) / 100 +
              (edit.bonusPay || 0) -
              (edit.deductions?.reduce((sum, d) => sum + (d?.amount || 0), 0) || 0) +
              (edit.appFeeAmount || calculateAppFeeAmount(driverKey, edit.appFeePercent || 0))
            ).toFixed(2)}</td>
          </tr>
        </tbody>
      </table>

      {/* Desktop-only notes inline under Period column */}
      <div className="hidden" data-notes-desktop-left>
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