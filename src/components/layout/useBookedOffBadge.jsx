import { useState, useEffect, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { userHasRole } from '@/components/utils/userRoles';

/**
 * Hook that resolves the "booked off" scheduling badge count — the number of
 * upcoming booked-off time slots (this month, plus next month once fewer than
 * 7 days remain in the current month) that still need a driver assigned.
 *
 * Shared by AppSidebar (desktop) and MobileBottomNav (mobile Schedule tab icon)
 * so both badges stay in sync from a single WebSocket subscription + fetch.
 */
export function useBookedOffBadge(currentUser) {
  const [bookedOffOverrides, setBookedOffOverrides] = useState([]);

  useEffect(() => {
    if (!userHasRole(currentUser, 'admin') && !userHasRole(currentUser, 'driver')) return;
    base44.entities.DriverScheduleOverride.filter({ driver_id: '__booked_off__' }).
    then(setBookedOffOverrides).
    catch(() => {});

    const unsubscribe = base44.entities.DriverScheduleOverride.subscribe((event) => {
      if (event.type === 'delete') {
        setBookedOffOverrides((prev) => prev.filter((o) => o.id !== event.id));
      } else {
        const o = event.data;
        if (!o) return;
        setBookedOffOverrides((prev) => {
          if (o.driver_id === '__booked_off__') {
            const idx = prev.findIndex((x) => x.id === o.id);
            if (idx >= 0) return prev.map((x) => x.id === o.id ? { ...x, ...o } : x);
            return [...prev, o];
          } else {
            // driver accepted / reassigned — remove from booked-off list
            return prev.filter((x) => x.id !== o.id);
          }
        });
      }
    });
    return unsubscribe;
  }, [currentUser?.id]);

  const bookedOffCount = useMemo(() => {
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth();
    const daysLeft = new Date(year, month + 1, 0).getDate() - today.getDate();
    const includeNext = daysLeft < 7;

    return bookedOffOverrides.filter((o) => {
      if (!o.date) return false;
      const d = new Date(o.date + 'T00:00:00');
      if (d < today) return false;
      const sameMonth = d.getFullYear() === year && d.getMonth() === month;
      const nextMonth = d.getFullYear() === (month === 11 ? year + 1 : year) && d.getMonth() === (month + 1) % 12;
      return sameMonth || includeNext && nextMonth;
    }).length;
  }, [bookedOffOverrides]);

  return bookedOffCount;
}
