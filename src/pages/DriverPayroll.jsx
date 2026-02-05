import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { DollarSign, ChevronLeft, ChevronRight, Share2, Loader2, Download, RefreshCw } from "lucide-react";
import { sortUsers, sortStores } from '../components/utils/sorting';
import { useUser } from '../components/utils/UserContext';
import { useAppData } from '../components/utils/AppDataContext';
import { getDriverDisplayName } from '../components/utils/driverUtils';
import { userHasRole } from '../components/utils/userRoles';
import { base44 } from '@/api/base44Client';
import DriverPayrollGrid from '../components/payroll/DriverPayrollGrid';
import PayrollSummaryCard from '../components/payroll/PayrollSummaryCard';
import { smartRefreshManager } from '../components/utils/smartRefreshManager';
import { invalidate } from '../components/utils/dataManager';
import { toast } from 'sonner';
import ScreenshotShareModal from '../components/common/ScreenshotShareModal';
import html2canvas from 'html2canvas';

// Helper: Get first Monday of a given year
const getFirstMondayOfYear = (year) => {
  const jan1 = new Date(year, 0, 1);
  const dayOfWeek = jan1.getDay();
  const daysUntilMonday = dayOfWeek === 0 ? 1 : (dayOfWeek === 1 ? 0 : 8 - dayOfWeek);
  return new Date(year, 0, 1 + daysUntilMonday);
};

// Helper: Calculate all pay periods for a given year and pay period type
const calculateAllPeriods = (year, payPeriodType) => {
  const periods = [];
  
  switch (payPeriodType) {
    case 'weekly': {
      const firstMonday = getFirstMondayOfYear(year);
      // Add prior year period if Jan 1 is before first Monday
      const jan1 = new Date(year, 0, 1);
      if (jan1 < firstMonday) {
        periods.push({
          year,
          start: jan1,
          end: new Date(firstMonday.getTime() - 86400000), // day before first Monday
          label: `Prior Year Period`,
          isPriorYear: true
        });
      }
      // Generate weekly periods
      let weekStart = new Date(firstMonday);
      let weekNum = 1;
      const yearEnd = new Date(year, 11, 31);
      while (weekStart <= yearEnd) {
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);
        periods.push({
          year,
          start: new Date(weekStart),
          end: weekEnd > yearEnd ? yearEnd : weekEnd,
          label: `Week ${weekNum}`,
          weekNum
        });
        weekNum++;
        weekStart.setDate(weekStart.getDate() + 7);
      }
      break;
    }
    case 'biweekly': {
      const firstMonday = getFirstMondayOfYear(year);
      const jan1 = new Date(year, 0, 1);
      if (jan1 < firstMonday) {
        periods.push({
          year,
          start: jan1,
          end: new Date(firstMonday.getTime() - 86400000),
          label: `Prior Year Period`,
          isPriorYear: true
        });
      }
      let biweekStart = new Date(firstMonday);
      let periodNum = 1;
      const yearEnd = new Date(year, 11, 31);
      while (biweekStart <= yearEnd) {
        const biweekEnd = new Date(biweekStart);
        biweekEnd.setDate(biweekStart.getDate() + 13);
        periods.push({
          year,
          start: new Date(biweekStart),
          end: biweekEnd > yearEnd ? yearEnd : biweekEnd,
          label: `Period ${periodNum}`,
          periodNum
        });
        periodNum++;
        biweekStart.setDate(biweekStart.getDate() + 14);
      }
      break;
    }
    case 'semimonthly': {
      for (let month = 0; month < 12; month++) {
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        periods.push({
          year,
          start: new Date(year, month, 1),
          end: new Date(year, month, 15),
          label: `${new Date(year, month, 1).toLocaleString('default', { month: 'short' })} 1-15`,
          month: month + 1,
          half: 1
        });
        periods.push({
          year,
          start: new Date(year, month, 16),
          end: new Date(year, month, daysInMonth),
          label: `${new Date(year, month, 1).toLocaleString('default', { month: 'short' })} 16-${daysInMonth}`,
          month: month + 1,
          half: 2
        });
      }
      break;
    }
    case 'monthly':
    default: {
      for (let month = 0; month < 12; month++) {
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        periods.push({
          year,
          start: new Date(year, month, 1),
          end: new Date(year, month, daysInMonth),
          label: new Date(year, month, 1).toLocaleString('default', { month: 'long' }),
          month: month + 1
        });
      }
      break;
    }
  }
  return periods;
};

