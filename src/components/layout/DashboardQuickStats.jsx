import React, { useState, useEffect, useRef } from "react";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Truck, Package, CheckCircle, AlertCircle } from "lucide-react";
import { globalFilters } from '../utils/globalFilters';
import { offlineDB } from '../utils/offlineDatabase';
import { userHasRole } from '../utils/userRoles';

export default function DashboardQuickStats({ currentUser, storeIds = [], isMobile, screenWidth }) {
  const [selectedDateStr, setSelectedDateStr] = useState(() => globalFilters.getSelectedDate());
  const [selectedDriverId, setSelectedDriverIdLocal] = useState(() => globalFilters.getSelectedDriverId());
  const [stats, setStats] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const lastFetchRef = useRef({ date: null, driver: null, timestamp: 0 });

  // Subscribe to global filter changes (not polling)
  useEffect(() => {
    const unsubscribe = globalFilters.subscribe(() => {
      const currentDateStr = globalFilters.getSelectedDate();
      const currentDriverId = globalFilters.getSelectedDriverId();

      if (currentDateStr !== selectedDateStr) {
        setSelectedDateStr(currentDateStr);
        // CRITICAL: Force immediate stats refresh on date change
        lastFetchRef.current = { date: null, driver: null, timestamp: 0 };
      }
      if (currentDriverId !== selectedDriverId) {
        setSelectedDriverIdLocal(currentDriverId);
        // CRITICAL: Force immediate stats refresh on driver change
        lastFetchRef.current = { date: null, driver: null, timestamp: 0 };
      }
    });

    return () => unsubscribe();
  }, [selectedDateStr, selectedDriverId]);

  // Load stats from offline DB
  useEffect(() => {
    if (!currentUser || !selectedDateStr) return;

    const loadStats = async () => {
      setIsLoading(true);
      setHasError(false);

      try {
        const selectedDate = new Date(selectedDateStr + 'T00:00:00');
        const todayStr = format(new Date(), 'yyyy-MM-dd');
        const monthStr = format(selectedDate, 'yyyy-MM');

        // Load deliveries from offline DB
        const allDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);

        if (!allDeliveries || allDeliveries.length === 0) {
          setStats(null);
          setIsLoading(false);
          return;
        }

        // Determine store filter for dispatcher
        const isDispatcher = userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin');
        const dispatcherStoreIds = isDispatcher ? new Set(currentUser.store_ids || []) : null;

        // Filter deliveries for today and month, scoped to dispatcher's stores if applicable
        const filterByStore = (d) => {if (!d) return false;if (dispatcherStoreIds) return dispatcherStoreIds.has(d.store_id);if (Array.isArray(storeIds) && storeIds.length > 0) return storeIds.includes(d.store_id);return true;};
        const todayDeliveries = allDeliveries.filter((d) => d?.delivery_date === selectedDateStr && filterByStore(d) && (selectedDriverId === 'all' || d?.driver_id === selectedDriverId) && (!(userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin')) || d?.driver_id === currentUser.id));
        const monthDeliveries = allDeliveries.filter((d) => d?.delivery_date?.startsWith(monthStr) && filterByStore(d) && (selectedDriverId === 'all' || d?.driver_id === selectedDriverId) && (!(userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin')) || d?.driver_id === currentUser.id));

        // Calculate today's stats
        const todayPatientDeliveries = todayDeliveries.filter((d) => d && d.patient_id);
        const allAppUsersFromDB = await offlineDB.getAll(offlineDB.STORES.APP_USERS);const offDutyIds = new Set((allAppUsersFromDB || []).filter((au) => au?.driver_status === 'off_duty').map((au) => au.user_id));const todayActiveDrivers = [...new Set(todayDeliveries.filter((d) => d?.driver_id).map((d) => d.driver_id))].filter((id) => !offDutyIds.has(id)).length;
        const todayActiveStops = todayPatientDeliveries.filter((d) => !['completed', 'failed', 'cancelled', 'returned'].includes(d?.status)).length;
        const todayCompleted = todayPatientDeliveries.filter((d) => d?.status === 'completed').length;
        const todayFailed = todayPatientDeliveries.filter((d) => d?.status === 'failed').length;
        const todayReturns = todayPatientDeliveries.filter((d) => {
          const notes = d?.delivery_notes || '';
          const patientName = d?.patient_name || '';
          const isReturn = d?.status === 'returned' || notes.toLowerCase().includes('(rtn)') || /\breturn\b/i.test(notes) || patientName.toLowerCase().includes('return');
          return isReturn && (d?.status === 'completed' || d?.status === 'returned');
        }).length;

        // Calculate month's stats
        const monthPatientDeliveries = monthDeliveries.filter((d) => d && d.patient_id);
        const monthCompleted = monthPatientDeliveries.filter((d) => d?.status === 'completed').length;
        const monthFailed = monthPatientDeliveries.filter((d) => d?.status === 'failed').length;
        const monthReturns = monthPatientDeliveries.filter((d) => {
          const notes = d?.delivery_notes || '';
          const patientName = d?.patient_name || '';
          const isReturn = d?.status === 'returned' || notes.toLowerCase().includes('(rtn)') || /\breturn\b/i.test(notes) || patientName.toLowerCase().includes('return');
          return isReturn && (d?.status === 'completed' || d?.status === 'returned');
        }).length;

        setStats({
          today: {
            activeDrivers: todayActiveDrivers,
            activeStops: todayActiveStops,
            completed: todayCompleted,
            failed: todayFailed,
            returns: todayReturns
          },
          month: {
            completed: monthCompleted,
            failed: monthFailed,
            returns: monthReturns
          }
        });
        setIsLoading(false);
      } catch (error) {
        console.error('Failed to load QuickStats:', error);
        setHasError(true);
        setIsLoading(false);
      }
    };

    loadStats();

    // Listen for delivery changes to refresh stats
    const handleDeliveryChange = () => {
      loadStats();
    };

    window.addEventListener('refreshDeliveryStats', handleDeliveryChange);
    window.addEventListener('deliveriesImported', handleDeliveryChange);
    window.addEventListener('offlineSyncComplete', handleDeliveryChange);

    return () => {
      window.removeEventListener('refreshDeliveryStats', handleDeliveryChange);
      window.removeEventListener('deliveriesImported', handleDeliveryChange);
      window.removeEventListener('offlineSyncComplete', handleDeliveryChange);
    };
  }, [currentUser, selectedDateStr, selectedDriverId]);

  const StatItem = ({ icon: Icon, label, value, colorClass }) =>
  <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-2">
          <Icon className={`w-4 h-4 ${colorClass || 'text-slate-500'}`} />
          <span className="font-medium" style={{ color: 'var(--text-slate-600)' }}>{label}</span>
        </div>
        <Badge variant="secondary" className="inline-flex border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-transparent hover:bg-secondary/80 justify-center w-[60px] rounded-[10px]" style={{ background: 'var(--bg-slate-100)', color: 'var(--text-slate-700)' }}>{value}</Badge>
      </div>;

  if (!currentUser) return null;

  const selectedDate = selectedDateStr ? new Date(selectedDateStr + 'T00:00:00') : new Date();
  const now = new Date();
  const todayString = format(now, 'yyyy-MM-dd');
  const isToday = format(selectedDate, 'yyyy-MM-dd') === todayString;

  // CRITICAL: Only show loading skeleton on FIRST load (no stats yet)
  // When stats exist, keep displaying them while updating
  if (isLoading && !stats) {
    return (
      <div className="px-3 py-2">
        <div className="animate-pulse space-y-2">
          <div className="h-4 bg-slate-200 rounded w-1/2"></div>
          <div className="h-6 bg-slate-200 rounded"></div>
          <div className="h-6 bg-slate-200 rounded"></div>
        </div>
      </div>);

  }

  if (hasError && !stats) {
    return (
      <div className="px-3 py-2 text-sm text-slate-500">
        Unable to load stats
      </div>);

  }

  // CRITICAL: Add null check for stats to prevent crashes
  if (!stats || !stats.today || !stats.month) {
    return null;
  }

  return (
    <div className="px-3 py-2 space-y-3">
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-slate-500)' }}>
          {isToday ? "Today's Stats:" : format(selectedDate, 'MMM dd, yyyy') + ':'}
        </h4>
        <div className="space-y-2">
          {!userHasRole(currentUser, 'driver') && <StatItem icon={Truck} label="Active Drivers" value={stats.today.activeDrivers} colorClass="text-blue-600" />}
          <StatItem icon={Package} label="Active Stops" value={stats.today.activeStops} colorClass="text-slate-600" />
          <StatItem icon={CheckCircle} label="Completed" value={stats.today.completed} colorClass="text-green-600" />
          {(stats.today.failed > 0 || stats.today.returns > 0) &&
          <StatItem
            icon={AlertCircle}
            label="Failed/Returned"
            value={`${stats.today.failed} / ${stats.today.returns}`}
            colorClass="text-red-600" />
          }
          {/* <StatItem icon={MapPin} label="Polylines" value={stats.today.polylineCount || 0} colorClass="text-blue-600" /> */}
        </div>
      </div>

      <div>
        <h4 className="xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-slate-500)' }}>{format(selectedDate, 'MMMM yyyy')}:</h4>
        <div className="space-y-2">
          <StatItem icon={CheckCircle} label="Completed" value={stats.month.completed} colorClass="text-green-600" />
          {(stats.month.failed > 0 || stats.month.returns > 0) &&
          <StatItem
            icon={AlertCircle}
            label="Failed/Returned"
            value={`${stats.month.failed} / ${stats.month.returns}`}
            colorClass="text-red-600" />
          }
        </div>
      </div>
    </div>);

}