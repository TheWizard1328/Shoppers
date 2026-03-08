import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { base44 } from '@/api/base44Client';
import { isAppOwner } from '../utils/userRoles';

// Helper: compute % from $ amount given total monthly app fees
function amountToPercent(amount, totalMonthlyAppFees) {
  return totalMonthlyAppFees > 0 ? amount / totalMonthlyAppFees * 100 : 0;
}

// App Owner Fee Manager (all drivers breakdown)
export function AppFeeAllDriversDialog({
  open, onClose, driversWithDeliveries, driverEdits, setDriverEdits,
  currentUser, otherAppFeePercent, setOtherAppFeePercent, sumAllDriversAppFeePercent,
  calculateAppFeeAmount, totalMonthlyAppFees, appFeesPerDelivery,
  extraAppFeePercent, getDriverPayrollRecord
}) {
  if (!open) return null;

  const handleSaveAndClose = async () => {
    try {
      for (const driver of driversWithDeliveries) {
        const rec = getDriverPayrollRecord(driver.driver.id);
        if (rec) await base44.entities.Payroll.update(rec.id, {
          app_fee_percentage: driverEdits[driver.driver.id]?.appFeePercent || 0,
          app_fee_amount: driverEdits[driver.driver.id]?.appFeeAmount || 0
        });
      }
      const settings = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
      if (settings?.[0]) await base44.entities.AppSettings.update(settings[0].id, {
        setting_value: { ...settings[0].setting_value, Extra_App_Fee_Percentage: extraAppFeePercent, Other_App_Fee_Percentage: otherAppFeePercent }
      });
      onClose();
    } catch (e) { console.error('Failed to save App Fee changes:', e); }
  };

  const handleDriverAmountChange = (driver, newAmount, isAppOwnerRow) => {
    const newPercent = amountToPercent(newAmount, totalMonthlyAppFees);
    setDriverEdits((prev) => ({ ...prev, [driver.driver.id]: { ...prev[driver.driver.id], appFeePercent: newPercent, appFeeAmount: newAmount } }));
    if (isAppOwnerRow) {
      const sumAll = driversWithDeliveries.reduce((s, d) => d.driver.id === driver.driver.id ? s + newPercent : s + (driverEdits[d.driver.id]?.appFeePercent || 0), 0);
      setOtherAppFeePercent(Math.round(Math.max(0, 100 - sumAll) * 100) / 100);
    } else {
      const sumNon = driversWithDeliveries.reduce((s, d) => d.driver.id === currentUser?.id ? s : d.driver.id === driver.driver.id ? s + newPercent : s + (driverEdits[d.driver.id]?.appFeePercent || 0), 0);
      const newOwnerPct = Math.max(0, 100 - sumNon - otherAppFeePercent);
      setDriverEdits((prev) => ({ ...prev, [currentUser.id]: { ...prev[currentUser.id], appFeePercent: newOwnerPct, appFeeAmount: calculateAppFeeAmount(currentUser.id, newOwnerPct) } }));
    }
  };

  const handleOtherAmountChange = (newAmount) => {
    const newPercent = amountToPercent(newAmount, totalMonthlyAppFees);
    setOtherAppFeePercent(newPercent);
    const sumNon = driversWithDeliveries.reduce((s, d) => d.driver.id === currentUser?.id ? s : s + (driverEdits[d.driver.id]?.appFeePercent || 0), 0);
    const newOwnerPct = Math.max(0, 100 - sumNon - newPercent);
    setDriverEdits((prev) => ({ ...prev, [currentUser.id]: { ...prev[currentUser.id], appFeePercent: newOwnerPct, appFeeAmount: calculateAppFeeAmount(currentUser.id, newOwnerPct) } }));
  };

  return (
    <Dialog open={true} onOpenChange={(o) => !o && onClose()}>
      <DialogContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
        <DialogHeader><DialogTitle style={{ color: 'var(--text-slate-900)' }}>Manage App Owner App Fee</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-slate-600">Configure app fees for operational costs.</p>
          <div className="mt-4">
            <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-slate-900)' }}>Driver App Fee Breakdown</h3>
            <div className="border rounded" style={{ borderColor: 'var(--border-slate-200)', maxHeight: '350px', overflowY: 'auto' }}>
              <table className="w-full text-xs border-collapse">
                <thead style={{ background: 'var(--bg-slate-100)', position: 'sticky', top: 0 }}>
                  <tr style={{ borderBottom: '1px solid var(--border-slate-200)' }}>
                    <th className="text-left px-2 py-1.5 font-semibold">Driver</th>
                    <th className="text-right px-2 py-1.5 font-semibold" style={{ width: '90px' }}>Fee %</th>
                    <th className="text-right px-2 py-1.5 font-semibold" style={{ width: '80px' }}>Fee $</th>
                  </tr>
                </thead>
                <tbody>
                  {driversWithDeliveries.map((driver, idx) => {
                    const pct = driverEdits[driver.driver.id]?.appFeePercent || 0;
                    const amt = driverEdits[driver.driver.id]?.appFeeAmount !== undefined ? driverEdits[driver.driver.id].appFeeAmount : calculateAppFeeAmount(driver.driver.id, pct);
                    const isCurrent = driver.driver.id === currentUser?.id;
                    const isOwnerRow = isCurrent && isAppOwner(currentUser);
                    return (
                      <tr key={driver.driver.id} style={{ borderBottom: '1px solid var(--border-slate-200)', background: isCurrent ? 'var(--bg-blue-50)' : idx % 2 === 0 ? 'var(--bg-slate-50)' : 'transparent' }}>
                        <td className="px-2 py-1.5 truncate text-left">
                          {driver.driver.user_name || driver.driver.full_name}
                          {isOwnerRow && <span className="text-xs font-semibold text-blue-600 ml-1">(App Owner)</span>}
                        </td>
                        <td className="text-right px-1 py-1.5"><span className="text-[11px] font-medium">{pct.toFixed(2)}%</span></td>
                        <td className="text-right px-1 py-1.5">
                          <input type="number" value={amt}
                            onChange={(e) => handleDriverAmountChange(driver, parseFloat(e.target.value) || 0, isOwnerRow)}
                            onBlur={(e) => setDriverEdits((prev) => ({ ...prev, [driver.driver.id]: { ...prev[driver.driver.id], appFeeAmount: Math.round((parseFloat(e.target.value) || 0) * 100) / 100 } }))}
                            className="w-full px-1 py-0.5 border rounded text-right text-xs no-spinner" step="any" min="0" />
                        </td>
                      </tr>);
                  })}
                  <tr style={{ background: 'var(--bg-slate-50)', borderBottom: '1px solid var(--border-slate-200)' }}>
                    <td className="px-2 py-1.5 text-left">Other App Fee</td>
                    <td className="text-right px-1 py-1.5"><span className="text-[11px] font-medium">{otherAppFeePercent.toFixed(2)}%</span></td>
                    <td className="text-right px-1 py-1.5">
                      <input type="number" value={calculateAppFeeAmount('other-app-fee', otherAppFeePercent).toFixed(2)}
                        onChange={(e) => handleOtherAmountChange(parseFloat(e.target.value) || 0)}
                        className="w-full px-1 py-0.5 border rounded text-right text-xs no-spinner" step="0.01" min="0" />
                    </td>
                  </tr>
                  <tr style={{ background: 'var(--bg-slate-100)', borderTop: '2px solid var(--border-slate-300)' }}>
                    <td className="px-2 py-1.5 font-semibold">App Owner (You)</td>
                    <td className="text-right px-1 py-1.5"><span className="text-[11px] font-semibold">{(driverEdits[currentUser?.id]?.appFeePercent || 0).toFixed(2)}%</span></td>
                    <td className="text-right px-1 py-1.5 font-semibold">${(driverEdits[currentUser?.id]?.appFeeAmount || calculateAppFeeAmount(currentUser?.id, driverEdits[currentUser?.id]?.appFeePercent || 0) || 0).toFixed(2)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div className="text-xs p-2 bg-slate-50 rounded mt-3">
            <div>Sum of Other Drivers: <strong>{sumAllDriversAppFeePercent.toFixed(2)}%</strong></div>
            <div>App Owner (You): <strong>{(driverEdits[currentUser?.id]?.appFeePercent || 0).toFixed(2)}%</strong></div>
            <div>Other App Fee: <strong>{otherAppFeePercent.toFixed(2)}%</strong></div>
            <div className="text-xs text-slate-500 mt-1 font-semibold">Total: {(sumAllDriversAppFeePercent + (driverEdits[currentUser?.id]?.appFeePercent || 0) + otherAppFeePercent).toFixed(2)}% / 100%</div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleSaveAndClose} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)' }}>Save & Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Single Driver App Fee Dialog
