import { useState, useEffect } from 'react';
import { offlineDB } from '@/components/utils/offlineDatabase';
import { base44 } from '@/api/base44Client';
import { globalFilters } from '@/components/utils/globalFilters';
import { userHasRole } from '@/components/utils/userRoles';

/**
 * Hook that resolves the net_pay badge amount for the selected driver
 * based on the dashboard's selected date and the driver's pay cycle type.
 * Reads from offline DB first; falls back to API only on cache miss.
 */
export function usePayrollBadge(currentUser, appUsers, dataLoaded) {
  const [currentPayrollNetPay, setCurrentPayrollNetPay] = useState(null);

  useEffect(() => {
    if (!currentUser || !dataLoaded) return;

    const fetchPayroll = async () => {
      // Determine which driver to show payroll for
      const did = userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin')
        ? currentUser.id
        : (globalFilters.getSelectedDriverId() !== 'all' ? globalFilters.getSelectedDriverId() : null);

      if (!did) {
        setCurrentPayrollNetPay(null);
        return;
      }

      // Use the dashboard's selected date (not today) to find the correct pay period
      const selectedDate = globalFilters.getSelectedDate() || new Date().toISOString().slice(0, 10);

      try {
        // 1. Try offline DB first
        const allPayrolls = await offlineDB.getAll(offlineDB.STORES.PAYROLL);
        const driverPayrolls = (allPayrolls || []).filter(p => p && p.driver_id === did);

        const match = driverPayrolls.find(p =>
          p.pay_period_start <= selectedDate && p.pay_period_end >= selectedDate
        );

        if (match) {
          setCurrentPayrollNetPay(match.gross_pay ?? null);
          return;
        }

        // 2. Fallback: fetch from API, cache result in offline DB
        const ps = await base44.entities.Payroll.filter({ driver_id: did });
        if (ps && ps.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.PAYROLL, ps);
        }
        const c = (ps || []).find(p =>
          p.pay_period_start <= selectedDate && p.pay_period_end >= selectedDate
        );
        setCurrentPayrollNetPay(c ? (c.gross_pay ?? null) : null);
      } catch {
        setCurrentPayrollNetPay(null);
      }
    };

    fetchPayroll();
    window.addEventListener('globalFiltersChanged', fetchPayroll);
    return () => window.removeEventListener('globalFiltersChanged', fetchPayroll);
  }, [currentUser, dataLoaded, appUsers]);

  return currentPayrollNetPay;
}