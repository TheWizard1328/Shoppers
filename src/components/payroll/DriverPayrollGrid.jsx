import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, ChevronLeft, ChevronRight, Package, Ruler, RefreshCw, ExternalLink } from 'lucide-react';
import { format } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { useAppData } from '@/components/utils/AppDataContext';
import { smartRefreshManager } from '@/components/utils/smartRefreshManager';
import { globalFilters } from '@/components/utils/globalFilters';
import { createPageUrl } from '../../utils';
import { useUser } from '@/components/utils/UserContext';
import { isAppOwner } from '@/components/utils/userRoles';

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
  const [headerLayout, setHeaderLayout] = useState('single'); // 'single', 'title-viewmode', 'title-paycycle', 'viewmode-paycycle', 'three'
  const { smartRefreshActivity } = useAppData();
  const navigate = useNavigate();
  const { currentUser } = useUser();
  const isOwner = currentUser && isAppOwner(currentUser);
  
  // Refs for measuring section widths
  const containerRef = useRef(null);
  const titleRef = useRef(null);
  const viewModeRef = useRef(null);
  const payCycleRef = useRef(null);
  
  // Calculate optimal layout based on container width
  const calculateLayout = useCallback(() => {
    if (!containerRef.current || !titleRef.current || !viewModeRef.current || !payCycleRef.current) return;
    
    const containerWidth = containerRef.current.offsetWidth;
    const titleWidth = titleRef.current.offsetWidth;
    const viewModeWidth = viewModeRef.current.offsetWidth;
    const payCycleWidth = payCycleRef.current.offsetWidth;
    const gap = 12; // gap-3 = 12px
    
    // Check if all three fit on one row
    if (titleWidth + viewModeWidth + payCycleWidth + gap * 2 <= containerWidth) {
      setHeaderLayout('single');
      return;
    }
    
    // Check if title + viewMode fit (payCycle goes to row 2)
    if (titleWidth + viewModeWidth + gap <= containerWidth) {
      setHeaderLayout('title-viewmode');
      return;
    }
    
    // Check if title + payCycle fit (viewMode goes to row 2)
    if (titleWidth + payCycleWidth + gap <= containerWidth) {
      setHeaderLayout('title-paycycle');
      return;
    }
    
    // Check if viewMode + payCycle fit together (both go to row 2)
    if (viewModeWidth + payCycleWidth + gap <= containerWidth) {
      setHeaderLayout('viewmode-paycycle');
      return;
    }
    
    // All three on separate rows
    setHeaderLayout('three');
  }, []);
  
  // Measure and recalculate on mount and resize
  useEffect(() => {
    calculateLayout();
    
    const resizeObserver = new ResizeObserver(() => {
      calculateLayout();
    });
    
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }
    
    return () => resizeObserver.disconnect();
  }, [calculateLayout]);

  // Navigate to dashboard with selected date and driver
  const handleNavigateToDashboard = (dateObj) => {
    // Format date as string for both globalFilters and URL
    const dateStr = format(dateObj, 'yyyy-MM-dd');
    
    // Set global filters for the dashboard
    globalFilters.setSelectedDate(dateStr);
    if (selectedDriverId && selectedDriverId !== 'all') {
      globalFilters.setSelectedDriverId(selectedDriverId);
    } else {
      globalFilters.setSelectedDriverId('all');
    }
    
    // Navigate with date in URL as backup to ensure it's applied
    const url = createPageUrl('Dashboard') + `?date=${dateStr}`;
    navigate(url);
  };

  // Track smart refresh activity - pulse animation when actively refreshing
  useEffect(() => {
    // Only show spinner if we're on this page (DriverPayroll)
    if (smartRefreshActivity?.active) {
      setIsRefreshing(true);
    } else {
      setIsRefreshing(false);
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

  // Generate days array from the current period's start to end date
  const periodDays = useMemo(() => {
     if (!currentPeriod) return [];
     const days = [];
     const start = new Date(currentPeriod.start);
     const end = new Date(currentPeriod.end);
     let current = new Date(start);

     while (current <= end) {
       days.push(new Date(current));
       current.setDate(current.getDate() + 1);
     }
     return days;
   }, [currentPeriod]);

  // Sort stores by sort_order
  const allSortedStores = [...stores].sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));

  // Get drivers with matching pay cycle
  const driversWithMatchingPayCycle = useMemo(() => {
    if (!appUsers || !payPeriod) return [];

    const payCycleMap = {
      'weekly': 'weekly',
      'biweekly': 'biweekly',
      'semimonthly': 'semimonthly',
      'monthly': 'monthly'
    };

    const targetCycle = payCycleMap[payPeriod];
    const matching = appUsers.filter(au => au?.pay_cycle_type === targetCycle);

    console.log(`🔄 [PayCycle Filter] Pay period: ${payPeriod}, Drivers with matching cycle: ${matching.length}`);

    return matching.map(au => au.user_id).filter(Boolean);
  }, [appUsers, payPeriod]);

  // Filter deliveries for current period and driver
  // Exclude pickups (no patient_id) UNLESS it's an after_hours_pickup
  const filteredDeliveries = useMemo(() => {
    if (!deliveries || !currentPeriod) {
      console.log(`⚠️ [Payroll Grid Filter] Missing data - deliveries: ${!!deliveries}, currentPeriod: ${!!currentPeriod}`);
      return [];
    }

    console.log(`🔍 [Payroll Grid Filter] Input - Total deliveries: ${deliveries.length}, Period: ${currentPeriod.label}, Driver: ${selectedDriverId}`);

    // Debug: Show unique driver IDs in the deliveries
    const uniqueDriverIds = [...new Set(deliveries.map(d => d.driver_id).filter(Boolean))];
    console.log(`   Available driver IDs in data:`, uniqueDriverIds);
    console.log(`   Looking for driver ID: "${selectedDriverId}"`);
    console.log(`   Match exists: ${uniqueDriverIds.includes(selectedDriverId)}`);

    const filtered = deliveries.filter(d => {
      if (!d || !d.delivery_date) return false;
      const date = new Date(d.delivery_date + 'T00:00:00');
      if (date < currentPeriod.start || date > currentPeriod.end) return false;
      // Count completed, failed, and cancelled (for after_hours_pickup)
      const validStatus = d.status === 'completed' || d.status === 'failed' || (d.status === 'cancelled' && d.after_hours_pickup);
      if (!validStatus) return false;

      // CRITICAL: Filter by drivers with matching pay cycle
      if (!driversWithMatchingPayCycle.includes(d.driver_id)) return false;

      // CRITICAL: Only filter by driver if selectedDriverId is set AND not 'all'
      if (selectedDriverId && selectedDriverId !== 'all') {
        if (d.driver_id !== selectedDriverId) return false;
      }

      // Exclude pickups (no patient_id) unless it's an after_hours_pickup
      if (!d.patient_id && !d.after_hours_pickup) return false;
      return true;
    });

    console.log(`✅ [Payroll Grid Filter] Filtered to ${filtered.length} deliveries`);
    if (filtered.length > 0) {
      console.log(`   Sample delivery:`, filtered[0]);
    }

    return filtered;
  }, [deliveries, currentPeriod, selectedDriverId, driversWithMatchingPayCycle]);

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

  // Build a map of dateKey -> store -> count (deliveries), extraKm, and oversized count
  const { dataMap, extraKmMap, oversizedMap, storesWithData } = useMemo(() => {
    const deliveryMap = {};
    const kmMap = {};
    const oversizedCountMap = {};
    const storeHasData = {};
    
    console.log(`🔍 [Payroll Grid] Building data map for driver: ${selectedDriverId}`);
    console.log(`   - Period: ${currentPeriod?.label}`);
    console.log(`   - Filtered deliveries count: ${filteredDeliveries.length}`);
    console.log(`   - All stores count: ${allSortedStores.length}`);
    
    periodDays.forEach(day => {
      const dateKey = format(day, 'yyyy-MM-dd');
      deliveryMap[dateKey] = {};
      kmMap[dateKey] = {};
      oversizedCountMap[dateKey] = {};
      allSortedStores.forEach(store => {
        deliveryMap[dateKey][store.id] = 0;
        kmMap[dateKey][store.id] = 0;
        oversizedCountMap[dateKey][store.id] = 0;
      });
    });

    filteredDeliveries.forEach(d => {
      const dateKey = d.delivery_date;
      const storeId = d.store_id;
      if (deliveryMap[dateKey] && deliveryMap[dateKey][storeId] !== undefined) {
        deliveryMap[dateKey][storeId]++;
        kmMap[dateKey][storeId] += calculateExtraKm(d);
        storeHasData[storeId] = true;
        if (d.oversized) {
          oversizedCountMap[dateKey][storeId]++;
        }
      }
    });

    // Filter out inactive stores only
    const storesWithDataList = allSortedStores.filter(store => 
      store.status !== 'inactive'
    );

    console.log(`   - Stores with data: ${Object.keys(storeHasData).length}`);
    console.log(`   - Showing stores: ${storesWithDataList.length}`);

    return { dataMap: deliveryMap, extraKmMap: kmMap, oversizedMap: oversizedCountMap, storesWithData: storesWithDataList };
  }, [filteredDeliveries, periodDays, allSortedStores, patients, appUsers, selectedDriverId, currentPeriod]);

  // Use stores with data for display (hide empty columns)
  const sortedStores = storesWithData.length > 0 ? storesWithData : allSortedStores;

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
        <div className="flex flex-col gap-2" ref={containerRef}>
          {/* Hidden measurement elements */}
          <div className="absolute opacity-0 pointer-events-none flex gap-3" style={{ visibility: 'hidden' }}>
            <div ref={titleRef} className="flex items-center gap-2 text-base flex-shrink-0">
              <Table className="w-5 h-5" />
              {viewMode === 'deliveries' ? 'Deliveries' : 'Extra KM'} by Store
              <span className="p-1"><RefreshCw className="w-4 h-4" /></span>
            </div>
            <div ref={viewModeRef} className="flex gap-1 rounded-lg p-0.5">
              <span className="text-xs h-6 px-2">Deliveries</span>
              <span className="text-xs h-6 px-2">Extra KM</span>
            </div>
            <div ref={payCycleRef} className="flex gap-1">
              <span className="text-xs h-7 px-2">Weekly</span>
              <span className="text-xs h-7 px-2">Bi-Weekly</span>
              <span className="text-xs h-7 px-2">Semi-Monthly</span>
              <span className="text-xs h-7 px-2">Monthly</span>
            </div>
          </div>
          
          {/* Dynamic layout based on calculated layout mode */}
          {headerLayout === 'single' && (
            <div className="flex flex-col lg:flex-row items-center justify-center lg:justify-between gap-3">
              {/* Title */}
              <CardTitle className="flex items-center gap-2 text-base flex-shrink-0" style={{ color: 'var(--text-slate-900)' }}>
                <Table className="w-5 h-5" />
                {viewMode === 'deliveries' ? 'Deliveries' : 'Extra KM'} by Store
                <button onClick={handleManualRefresh} disabled={isRefreshing} className="p-1 rounded-md hover:bg-slate-100 transition-colors disabled:opacity-50" title="Refresh data">
                  <RefreshCw className={`w-4 h-4 transition-colors ${isRefreshing ? 'animate-spin text-emerald-500' : 'text-slate-400 hover:text-slate-600'}`} />
                </button>
              </CardTitle>
              {/* Pay Cycle Buttons - AppOwner only */}
              {isOwner && (
                <div className="flex gap-1 flex-shrink-0">
                  {/* Note: All cycles shown - parent page filters drivers by cycle */}
                  <Button size="sm" variant={payPeriod === 'weekly' ? 'default' : 'outline'} onClick={() => onPayPeriodChange('weekly')} className="text-xs h-7 px-2" style={payPeriod !== 'weekly' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}>Weekly</Button>
                  <Button size="sm" variant={payPeriod === 'biweekly' ? 'default' : 'outline'} onClick={() => onPayPeriodChange('biweekly')} className="text-xs h-7 px-2" style={payPeriod !== 'biweekly' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}>Bi-Weekly</Button>
                  <Button size="sm" variant={payPeriod === 'semimonthly' ? 'default' : 'outline'} onClick={() => onPayPeriodChange('semimonthly')} className="text-xs h-7 px-2" style={payPeriod !== 'semimonthly' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}>Semi-Monthly</Button>
                  <Button size="sm" variant={payPeriod === 'monthly' ? 'default' : 'outline'} onClick={() => onPayPeriodChange('monthly')} className="text-xs h-7 px-2" style={payPeriod !== 'monthly' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}>Monthly</Button>
                </div>
              )}
            </div>
          )}
          
          {headerLayout === 'title-viewmode' && (
            <>
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="flex items-center gap-2 text-base flex-shrink-0" style={{ color: 'var(--text-slate-900)' }}>
                  <Table className="w-5 h-5" />
                  {viewMode === 'deliveries' ? 'Deliveries' : 'Extra KM'} by Store
                  <button onClick={handleManualRefresh} disabled={isRefreshing} className="p-1 rounded-md hover:bg-slate-100 transition-colors disabled:opacity-50" title="Refresh data">
                    <RefreshCw className={`w-4 h-4 transition-colors ${isRefreshing ? 'animate-spin text-emerald-500' : 'text-slate-400 hover:text-slate-600'}`} />
                  </button>
                </CardTitle>
              </div>
              {isOwner && (
                <div className="flex justify-center">
                  <div className="flex gap-1 flex-shrink-0">
                    <Button size="sm" variant={payPeriod === 'weekly' ? 'default' : 'outline'} onClick={() => onPayPeriodChange('weekly')} className="text-xs h-7 px-2" style={payPeriod !== 'weekly' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}>Weekly</Button>
                    <Button size="sm" variant={payPeriod === 'biweekly' ? 'default' : 'outline'} onClick={() => onPayPeriodChange('biweekly')} className="text-xs h-7 px-2" style={payPeriod !== 'biweekly' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}>Bi-Weekly</Button>
                    <Button size="sm" variant={payPeriod === 'semimonthly' ? 'default' : 'outline'} onClick={() => onPayPeriodChange('semimonthly')} className="text-xs h-7 px-2" style={payPeriod !== 'semimonthly' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}>Semi-Monthly</Button>
                    <Button size="sm" variant={payPeriod === 'monthly' ? 'default' : 'outline'} onClick={() => onPayPeriodChange('monthly')} className="text-xs h-7 px-2" style={payPeriod !== 'monthly' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}>Monthly</Button>
                  </div>
                </div>
              )}
            </>
          )}
          
          {headerLayout === 'title-paycycle' && (
            <>
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="flex items-center gap-2 text-base flex-shrink-0" style={{ color: 'var(--text-slate-900)' }}>
                  <Table className="w-5 h-5" />
                  {viewMode === 'deliveries' ? 'Deliveries' : 'Extra KM'} by Store
                  <button onClick={handleManualRefresh} disabled={isRefreshing} className="p-1 rounded-md hover:bg-slate-100 transition-colors disabled:opacity-50" title="Refresh data">
                    <RefreshCw className={`w-4 h-4 transition-colors ${isRefreshing ? 'animate-spin text-emerald-500' : 'text-slate-400 hover:text-slate-600'}`} />
                  </button>
                </CardTitle>
                <div className="flex gap-1 flex-shrink-0">
                  <Button size="sm" variant={payPeriod === 'weekly' ? 'default' : 'outline'} onClick={() => onPayPeriodChange('weekly')} className="text-xs h-7 px-2" style={payPeriod !== 'weekly' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}>Weekly</Button>
                  <Button size="sm" variant={payPeriod === 'biweekly' ? 'default' : 'outline'} onClick={() => onPayPeriodChange('biweekly')} className="text-xs h-7 px-2" style={payPeriod !== 'biweekly' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}>Bi-Weekly</Button>
                  <Button size="sm" variant={payPeriod === 'semimonthly' ? 'default' : 'outline'} onClick={() => onPayPeriodChange('semimonthly')} className="text-xs h-7 px-2" style={payPeriod !== 'semimonthly' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}>Semi-Monthly</Button>
                  <Button size="sm" variant={payPeriod === 'monthly' ? 'default' : 'outline'} onClick={() => onPayPeriodChange('monthly')} className="text-xs h-7 px-2" style={payPeriod !== 'monthly' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}>Monthly</Button>
                </div>
              </div>
            </>
          )}
          
          {headerLayout === 'viewmode-paycycle' && (
            <>
              <div className="flex justify-center">
                <CardTitle className="flex items-center gap-2 text-base" style={{ color: 'var(--text-slate-900)' }}>
                  <Table className="w-5 h-5" />
                  {viewMode === 'deliveries' ? 'Deliveries' : 'Extra KM'} by Store
                  <button onClick={handleManualRefresh} disabled={isRefreshing} className="p-1 rounded-md hover:bg-slate-100 transition-colors disabled:opacity-50" title="Refresh data">
                    <RefreshCw className={`w-4 h-4 transition-colors ${isRefreshing ? 'animate-spin text-emerald-500' : 'text-slate-400 hover:text-slate-600'}`} />
                  </button>
                </CardTitle>
              </div>
              {isOwner && (
                <div className="flex items-center justify-center gap-3">
                  <div className="flex gap-1 flex-shrink-0">
                    <Button size="sm" variant={payPeriod === 'weekly' ? 'default' : 'outline'} onClick={() => onPayPeriodChange('weekly')} className="text-xs h-7 px-2" style={payPeriod !== 'weekly' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}>Weekly</Button>
                    <Button size="sm" variant={payPeriod === 'biweekly' ? 'default' : 'outline'} onClick={() => onPayPeriodChange('biweekly')} className="text-xs h-7 px-2" style={payPeriod !== 'biweekly' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}>Bi-Weekly</Button>
                    <Button size="sm" variant={payPeriod === 'semimonthly' ? 'default' : 'outline'} onClick={() => onPayPeriodChange('semimonthly')} className="text-xs h-7 px-2" style={payPeriod !== 'semimonthly' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}>Semi-Mo</Button>
                    <Button size="sm" variant={payPeriod === 'monthly' ? 'default' : 'outline'} onClick={() => onPayPeriodChange('monthly')} className="text-xs h-7 px-2" style={payPeriod !== 'monthly' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}>Monthly</Button>
                  </div>
                </div>
              )}
            </>
          )}
          
          {headerLayout === 'three' && (
            <>
              <div className="flex justify-center">
                <CardTitle className="flex items-center gap-2 text-base" style={{ color: 'var(--text-slate-900)' }}>
                  <Table className="w-5 h-5" />
                  {viewMode === 'deliveries' ? 'Deliveries' : 'Extra KM'} by Store
                  <button onClick={handleManualRefresh} disabled={isRefreshing} className="p-1 rounded-md hover:bg-slate-100 transition-colors disabled:opacity-50" title="Refresh data">
                    <RefreshCw className={`w-4 h-4 transition-colors ${isRefreshing ? 'animate-spin text-emerald-500' : 'text-slate-400 hover:text-slate-600'}`} />
                  </button>
                </CardTitle>
              </div>
              {isOwner && (
                <div className="flex justify-center">
                  <div className="flex gap-1 flex-shrink-0 flex-wrap justify-center">
                    <Button size="sm" variant={payPeriod === 'weekly' ? 'default' : 'outline'} onClick={() => onPayPeriodChange('weekly')} className="text-xs h-7 px-2" style={payPeriod !== 'weekly' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}>Weekly</Button>
                    <Button size="sm" variant={payPeriod === 'biweekly' ? 'default' : 'outline'} onClick={() => onPayPeriodChange('biweekly')} className="text-xs h-7 px-2" style={payPeriod !== 'biweekly' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}>Bi-Wkly</Button>
                    <Button size="sm" variant={payPeriod === 'semimonthly' ? 'default' : 'outline'} onClick={() => onPayPeriodChange('semimonthly')} className="text-xs h-7 px-2" style={payPeriod !== 'semimonthly' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}>Semi-Mo</Button>
                    <Button size="sm" variant={payPeriod === 'monthly' ? 'default' : 'outline'} onClick={() => onPayPeriodChange('monthly')} className="text-xs h-7 px-2" style={payPeriod !== 'monthly' ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}>Monthly</Button>
                  </div>
                </div>
              )}
            </>
          )}
          
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
            <div className="flex flex-col items-center gap-2">
              {/* Toggle button centered above period label */}
              <div className="flex gap-1 rounded-lg p-0.5 flex-shrink-0" style={{ background: 'var(--bg-slate-100)' }}>
                <Button size="sm" variant={viewMode === 'deliveries' ? 'default' : 'ghost'} onClick={() => setViewMode('deliveries')} className="text-xs h-6 px-2 gap-1">
                  <Package className="w-3 h-3" />Deliveries
                </Button>
                <Button size="sm" variant={viewMode === 'extraKm' ? 'default' : 'ghost'} onClick={() => setViewMode('extraKm')} className="text-xs h-6 px-2 gap-1">
                  <Ruler className="w-3 h-3" />Extra KM
                </Button>
              </div>
              {/* Period label below toggle */}
              <div className="text-center min-w-[200px]">
                <div className="font-semibold" style={{ color: 'var(--text-slate-900)' }}>{currentPeriod.label}</div>
                <div className="text-xs" style={{ color: 'var(--text-slate-500)' }}>{periodDateRange}</div>
              </div>
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
          <table className="w-full text-[11px]" style={{ lineHeight: '1.4' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-slate-200)', background: 'var(--bg-slate-50)' }}>
                <th className="text-center px-1 md:px-2 py-1 font-medium sticky left-0 z-10 border-r-2 border-slate-300 align-top" style={{ color: 'var(--text-slate-600)', background: 'var(--bg-slate-50)' }}>Day</th>
                {sortedStores.map((store) => (
                  <th
                   key={store.id}
                   className="text-center px-1 md:px-2 py-1 font-bold min-w-[28px] md:min-w-[40px] align-top"
                   style={{ color: getStoreColor(store) }}
                   title={store.name}
                  >
                    {store.abbreviation || store.name?.substring(0, 2)}
                  </th>
                ))}
                <th className="text-center px-1 md:px-2 py-1 font-bold border-l-2 border-purple-300 min-w-[36px] md:min-w-[50px] align-top" style={{ color: 'var(--text-slate-900)' }}>Tot</th>
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
                      className="text-center px-1 md:px-2 py-0.5 font-medium sticky left-0 z-10 border-r-2 border-slate-300 align-top"
                      style={{ color: 'var(--text-slate-600)', background: isWeekend ? 'var(--bg-slate-100)' : 'var(--bg-white)' }}
                    >
                      <div className="flex items-center justify-center gap-0.5">
                        <span>{dayNum}</span>
                        <button
                          onClick={() => handleNavigateToDashboard(dateObj)}
                          className="p-0.5 rounded hover:bg-slate-200 transition-colors opacity-50 hover:opacity-100"
                          title={`View ${format(dateObj, 'MMM d')} on Dashboard`}
                        >
                          <ExternalLink className="w-3 h-3" />
                        </button>
                      </div>
                    </td>
                    {sortedStores.map((store) => {
                      const value = viewMode === 'extraKm' 
                        ? (extraKmMap[dateKey]?.[store.id] || 0)
                        : (dataMap[dateKey]?.[store.id] || 0);
                      const oversizedCount = oversizedMap[dateKey]?.[store.id] || 0;
                      const displayValueMobile = viewMode === 'extraKm' 
                        ? (value > 0 ? value.toFixed(1) : '')
                        : (value > 0 ? value : '');
                      const displayValueDesktop = viewMode === 'extraKm' 
                        ? (value > 0 ? value.toFixed(2) : '')
                        : (value > 0 ? value : '');
                      const plusSigns = viewMode === 'deliveries' && oversizedCount > 0 
                        ? '+'.repeat(oversizedCount) 
                        : '';
                      return (
                        <td
                           key={store.id}
                           className="text-center px-1 md:px-2 py-0.5 tabular-nums align-top"
                           style={{ color: value > 0 ? getStoreColor(store) : 'var(--text-slate-400)' }}
                         >
                          <span className="md:hidden">{displayValueMobile}{plusSigns}</span>
                          <span className="hidden md:inline">{displayValueDesktop}{plusSigns}</span>
                        </td>
                      );
                    })}
                    <td className="text-center px-1 md:px-2 py-0.5 font-semibold border-l-2 border-purple-300 tabular-nums align-top" style={{ color: 'var(--text-slate-900)' }}>
                      <span className="md:hidden">{viewMode === 'extraKm' ? (dayTotal > 0 ? dayTotal.toFixed(1) : '') : (dayTotal > 0 ? dayTotal : '')}</span>
                      <span className="hidden md:inline">{viewMode === 'extraKm' ? (dayTotal > 0 ? dayTotal.toFixed(2) : '') : (dayTotal > 0 ? dayTotal : '')}</span>
                    </td>
                  </tr>
                );
              })}
              {/* Totals Row */}
              <tr className="font-semibold" style={{ borderTop: '2px solid var(--border-slate-300)', background: 'var(--bg-slate-100)' }}>
                <td className="text-center px-1 md:px-2 py-1 sticky left-0 z-10 border-r-2 border-slate-300 align-top" style={{ color: 'var(--text-slate-700)', background: 'var(--bg-slate-100)' }}>Tot</td>
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
              {/* Average Per Active Day Row */}
              <tr className="font-medium" style={{ background: 'var(--bg-slate-50)' }}>
                <td className="text-center px-1 md:px-2 py-1 sticky left-0 z-10 border-r-2 border-slate-300" style={{ color: 'var(--text-slate-700)', background: 'var(--bg-slate-50)' }}>AVG</td>
                {sortedStores.map((store) => {
                  const storeTotal = viewMode === 'extraKm' ? storeKmTotals[store.id] : storeTotals[store.id];
                  const activeDays = periodDays.filter(day => {
                    const dateKey = format(day, 'yyyy-MM-dd');
                    const dayValue = viewMode === 'extraKm' ? (extraKmMap[dateKey]?.[store.id] || 0) : (dataMap[dateKey]?.[store.id] || 0);
                    return dayValue > 0;
                  }).length;
                  const average = activeDays > 0 ? storeTotal / activeDays : 0;
                  const displayValueMobile = viewMode === 'extraKm' 
                    ? (average > 0 ? average.toFixed(1) : '')
                    : (average > 0 ? average.toFixed(1) : '');
                  const displayValueDesktop = viewMode === 'extraKm' 
                    ? (average > 0 ? average.toFixed(2) : '')
                    : (average > 0 ? average.toFixed(2) : '');
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
                <td className="text-center px-1 md:px-2 py-1 font-semibold border-l-2 border-purple-300 tabular-nums align-top" style={{ color: 'var(--text-slate-900)' }}>
                  {(() => {
                    const activeDays = periodDays.filter(day => {
                      const dateKey = format(day, 'yyyy-MM-dd');
                      return getDayTotal(dateKey) > 0;
                    }).length;
                    const average = activeDays > 0 ? grandTotal / activeDays : 0;
                    return (
                      <>
                        <span className="md:hidden">{viewMode === 'extraKm' ? (average > 0 ? average.toFixed(1) : '') : (average > 0 ? average.toFixed(1) : '')}</span>
                        <span className="hidden md:inline">{viewMode === 'extraKm' ? (average > 0 ? average.toFixed(2) : '') : (average > 0 ? average.toFixed(2) : '')}</span>
                      </>
                    );
                  })()}
                </td>
              </tr>
              {/* Projected Total Row */}
              <tr className="font-medium" style={{ background: 'var(--bg-slate-50)' }}>
                <td className="text-center px-1 md:px-2 py-1 sticky left-0 z-10 border-r-2 border-slate-300" style={{ color: 'var(--text-slate-700)', background: 'var(--bg-slate-50)' }}>Proj</td>
                {sortedStores.map((store) => {
                  const storeTotal = viewMode === 'extraKm' ? storeKmTotals[store.id] : storeTotals[store.id];
                  const activeDays = periodDays.filter(day => {
                    const dateKey = format(day, 'yyyy-MM-dd');
                    const dayValue = viewMode === 'extraKm' ? (extraKmMap[dateKey]?.[store.id] || 0) : (dataMap[dateKey]?.[store.id] || 0);
                    return dayValue > 0;
                  }).length;
                  const average = activeDays > 0 ? storeTotal / activeDays : 0;
                  
                  // Calculate remaining days
                  const today = new Date();
                  today.setHours(0, 0, 0, 0);
                  const remainingDays = periodDays.filter(day => day > today).length;
                  
                  // If no remaining days, show actual total; otherwise project based on remaining days
                  const projected = remainingDays === 0 ? storeTotal : storeTotal + (average * remainingDays);
                  
                  const displayValueMobile = viewMode === 'extraKm' 
                    ? (projected > 0 ? projected.toFixed(1) : '')
                    : (projected > 0 ? Math.round(projected) : '');
                  const displayValueDesktop = viewMode === 'extraKm' 
                    ? (projected > 0 ? projected.toFixed(2) : '')
                    : (projected > 0 ? Math.round(projected) : '');
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
                <td className="text-center px-1 md:px-2 py-1 font-semibold border-l-2 border-purple-300 tabular-nums align-top" style={{ color: 'var(--text-slate-900)' }}>
                  {(() => {
                    const activeDays = periodDays.filter(day => {
                      const dateKey = format(day, 'yyyy-MM-dd');
                      return getDayTotal(dateKey) > 0;
                    }).length;
                    const average = activeDays > 0 ? grandTotal / activeDays : 0;
                    
                    // Calculate remaining days
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    const remainingDays = periodDays.filter(day => day > today).length;
                    
                    // If no remaining days, show actual total; otherwise project based on remaining days
                    const projected = remainingDays === 0 ? grandTotal : grandTotal + (average * remainingDays);
                    
                    return (
                      <>
                        <span className="md:hidden">{viewMode === 'extraKm' ? (projected > 0 ? projected.toFixed(1) : '') : (projected > 0 ? Math.round(projected) : '')}</span>
                        <span className="hidden md:inline">{viewMode === 'extraKm' ? (projected > 0 ? projected.toFixed(2) : '') : (projected > 0 ? Math.round(projected) : '')}</span>
                      </>
                    );
                  })()}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}