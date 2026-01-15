import React, { useState, useMemo, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, ChevronLeft, ChevronRight, Package, Ruler, RefreshCw } from 'lucide-react';
import { format } from 'date-fns';
import { useAppData } from '@/components/utils/AppDataContext';
import { smartRefreshManager } from '@/components/utils/smartRefreshManager';

/**
 * Driver Payroll Grid
 * Shows deliveries per store per day for selected pay period
 */
export default function DriverPayrollGrid({ 
  deliveries, 
  stores, 
  patients,
  appUsers,
  selectedYear, 
  selectedDriverId,
  payPeriod,
  onPayPeriodChange,
  currentPeriod,
  allPeriods,
  selectedPeriodIndex,
  onPrevPeriod,
  onNextPeriod
}) {
  const [viewMode, setViewMode] = useState('deliveries'); // 'deliveries' or 'extraKm'
  const [isRefreshing, setIsRefreshing] = useState(false);
  const { smartRefreshActivity } = useAppData();

  // Track smart refresh activity - pulse animation when actively refreshing
  useEffect(() => {
    if (smartRefreshActivity?.active) {
      setIsRefreshing(true);
    } else {
      // Keep spinner visible briefly after refresh completes
      const timer = setTimeout(() => setIsRefreshing(false), 500);
      return () => clearTimeout(timer);
    }
  }, [smartRefreshActivity?.active]);

  // Manual refresh handler
  const handleManualRefresh = () => {
    if (isRefreshing) return;
    // Reset smart refresh timers to force immediate refresh
    smartRefreshManager.lastRefreshTimes = {
      driverLocation: 0,
      activeDeliveries: 0,
      todayDeliveries: 0,
      appUsers: 0,
      patients: 0,
      stores: 0
    };
    setIsRefreshing(true);
  };

  if (!deliveries || !stores || !currentPeriod) return null;

  // Generate days array from the current period's start to end date
  const getDaysInPeriod = () => {
    const days = [];
    const start = new Date(currentPeriod.start);
    const end = new Date(currentPeriod.end);
    let current = new Date(start);
    
    while (current <= end) {
      days.push(new Date(current));
      current.setDate(current.getDate() + 1);
    }
    return days;
  };
  
  const periodDays = getDaysInPeriod();

  // Sort stores by sort_order
  const sortedStores = [...stores].sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));

  // Filter deliveries for current period and driver
  // Exclude pickups (no patient_id) UNLESS it's an after_hours_pickup
  const filteredDeliveries = useMemo(() => deliveries.filter(d => {
    if (!d || !d.delivery_date) return false;
    const date = new Date(d.delivery_date + 'T00:00:00');
    if (date < currentPeriod.start || date > currentPeriod.end) return false;
    // Count completed, failed, and cancelled (for after_hours_pickup)
    const validStatus = d.status === 'completed' || d.status === 'failed' || (d.status === 'cancelled' && d.after_hours_pickup);
    if (!validStatus) return false;
    if (selectedDriverId && selectedDriverId !== 'all' && d.driver_id !== selectedDriverId) return false;
    // Exclude pickups (no patient_id) unless it's an after_hours_pickup
    if (!d.patient_id && !d.after_hours_pickup) return false;
    return true;
  }), [deliveries, currentPeriod, selectedDriverId]);

  // Get extra km limit for a driver
  const getDriverExtraKmLimit = (driverId) => {
    const driverAppUser = appUsers?.find(au => au.user_id === driverId);
    return driverAppUser?.extra_km_limit || 0;
  };

  // Calculate extra km for a delivery
  const calculateExtraKm = (delivery) => {
    if (!delivery) return 0;
    
    // Use paid_km_override if set, otherwise get distance_from_store from patient
    let distance = delivery.paid_km_override;
    if (distance === undefined || distance === null) {
      const patient = patients?.find(p => p.id === delivery.patient_id);
      distance = patient?.distance_from_store || 0;
    }
    
    const extraKmLimit = getDriverExtraKmLimit(delivery.driver_id);
    const extraKm = distance - extraKmLimit;
    return extraKm > 0 ? extraKm : 0;
  };

  // Build a map of dateKey -> store -> count (deliveries) and extraKm
  const { dataMap, extraKmMap } = useMemo(() => {
    const deliveryMap = {};
    const kmMap = {};
    
    periodDays.forEach(day => {
      const dateKey = format(day, 'yyyy-MM-dd');
      deliveryMap[dateKey] = {};
      kmMap[dateKey] = {};
      sortedStores.forEach(store => {
        deliveryMap[dateKey][store.id] = 0;
        kmMap[dateKey][store.id] = 0;
      });
    });

    filteredDeliveries.forEach(d => {
      const dateKey = d.delivery_date;
      const storeId = d.store_id;
      if (deliveryMap[dateKey] && deliveryMap[dateKey][storeId] !== undefined) {
        deliveryMap[dateKey][storeId]++;
        kmMap[dateKey][storeId] += calculateExtraKm(d);
      }
    });

    return { dataMap: deliveryMap, extraKmMap: kmMap };
  }, [filteredDeliveries, periodDays, sortedStores, patients, appUsers]);

  // Calculate store totals (column totals)
  const { storeTotals, storeKmTotals } = useMemo(() => {
    const totals = {};
    const kmTotals = {};
    sortedStores.forEach(store => {
      totals[store.id] = 0;
      kmTotals[store.id] = 0;
    });
    periodDays.forEach(day => {
      const dateKey = format(day, 'yyyy-MM-dd');
      sortedStores.forEach(store => {
        totals[store.id] += dataMap[dateKey]?.[store.id] || 0;
        kmTotals[store.id] += extraKmMap[dateKey]?.[store.id] || 0;
      });
    });
    return { storeTotals: totals, storeKmTotals: kmTotals };
  }, [dataMap, extraKmMap, periodDays, sortedStores]);

  // Calculate day totals (row totals)
  const getDayTotal = (dateKey) => {
    if (viewMode === 'extraKm') {
      return sortedStores.reduce((sum, store) => sum + (extraKmMap[dateKey]?.[store.id] || 0), 0);
    }
    return sortedStores.reduce((sum, store) => sum + (dataMap[dateKey]?.[store.id] || 0), 0);
  };

  // Grand total
  const grandTotal = viewMode === 'extraKm' 
    ? Object.values(storeKmTotals).reduce((sum, val) => sum + val, 0)
    : Object.values(storeTotals).reduce((sum, val) => sum + val, 0);

  // Get store color
  const getStoreColor = (store) => store.color || '#64748b';

  // Format period date range for header
  const periodDateRange = `${format(currentPeriod.start, 'MMM d')} - ${format(currentPeriod.end, 'MMM d, yyyy')}`;

  return (
    <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-2">
          {/* Desktop: Single row layout */}
          <div className="hidden md:flex items-center justify-between">
            {/* Section 1: Title with refresh spinner */}
            <CardTitle className="flex items-center gap-2 text-base" style={{ color: 'var(--text-slate-900)' }}>
              <Table className="w-5 h-5" />
              {viewMode === 'deliveries' ? 'Deliveries' : 'Extra KM'} by Store
              <button
                onClick={handleManualRefresh}
                disabled={isRefreshing}
                className="p-1 rounded-md hover:bg-slate-100 transition-colors disabled:opacity-50"
                title="Refresh data"
              >
                <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-emerald-500' : 'text-slate-400 hover:text-slate-600'}`} />
              </button>
            </CardTitle>
            
            {/* Section 2: View Mode Toggle */}
            <div className="flex gap-1 rounded-lg p-0.5" style={{ background: 'var(--bg-slate-100)' }}>
              <Button
                size="sm"
                variant={viewMode === 'deliveries' ? 'default' : 'ghost'}
                onClick={() => setViewMode('deliveries')}
                className="text-xs h-6 px-2 gap-1"
              >
                <Package className="w-3 h-3" />
                Deliveries
              </Button>
              <Button
                size="sm"
                variant={viewMode === 'extraKm' ? 'default' : 'ghost'}
                onClick={() => setViewMode('extraKm')}
                className="text-xs h-6 px-2 gap-1"
              >
                <Ruler className="w-3 h-3" />
                Extra KM
              </Button>
            </div>
            
            {/* Section 3: Pay Period Type Buttons */}
            <div className="flex gap-1">
              <Button
                size="sm"
                variant={payPeriod === 'weekly' ? 'default' : 'outline'}
                onClick={() => onPayPeriodChange('weekly')}
                className="text-xs h-7 px-2"
                style={payPeriod !== 'weekly' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}
              >
                Weekly
              </Button>
              <Button
                size="sm"
                variant={payPeriod === 'biweekly' ? 'default' : 'outline'}
                onClick={() => onPayPeriodChange('biweekly')}
                className="text-xs h-7 px-2"
                style={payPeriod !== 'biweekly' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}
              >
                Bi-Weekly
              </Button>
              <Button
                size="sm"
                variant={payPeriod === 'semimonthly' ? 'default' : 'outline'}
                onClick={() => onPayPeriodChange('semimonthly')}
                className="text-xs h-7 px-2"
                style={payPeriod !== 'semimonthly' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}
              >
                Semi-Monthly
              </Button>
              <Button
                size="sm"
                variant={payPeriod === 'monthly' ? 'default' : 'outline'}
                onClick={() => onPayPeriodChange('monthly')}
                className="text-xs h-7 px-2"
                style={payPeriod !== 'monthly' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}
              >
                Monthly
              </Button>
            </div>
          </div>
          
          {/* Mobile: 3 rows layout */}
          <div className="md:hidden flex flex-col gap-2">
            {/* Row 1: Title with refresh spinner */}
            <CardTitle className="flex items-center gap-2 text-base" style={{ color: 'var(--text-slate-900)' }}>
              <Table className="w-5 h-5" />
              {viewMode === 'deliveries' ? 'Deliveries' : 'Extra KM'} by Store
              <button
                onClick={handleManualRefresh}
                disabled={isRefreshing}
                className="p-1 rounded-md hover:bg-slate-100 transition-colors disabled:opacity-50"
                title="Refresh data"
              >
                <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-emerald-500' : 'text-slate-400 hover:text-slate-600'}`} />
              </button>
            </CardTitle>
            
            {/* Row 2: View Mode Toggle */}
            <div className="flex gap-1 rounded-lg p-0.5 self-start" style={{ background: 'var(--bg-slate-100)' }}>
              <Button
                size="sm"
                variant={viewMode === 'deliveries' ? 'default' : 'ghost'}
                onClick={() => setViewMode('deliveries')}
                className="text-xs h-6 px-2 gap-1"
              >
                <Package className="w-3 h-3" />
                Deliveries
              </Button>
              <Button
                size="sm"
                variant={viewMode === 'extraKm' ? 'default' : 'ghost'}
                onClick={() => setViewMode('extraKm')}
                className="text-xs h-6 px-2 gap-1"
              >
                <Ruler className="w-3 h-3" />
                Extra KM
              </Button>
            </div>
            
            {/* Row 3: Pay Period Type Buttons */}
            <div className="flex gap-1 flex-wrap">
              <Button
                size="sm"
                variant={payPeriod === 'weekly' ? 'default' : 'outline'}
                onClick={() => onPayPeriodChange('weekly')}
                className="text-xs h-7 px-2"
                style={payPeriod !== 'weekly' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}
              >
                Weekly
              </Button>
              <Button
                size="sm"
                variant={payPeriod === 'biweekly' ? 'default' : 'outline'}
                onClick={() => onPayPeriodChange('biweekly')}
                className="text-xs h-7 px-2"
                style={payPeriod !== 'biweekly' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}
              >
                Bi-Wkly
              </Button>
              <Button
                size="sm"
                variant={payPeriod === 'semimonthly' ? 'default' : 'outline'}
                onClick={() => onPayPeriodChange('semimonthly')}
                className="text-xs h-7 px-2"
                style={payPeriod !== 'semimonthly' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}
              >
                Semi-Mo
              </Button>
              <Button
                size="sm"
                variant={payPeriod === 'monthly' ? 'default' : 'outline'}
                onClick={() => onPayPeriodChange('monthly')}
                className="text-xs h-7 px-2"
                style={payPeriod !== 'monthly' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}
              >
                Monthly
              </Button>
            </div>
          </div>
          
          {/* Period Navigation */}
          <div className="flex items-center justify-center gap-3">
            <Button
              size="sm"
              variant="ghost"
              onClick={onPrevPeriod}
              disabled={selectedPeriodIndex === 0}
              className="h-8 w-8 p-0"
            >
              <ChevronLeft className="w-5 h-5" />
            </Button>
            <div className="text-center min-w-[200px]">
              <div className="font-semibold" style={{ color: 'var(--text-slate-900)' }}>{currentPeriod.label}</div>
              <div className="text-xs" style={{ color: 'var(--text-slate-500)' }}>{periodDateRange}</div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={onNextPeriod}
              disabled={selectedPeriodIndex === allPeriods.length - 1}
              className="h-8 w-8 p-0"
            >
              <ChevronRight className="w-5 h-5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-slate-200)', background: 'var(--bg-slate-50)' }}>
                <th className="text-left px-1 md:px-2 py-1 font-medium sticky left-0 z-10" style={{ color: 'var(--text-slate-600)', background: 'var(--bg-slate-50)' }}>Day</th>
                {sortedStores.map((store) => (
                  <th
                    key={store.id}
                    className="text-center px-1 md:px-2 py-1 font-bold min-w-[28px] md:min-w-[40px]"
                    style={{ color: getStoreColor(store) }}
                    title={store.name}
                  >
                    {store.abbreviation || store.name?.substring(0, 2)}
                  </th>
                ))}
                <th className="text-center px-1 md:px-2 py-1 font-bold border-l-2 border-purple-300 min-w-[36px] md:min-w-[50px]" style={{ color: 'var(--text-slate-900)' }}>Tot</th>
              </tr>
            </thead>
            <tbody>
              {periodDays.map((dateObj) => {
                const dateKey = format(dateObj, 'yyyy-MM-dd');
                const dayTotal = getDayTotal(dateKey);
                const dayNum = dateObj.getDate();
                const dayOfWeek = dateObj.toLocaleDateString('en-US', { weekday: 'short' });
                const monthShort = dateObj.toLocaleDateString('en-US', { month: 'short' });
                const isWeekend = dateObj.getDay() === 0 || dateObj.getDay() === 6;
                
                return (
                  <tr 
                    key={dateKey} 
                    style={{ borderBottom: '1px solid var(--border-slate-200)', background: isWeekend ? 'var(--bg-slate-100)' : 'transparent' }}
                  >
                    <td
                      className="px-1 md:px-2 py-0.5 font-medium sticky left-0 z-10"
                      style={{ color: 'var(--text-slate-600)', background: isWeekend ? 'var(--bg-slate-100)' : 'var(--bg-white)' }}
                    >
                      <span className="md:hidden">{dayNum}</span>
                      <span className="hidden md:inline">{monthShort} {dayNum} <span className="text-[9px]" style={{ color: 'var(--text-slate-400)' }}>{dayOfWeek}</span></span>
                    </td>
                    {sortedStores.map((store) => {
                      const value = viewMode === 'extraKm' 
                        ? (extraKmMap[dateKey]?.[store.id] || 0)
                        : (dataMap[dateKey]?.[store.id] || 0);
                      const displayValueMobile = viewMode === 'extraKm' 
                        ? (value > 0 ? value.toFixed(1) : '')
                        : (value > 0 ? value : '');
                      const displayValueDesktop = viewMode === 'extraKm' 
                        ? (value > 0 ? value.toFixed(2) : '')
                        : (value > 0 ? value : '');
                      return (
                        <td
                          key={store.id}
                          className="text-center px-1 md:px-2 py-0.5 tabular-nums"
                          style={{ color: value > 0 ? getStoreColor(store) : 'var(--text-slate-400)' }}
                        >
                          <span className="md:hidden">{displayValueMobile}</span>
                          <span className="hidden md:inline">{displayValueDesktop}</span>
                        </td>
                      );
                    })}
                    <td className="text-center px-1 md:px-2 py-0.5 font-semibold border-l-2 border-purple-300 tabular-nums" style={{ color: 'var(--text-slate-900)' }}>
                      <span className="md:hidden">{viewMode === 'extraKm' ? (dayTotal > 0 ? dayTotal.toFixed(1) : '') : (dayTotal > 0 ? dayTotal : '')}</span>
                      <span className="hidden md:inline">{viewMode === 'extraKm' ? (dayTotal > 0 ? dayTotal.toFixed(2) : '') : (dayTotal > 0 ? dayTotal : '')}</span>
                    </td>
                  </tr>
                );
              })}
              {/* Totals Row */}
              <tr className="font-semibold" style={{ borderTop: '2px solid var(--border-slate-300)', background: 'var(--bg-slate-100)' }}>
                <td className="px-1 md:px-2 py-1 sticky left-0 z-10" style={{ color: 'var(--text-slate-700)', background: 'var(--bg-slate-100)' }}>Tot</td>
                {sortedStores.map((store) => {
                  const value = viewMode === 'extraKm' ? storeKmTotals[store.id] : storeTotals[store.id];
                  const displayValueMobile = viewMode === 'extraKm' 
                    ? (value > 0 ? value.toFixed(1) : '')
                    : (value > 0 ? value : '');
                  const displayValueDesktop = viewMode === 'extraKm' 
                    ? (value > 0 ? value.toFixed(2) : '')
                    : (value > 0 ? value : '');
                  return (
                    <td
                      key={store.id}
                      className="text-center px-1 md:px-2 py-1 tabular-nums"
                      style={{ color: getStoreColor(store) }}
                    >
                      <span className="md:hidden">{displayValueMobile}</span>
                      <span className="hidden md:inline">{displayValueDesktop}</span>
                    </td>
                  );
                })}
                <td className="text-center px-1 md:px-2 py-1 font-bold border-l-2 border-purple-300 tabular-nums" style={{ color: 'var(--text-slate-900)' }}>
                  <span className="md:hidden">{viewMode === 'extraKm' ? grandTotal.toFixed(1) : grandTotal}</span>
                  <span className="hidden md:inline">{viewMode === 'extraKm' ? grandTotal.toFixed(2) : grandTotal}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}