// Helper: Find current period index based on today's date
const findCurrentPeriodIndex = (periods, today) => {
  for (let i = 0; i < periods.length; i++) {
    if (today >= periods[i].start && today <= periods[i].end) {
      return i;
    }
  }
  // If not found, return closest past period
  for (let i = periods.length - 1; i >= 0; i--) {
    if (today > periods[i].end) return i;
  }
  return 0;
};

export default function DriverPayroll() {
  // CRITICAL: ALL hooks must be at the top, before any conditional logic
  const { currentUser } = useUser();
  const { smartRefreshActivity, setSmartRefreshActivity } = useAppData();
  
  const [selectedYear, setSelectedYear] = useState(() => new Date().getFullYear());
  const [selectedCityId, setSelectedCityId] = useState('all');
  const [selectedDriverId, setSelectedDriverId] = useState('all');
  const [payPeriod, setPayPeriod] = useState('monthly');
  const [selectedPeriodIndex, setSelectedPeriodIndex] = useState(0);
  const [hasInitialized, setHasInitialized] = useState(false);
  const [payrollData, setPayrollData] = useState(null);
  const [isLoadingPayroll, setIsLoadingPayroll] = useState(true);
  const [payrollRecords, setPayrollRecords] = useState([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isCapturingScreenshot, setIsCapturingScreenshot] = useState(false);
  const [screenshotDataUrl, setScreenshotDataUrl] = useState(null);
  const [showScreenshotModal, setShowScreenshotModal] = useState(false);
  
  const contentRef = useRef(null);
  const isManualChangeRef = useRef(false);
  const hasLoadedInitialDataRef = useRef(false);
  const triedPreviousPeriodRef = useRef(false);

  // Define isDriver early (after refs, before useMemo/useCallback that might use it)
  const isDriver = currentUser && userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin');

  const years = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return [currentYear, currentYear - 1, currentYear - 2];
  }, []);

  const allPeriods = useMemo(() => {
    return calculateAllPeriods(selectedYear, payPeriod);
  }, [selectedYear, payPeriod]);

  const currentPeriod = useMemo(() => allPeriods[selectedPeriodIndex] || allPeriods[0], [allPeriods, selectedPeriodIndex]);

  const sortedCities = useMemo(() => {
    if (!payrollData?.cities) return [];
    return [...payrollData.cities].sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
  }, [payrollData?.cities]);

  const filteredStores = useMemo(() => {
    if (!payrollData?.stores) return [];
    let filtered = payrollData.stores.filter(s => s.status !== 'inactive');
    if (selectedCityId && selectedCityId !== 'all') {
      filtered = filtered.filter(s => s.city_id === selectedCityId);
    }
    return sortStores(filtered);
  }, [payrollData?.stores, selectedCityId]);

  const sortedDrivers = useMemo(() => {
    if (!payrollData?.drivers) return [];
    return sortUsers(payrollData.drivers.filter(d => d && d.status === 'active'));
  }, [payrollData?.drivers]);

  const availablePayCycles = useMemo(() => {
    if (!payrollData?.appUsers) return [];
    const cycles = new Set();
    payrollData.appUsers.forEach(au => {
      if (au.pay_cycle_type && au.status === 'active') {
        cycles.add(au.pay_cycle_type);
      }
    });
    const order = ['weekly', 'biweekly', 'semimonthly', 'monthly'];
    return order.filter(c => cycles.has(c));
  }, [payrollData?.appUsers]);

  const driversInPayCycle = useMemo(() => {
    if (!payrollData?.appUsers || !payrollData?.drivers || !payrollData?.deliveries) return [];

    // Get driver IDs that have the selected pay cycle type AND have actual deliveries in that cycle
    const driverIdsInCycle = new Set();

    payrollData.appUsers.forEach(au => {
      if (au.pay_cycle_type === payPeriod && au.status === 'active') {
        // Only add if this driver has deliveries
        const hasDeliveries = payrollData.deliveries.some(d => d.driver_id === au.user_id);
        if (hasDeliveries) {
          driverIdsInCycle.add(au.user_id);
        }
      }
    });

    // CRITICAL: Always include the currently selected driver to prevent dropdown mismatch during transitions
    if (selectedDriverId !== 'all') {
      driverIdsInCycle.add(selectedDriverId);
    }

    return sortUsers(
      payrollData.drivers.filter(d => {
        if (!d || d.status !== 'active') return false;
        const driverId = d.user_id || d.id;
        return driverIdsInCycle.has(driverId);
      })
    );
  }, [payrollData?.appUsers, payrollData?.drivers, payrollData?.deliveries, payPeriod, selectedDriverId]);

  const cityFilteredDeliveries = useMemo(() => {
    if (!payrollData?.deliveries) return [];
    let filtered = payrollData.deliveries;
    if (selectedCityId !== 'all') {
      const cityStoreIds = new Set(filteredStores.map(s => s.id));
      filtered = filtered.filter(d => d && cityStoreIds.has(d.store_id));
    }
    return filtered;
  }, [payrollData?.deliveries, selectedCityId, filteredStores]);

  const handlePayPeriodChange = useCallback((newPayPeriod) => {
    isManualChangeRef.current = true;
    
    // Batch all state updates together in a single synchronous block
    React.startTransition(() => {
      setPayPeriod(newPayPeriod);
      
      // Reset selected driver to 'all' to force refresh with new pay cycle filter
      if (selectedDriverId !== 'all') {
        setSelectedDriverId('all');
      }
      
      setPayrollData(prev => {
        if (selectedDriverId && selectedDriverId !== 'all' && prev?.appUsers) {
          const driverAppUser = prev.appUsers.find(au => au.user_id === selectedDriverId);
          if (driverAppUser) {
            base44.entities.AppUser.update(driverAppUser.id, {
              pay_cycle_type: newPayPeriod
            }).catch(error => console.error('Failed to save pay cycle type:', error));
            return {
              ...prev,
              appUsers: prev.appUsers.map(au => au.id === driverAppUser.id ? { ...au, pay_cycle_type: newPayPeriod } : au)
            };
          }
        }
        return prev;
      });
    });
    
    setTimeout(() => { isManualChangeRef.current = false; }, 200);
  }, [selectedDriverId]);

  const refreshPayrollRecords = useCallback(async () => {
    if (!currentPeriod) return;
    const yearStart = new Date(currentPeriod.start.getFullYear(), 0, 1).toISOString().split('T')[0];
    const periodEndStr = currentPeriod.end.toISOString().split('T')[0];
    console.log(`📥 [DriverPayroll] Fetching payroll records from ${yearStart} to ${periodEndStr}`);
    try {
      const records = await base44.entities.Payroll.filter({
        pay_period_end: { $gte: yearStart, $lte: periodEndStr }
      });
      console.log(`✅ [DriverPayroll] Found ${records?.length || 0} payroll records`);
      setPayrollRecords(records || []);
    } catch (error) {
      console.error('Failed to refresh payroll records:', error);
    }
  }, [currentPeriod]);

  // All useCallback hooks must be declared here, before useEffect
  const handleCaptureScreenshot = useCallback(async () => {
    setIsCapturingScreenshot(true);
    toast.info('Capturing screenshot...');

    try {
      if (!contentRef.current) {
        toast.error('Content not found');
        return;
      }

      // Store original theme class
      const htmlElement = document.documentElement;
      const originalThemeClass = htmlElement.className;

      // Force light mode temporarily
      htmlElement.classList.remove('dark-theme', 'auto-theme');
      htmlElement.classList.add('light-theme');

      // Hide all controls, buttons, toggles, and dropdowns
      const controlsElement = document.getElementById('payroll-controls');
      if (controlsElement) {
        controlsElement.style.display = 'none';
      }

      // Hide Select dropdowns and other UI controls
      const selectTriggers = contentRef.current.querySelectorAll('[class*="SelectTrigger"]');
      selectTriggers.forEach(el => {
        el.style.display = 'none';
      });

      // Hide any buttons within the content
      const buttons = contentRef.current.querySelectorAll('button');
      buttons.forEach(el => {
        el.style.display = 'none';
      });

      // Hide App Fee % rows
      const appFeeRows = document.querySelectorAll('[data-app-fee-row="true"]');
      appFeeRows.forEach(row => {
        row.style.display = 'none';
      });

      // Small delay to ensure UI updates
      await new Promise(resolve => setTimeout(resolve, 100));

      // Capture with html2canvas using better settings for clean output
      const canvas = await html2canvas(contentRef.current, {
        backgroundColor: '#f8fafc',
        scale: 2,
        useCORS: true,
        logging: false,
        imageTimeout: 0,
        allowTaint: true
      });

      // Restore original theme
      htmlElement.className = originalThemeClass;

      // Show all controls again
      if (controlsElement) {
        controlsElement.style.display = 'flex';
      }

      selectTriggers.forEach(el => {
        el.style.display = '';
      });

      buttons.forEach(el => {
        el.style.display = '';
      });

      // Show App Fee % rows again
      appFeeRows.forEach(row => {
        row.style.display = '';
      });

      const dataUrl = canvas.toDataURL('image/png');
      setScreenshotDataUrl(dataUrl);
      setShowScreenshotModal(true);
      toast.success('Screenshot captured!');
    } catch (error) {
      console.error('Screenshot error:', error);
      toast.error('Failed to capture screenshot');
      
      // Restore original state on error
      const htmlElement = document.documentElement;
      htmlElement.className = htmlElement.className.replace('light-theme', '').trim();
      const controlsElement = document.getElementById('payroll-controls');
      if (controlsElement) {
        controlsElement.style.display = 'flex';
      }
    } finally {
      setIsCapturingScreenshot(false);
    }
  }, []);

  const handleManualRefresh = useCallback(async () => {
    setIsRefreshing(true);
    console.log('🔄 [DriverPayroll] Manual refresh triggered');
    
    // Invalidate caches
    invalidate('Delivery');
    invalidate('Patient');
    invalidate('Payroll');
    
    // Force fresh fetch of all data
    await fetchPayroll(false, true);
    
    // Refresh payroll records to recalculate YTD totals
    await refreshPayrollRecords();
    
    setIsRefreshing(false);
    toast.success('Payroll data refreshed');
  }, [selectedYear, selectedCityId, refreshPayrollRecords]);

  const fetchPayroll = useCallback(async (isAutoRefresh = false, forceFresh = false) => {
    if (!currentUser) return;
    if (!isAutoRefresh) setIsLoadingPayroll(true);

    // Show refresh spinner during fetch
    if (isAutoRefresh && setSmartRefreshActivity) {
      setSmartRefreshActivity({ active: true, updatedEntities: ['Payroll', 'Delivery'] });
    }

    try {
      // CRITICAL: Load Cities and AppUsers from offline DB to reduce API rate limit hits
      // Offline DB is regularly refreshed, so data is always fresh
      console.log('📥 [DriverPayroll] Loading Cities and AppUsers from offline DB...');
      const { offlineDB } = await import('../components/utils/offlineDatabase');
      const [freshCities, freshAppUsers] = await Promise.all([
        offlineDB.getAll(offlineDB.STORES.CITIES),
        offlineDB.getAll(offlineDB.STORES.APP_USERS)
      ]);
      console.log(`✅ [DriverPayroll] Loaded ${freshCities?.length || 0} cities, ${freshAppUsers?.length || 0} appUsers from offline DB`);

      // CRITICAL: Invalidate caches before fetching to ensure fresh data
      if (forceFresh) {
        console.log('🔄 [DriverPayroll] Invalidating caches before fetch');
        invalidate('Delivery');
        invalidate('Patient');
        invalidate('Payroll');
      }

      console.log(`📥 [DriverPayroll] Fetching payroll data - Year: ${selectedYear}, City: ${selectedCityId}, Force: ${forceFresh}`);
      const response = await base44.functions.invoke('getAdminMetricsAndPayrollData', {
        payrollYear: selectedYear,
        payrollCityId: selectedCityId === 'all' ? null : selectedCityId,
        payrollDriverId: null // Always fetch all drivers, filter locally
      });
      const data = response?.data?.payrollData || response?.payrollData;
      
      // CRITICAL: Backend data is the source of truth for payroll page
      // Use offline DB ONLY if backend data is missing, as a fallback
      const mergedData = {
        ...data,
        // Prefer backend data; only fallback to offline DB if backend has no data
        cities: (data?.cities && data.cities.length > 0) ? data.cities : (freshCities && freshCities.length > 0 ? freshCities : []),
        appUsers: (data?.appUsers && data.appUsers.length > 0) ? data.appUsers : (freshAppUsers && freshAppUsers.length > 0 ? freshAppUsers : []),
        drivers: data?.drivers || []  // Backend provides filtered drivers; keep as-is
      };
      
      console.log(`✅ [DriverPayroll] Merged payroll data:`, {
        deliveries: mergedData?.deliveries?.length || 0,
        drivers: mergedData?.drivers?.length || 0,
        stores: mergedData?.stores?.length || 0,
        appUsers: mergedData?.appUsers?.length || 0,
        patients: mergedData?.patients?.length || 0,
        cities: mergedData?.cities?.length || 0
      });
      
      // CRITICAL: Validate merged data has required fields before state update
      if (!mergedData.drivers || mergedData.drivers.length === 0) {
        console.error('❌ [DriverPayroll] CRITICAL: No drivers in merged data!');
      }
      if (!mergedData.cities || mergedData.cities.length === 0) {
        console.error('❌ [DriverPayroll] CRITICAL: No cities in merged data!');
      }
      
      setPayrollData(mergedData);
    } catch (error) {
      console.error('Failed to fetch payroll data:', error);
      toast.error('Failed to refresh payroll data');
    } finally {
      if (!isAutoRefresh) setIsLoadingPayroll(false);
      // Hide refresh spinner after fetch
      if (isAutoRefresh && setSmartRefreshActivity) {
        setSmartRefreshActivity({ active: false, updatedEntities: [] });
      }
    }
  }, [selectedYear, selectedCityId, currentUser, setSmartRefreshActivity]);

  // Navigation handlers - must be useCallback
  const goToPrevPeriod = useCallback(() => {
    if (selectedPeriodIndex > 0) {
      setSelectedPeriodIndex(selectedPeriodIndex - 1);
    }
  }, [selectedPeriodIndex]);

  const goToNextPeriod = useCallback(() => {
    if (selectedPeriodIndex < allPeriods.length - 1) {
      setSelectedPeriodIndex(selectedPeriodIndex + 1);
    }
  }, [selectedPeriodIndex, allPeriods.length]);

  // Trigger fetch when filters change (after initialization)
  useEffect(() => {
    if (hasInitialized) {
      fetchPayroll(false, false);
    }
  }, [selectedYear, selectedCityId, hasInitialized, fetchPayroll]);

  // Initialize defaults based on user role - runs ONCE on mount
  useEffect(() => {
    if (!currentUser || hasInitialized) return;

    if (currentUser.city_id && !isDriver) {
      setSelectedCityId(currentUser.city_id);
    }

    if (isDriver) {
      setSelectedDriverId(currentUser.id);
      setPayPeriod('monthly');
    } else {
      setSelectedDriverId('all');
      setPayPeriod('semimonthly');
    }
    setHasInitialized(true);
  }, [currentUser, isDriver, hasInitialized]);

  // Load driver's pay cycle ONCE when data first loads
  useEffect(() => {
    if (!payrollData?.appUsers || hasLoadedInitialDataRef.current || isManualChangeRef.current) return;
    if (selectedDriverId === 'all') return;
    
    const driverAppUser = payrollData.appUsers.find(au => au.user_id === selectedDriverId);
    if (driverAppUser?.pay_cycle_type) {
      setPayPeriod(driverAppUser.pay_cycle_type);
    }
    hasLoadedInitialDataRef.current = true;
  }, [payrollData?.appUsers, selectedDriverId]);

  // Reset period index when pay period or year changes - ONLY on initial load
  const initialPeriodSetRef = useRef(false);
  
  useEffect(() => {
    if (!hasInitialized) return;
    
    // CRITICAL: Only auto-select period on INITIAL load or when pay period/year changes
    // Do NOT override user's manual period navigation
    const shouldAutoSelect = !initialPeriodSetRef.current || isManualChangeRef.current;
    if (!shouldAutoSelect) return;
    
    // Invalidate caches to force fresh calculations
    invalidate('Payroll');
    invalidate('Delivery');
    
    const today = new Date();
    
    // CRITICAL: Check if any past payroll has been finalized
    const hasFinalizedPayroll = payrollRecords.some(r => 
      r.status === 'driver_finalized' || 
      r.status === 'admin_finalized' || 
      r.status === 'paid'
    );
    
    if (hasFinalizedPayroll) {
      // If past payroll finalized, load current pay cycle (existing behavior)
      if (selectedYear === today.getFullYear()) {
        const idx = findCurrentPeriodIndex(allPeriods, today);
        setSelectedPeriodIndex(idx);
      } else {
        setSelectedPeriodIndex(allPeriods.length - 1);
      }
    } else {
      // Otherwise, load most recent unfinalized period
      // Find the most recent period that has payroll records in draft status
      let mostRecentUnfinalizedIdx = -1;
      
      for (let i = allPeriods.length - 1; i >= 0; i--) {
        const period = allPeriods[i];
        const periodStartStr = period.start.toISOString().split('T')[0];
        const periodEndStr = period.end.toISOString().split('T')[0];
        
        // Check if this period has any draft records
        const hasDraftRecords = payrollRecords.some(r =>
          r.pay_period_start === periodStartStr &&
          r.pay_period_end === periodEndStr &&
          r.status === 'draft'
        );
        
        if (hasDraftRecords) {
          mostRecentUnfinalizedIdx = i;
          break;
        }
      }
      
      // If found unfinalized period, use it; otherwise use current period
      if (mostRecentUnfinalizedIdx >= 0) {
        setSelectedPeriodIndex(mostRecentUnfinalizedIdx);
      } else if (selectedYear === today.getFullYear()) {
        const idx = findCurrentPeriodIndex(allPeriods, today);
        setSelectedPeriodIndex(idx);
      } else {
        setSelectedPeriodIndex(allPeriods.length - 1);
      }
    }
    
    // Mark that initial period has been set
    initialPeriodSetRef.current = true;
  }, [payPeriod, selectedYear, allPeriods, hasInitialized, payrollRecords]);

  // Load payroll records when period changes (initial load and period navigation)
  useEffect(() => {
    if (!currentPeriod || !hasInitialized) return;
    console.log(`🔄 [DriverPayroll] Period changed, loading payroll records...`);
    
    // Invalidate caches to force fresh fetch
    invalidate('Payroll');
    invalidate('Delivery');
    
    refreshPayrollRecords();
  }, [currentPeriod, hasInitialized, refreshPayrollRecords]);

  // Auto-select previous period if current has no data
  useEffect(() => {
    if (!hasInitialized || payrollRecords.length > 0) return;
    if (selectedPeriodIndex === 0) return; // Can't go back further
    if (triedPreviousPeriodRef.current) return; // Already tried going back
    
    console.log(`⚠️ [DriverPayroll] No payroll data for current period, switching to previous...`);
    triedPreviousPeriodRef.current = true;
    setSelectedPeriodIndex(selectedPeriodIndex - 1);
  }, [payrollRecords, hasInitialized, selectedPeriodIndex]);

  // Reset the flag when period is manually changed
  useEffect(() => {
    triedPreviousPeriodRef.current = false;
  }, [selectedYear, payPeriod]);

  // Conditional rendering without early return to maintain hook order
  return !currentUser ? (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-slate-50)' }}>
      <span className="text-lg text-slate-600">Please log in to view payroll</span>
    </div>
  ) : isLoadingPayroll ? (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-slate-50)' }}>
      <div className="animate-spin w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full"></div>
      <span className="ml-3 text-lg text-slate-600">Loading payroll data...</span>
    </div>
  ) : (
    <div className="p-4 md:p-6" style={{ background: 'var(--bg-slate-50)' }}>
      <div className="max-w-7xl mx-auto" ref={contentRef}>
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <DollarSign className="w-8 h-8 text-emerald-600" />
            <h1 className="text-2xl font-bold" style={{ color: 'var(--text-slate-900)' }}>Driver Payroll</h1>
          </div>
          
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2 justify-between w-full md:w-auto">
            {/* City, Year, Driver Dropdowns */}
            <div className="flex items-center gap-2">
              {/* City Filter */}
              <Select value={selectedCityId} onValueChange={(v) => {
                React.startTransition(() => {
                  setSelectedCityId(v);
                });
              }} disabled={isDriver}>
                <SelectTrigger className="w-[105px] md:w-[130px]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                  <SelectValue placeholder="City" />
                </SelectTrigger>
                <SelectContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                  <SelectItem value="all" style={{ color: 'var(--text-slate-900)' }}>All Cities</SelectItem>
                  {sortedCities.map(city => (
                    <SelectItem key={city.id} value={city.id} style={{ color: 'var(--text-slate-900)' }}>
                      {city.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Year Filter */}
              <Select value={String(selectedYear)} onValueChange={(v) => {
                React.startTransition(() => {
                  setSelectedYear(Number(v));
                });
              }}>
                <SelectTrigger className="w-[105px] md:w-[130px]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                  {years.map(year => (
                    <SelectItem key={year} value={String(year)} style={{ color: 'var(--text-slate-900)' }}>
                      {year}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Driver Filter - filtered by pay cycle type */}
              <Select value={selectedDriverId} onValueChange={(v) => { 
                isManualChangeRef.current = true;
                
                // Batch all state updates in a single transition
                React.startTransition(() => {
                  setSelectedDriverId(v);
                  if (v === 'all') {
                    setPayPeriod('semimonthly');
                  } else {
                    const driverAppUser = payrollData?.appUsers?.find(au => au.user_id === v);
                    if (driverAppUser?.pay_cycle_type) {
                      setPayPeriod(driverAppUser.pay_cycle_type);
                    }
                  }
                });
                
                setTimeout(() => { isManualChangeRef.current = false; }, 200); 
              }} disabled={isDriver}>
                <SelectTrigger className="w-[105px] md:w-[130px]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                  <SelectValue placeholder="Driver" />
                </SelectTrigger>
                <SelectContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                  <SelectItem value="all" style={{ color: 'var(--text-slate-900)' }}>All Drivers ({driversInPayCycle.length})</SelectItem>
                  {driversInPayCycle.map(driver => (
                    <SelectItem key={driver.user_id} value={driver.user_id} style={{ color: 'var(--text-slate-900)' }}>
                      {getDriverDisplayName(driver)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Icon Buttons - Far Right */}
            <div id="payroll-controls" className="flex items-center gap-1">
              <Button
                onClick={handleManualRefresh}
                disabled={isRefreshing || isLoadingPayroll}
                size="sm"
                variant="ghost"
                className="p-2 h-auto"
                title="Refresh payroll data"
                style={{ color: 'var(--text-slate-900)' }}
              >
                <RefreshCw className={`w-5 h-5 ${isRefreshing ? 'animate-spin' : ''}`} />
              </Button>
              <Button
                onClick={handleCaptureScreenshot}
                disabled={isCapturingScreenshot}
                size="sm"
                variant="ghost"
                className="p-2 h-auto"
                title="Capture and share screenshot"
                style={{ color: 'var(--text-slate-900)' }}
              >
                {isCapturingScreenshot ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Share2 className="w-5 h-5" />
                )}
              </Button>
            </div>
          </div>
        </div>

        {/* Content Area for Screenshot */}
        <div>
          {/* Grid */}
          <DriverPayrollGrid
            deliveries={cityFilteredDeliveries}
            stores={filteredStores}
            patients={payrollData?.patients || []}
            appUsers={payrollData?.appUsers || []}
            selectedYear={selectedYear}
            selectedDriverId={selectedDriverId}
            payPeriod={payPeriod}
            onPayPeriodChange={handlePayPeriodChange}
            currentPeriod={currentPeriod}
            allPeriods={allPeriods}
            selectedPeriodIndex={selectedPeriodIndex}
            onPrevPeriod={goToPrevPeriod}
            onNextPeriod={goToNextPeriod}
          />

          {/* Payroll Summary */}
          <PayrollSummaryCard
            deliveries={cityFilteredDeliveries}
            drivers={sortedDrivers}
            appUsers={payrollData?.appUsers || []}
            patients={payrollData?.patients || []}
            cities={sortedCities}
            stores={filteredStores}
            selectedYear={selectedYear}
            selectedDriverId={selectedDriverId}
            selectedCityId={selectedCityId}
            payPeriod={payPeriod}
            currentPeriod={currentPeriod}
            onFinalizePayroll={(data) => {
              console.log('Payroll finalized:', data);
            }}
            onPayrollRecordsChange={(records) => {
              setPayrollRecords(records);
            }}
            payrollRecords={payrollRecords}
            refreshPayrollRecords={refreshPayrollRecords}
          />
        </div>
        
        {/* Screenshot Share Modal */}
        <ScreenshotShareModal
          isOpen={showScreenshotModal}
          onClose={() => setShowScreenshotModal(false)}
          imageDataUrl={screenshotDataUrl}
          filename={`driver-payroll-${selectedYear}.png`}
        />
      </div>
    </div>
  );
}