import React, { useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, ChevronLeft, ChevronRight, Package, Ruler } from 'lucide-react';
import { format } from 'date-fns';

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
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3">
          {/* Pay Period Type Selector */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Table className="w-5 h-5" />
                {viewMode === 'deliveries' ? 'Deliveries' : 'Extra KM'} by Store
              </CardTitle>
              {/* View Mode Toggle */}
              <div className="flex gap-1 bg-slate-100 rounded-lg p-0.5">
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
            </div>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant={payPeriod === 'weekly' ? 'default' : 'outline'}
                onClick={() => onPayPeriodChange('weekly')}
                className="text-xs h-7 px-2"
              >
                Weekly
              </Button>
              <Button
                size="sm"
                variant={payPeriod === 'biweekly' ? 'default' : 'outline'}
                onClick={() => onPayPeriodChange('biweekly')}
                className="text-xs h-7 px-2"
              >
                Bi-Weekly
              </Button>
              <Button
                size="sm"
                variant={payPeriod === 'semimonthly' ? 'default' : 'outline'}
                onClick={() => onPayPeriodChange('semimonthly')}
                className="text-xs h-7 px-2"
              >
                Semi-Monthly
              </Button>
              <Button
                size="sm"
                variant={payPeriod === 'monthly' ? 'default' : 'outline'}
                onClick={() => onPayPeriodChange('monthly')}
                className="text-xs h-7 px-2"
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
              <div className="font-semibold text-slate-900">{currentPeriod.label}</div>
              <div className="text-xs text-slate-500">{periodDateRange}</div>
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
              <tr className="border-b bg-slate-50">
                <th className="text-left px-2 py-1 font-medium text-slate-600 sticky left-0 bg-slate-50 z-10">Day</th>
                {sortedStores.map((store) => (
                  <th
                    key={store.id}
                    className="text-center px-2 py-1 font-bold min-w-[40px]"
                    style={{ color: getStoreColor(store) }}
                    title={store.name}
                  >
                    {store.abbreviation || store.name?.substring(0, 2)}
                  </th>
                ))}
                <th className="text-center px-2 py-1 font-bold text-slate-900 border-l-2 border-purple-300 min-w-[50px]">Tot</th>
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
                    className={`border-b hover:bg-slate-50 ${isWeekend ? 'bg-slate-50' : ''}`}
                  >
                    <td
                      className={`px-2 py-0.5 font-medium sticky left-0 z-10 ${isWeekend ? 'bg-slate-50' : 'bg-white'}`}
                      style={{ color: '#475569' }}
                    >
                      {monthShort} {dayNum} <span className="text-slate-400 text-[9px]">{dayOfWeek}</span>
                    </td>
                    {sortedStores.map((store) => {
                      const value = dataMap[dateKey]?.[store.id] || 0;
                      return (
                        <td
                          key={store.id}
                          className="text-center px-2 py-0.5 tabular-nums"
                          style={{ color: value > 0 ? getStoreColor(store) : '#94a3b8' }}
                        >
                          {value > 0 ? value : ''}
                        </td>
                      );
                    })}
                    <td className="text-center px-2 py-0.5 font-semibold text-slate-900 border-l-2 border-purple-300 tabular-nums">
                      {dayTotal > 0 ? dayTotal : ''}
                    </td>
                  </tr>
                );
              })}
              {/* Totals Row */}
              <tr className="border-t-2 border-slate-300 bg-slate-100 font-semibold">
                <td className="px-2 py-1 text-slate-700 sticky left-0 bg-slate-100 z-10">Tot</td>
                {sortedStores.map((store) => (
                  <td
                    key={store.id}
                    className="text-center px-2 py-1 tabular-nums"
                    style={{ color: getStoreColor(store) }}
                  >
                    {storeTotals[store.id] > 0 ? storeTotals[store.id] : ''}
                  </td>
                ))}
                <td className="text-center px-2 py-1 font-bold text-slate-900 border-l-2 border-purple-300 tabular-nums">
                  {grandTotal}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}