export function AppFeeSingleDriverDialog({
  open, driverId, onClose, driverEdits, setDriverEdits, payrollData,
  calculateAppFeeAmount, totalMonthlyAppFees, savePayrollChanges
}) {
  if (!open || !driverId || !driverEdits[driverId]) return null;
  const driverName = payrollData.find((d) => d.driver.id === driverId)?.driver.user_name;

  return (
    <Dialog open={true} onOpenChange={(o) => !o && onClose()}>
      <DialogContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
        <DialogHeader><DialogTitle style={{ color: 'var(--text-slate-900)' }}>Manage App Fee</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-slate-600">For {driverName}:</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold block mb-2" style={{ color: 'var(--text-slate-600)' }}>App Fee %</label>
              <div className="flex gap-1">
                <input type="number" value={driverEdits[driverId]?.appFeePercent || 0}
                  onChange={(e) => {
                    const pct = parseFloat(e.target.value) || 0;
                    setDriverEdits((prev) => ({ ...prev, [driverId]: { ...prev[driverId], appFeePercent: pct, appFeeAmount: calculateAppFeeAmount(driverId, pct) } }));
                  }}
                  placeholder="0" className="flex-1 px-2 py-1 text-sm border rounded" step="0.01" min="0" max="100" />
                <span className="flex items-center text-slate-500">%</span>
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold block mb-2" style={{ color: 'var(--text-slate-600)' }}>App Fee Amount</label>
              <div className="flex gap-1">
                <span className="flex items-center text-slate-500">$</span>
                <input type="number" value={driverEdits[driverId]?.appFeeAmount || 0}
                  onChange={(e) => {
                    const amt = parseFloat(e.target.value) || 0;
                    const pct = amountToPercent(amt, totalMonthlyAppFees);
                    setDriverEdits((prev) => ({ ...prev, [driverId]: { ...prev[driverId], appFeeAmount: amt, appFeePercent: pct } }));
                  }}
                  placeholder="0.00" className="flex-1 px-2 py-1 text-sm border rounded" step="0.01" min="0" />
              </div>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" data-dialog-close="appfee"
            onClick={() => {
              savePayrollChanges(driverId, { app_fee_percentage: driverEdits[driverId]?.appFeePercent || 0, app_fee_amount: driverEdits[driverId]?.appFeeAmount || 0 });
              onClose();
            }}
            style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)' }}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}